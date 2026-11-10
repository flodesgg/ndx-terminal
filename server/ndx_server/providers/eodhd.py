"""EODHD Free (API token): end-of-day closes for EU/Nordic listings (SPEC §6.2, decision D13).

Free plan facts (docs/PROVIDERS.md §3.19, checked 2026-11-09): 20 API calls per day, reset at
midnight GMT; one EOD request costs one call whatever its length (an unknown ticker's 404
too); one year of history; HTTP 402 once the day's calls are gone; `/api/user` reports the
day's count and costs nothing.

Budget (decision): at most 18 calls a day, one per symbol per session. Every close we
fetch goes to the bar store (EODHD allows local storage) and quotes are derived from it, so a
symbol costs one call per day however often a window asks for it. A symbol is fetched again
only once the next session's close should be published; past the day's budget the last stored
close is served (`CACHE`, ageing to `STALE`) or the value is `N.A.`.
"""

from __future__ import annotations

import asyncio
import calendar
import logging
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import TYPE_CHECKING, Any, ClassVar
from zoneinfo import ZoneInfo

import httpx

from ..markets import next_session_close, previous_session_close, session_close_on
from ..models import AssetClass, Bar, Instrument, Interval, Latency, Quote
from .base import (
    BarSeries,
    Capability,
    DataProvider,
    LocalRateLimited,
    NetworkError,
    NotFound,
    NotSupported,
    ProviderError,
    RateLimited,
    TransientError,
)
from .budgets import BUDGETS
from .http import check, make_client
from .quota import DailyQuota, utc_now
from .ratelimit import TokenBucket

if TYPE_CHECKING:
    from ..barstore import BarStore
    from ..secmaster import Exchange

log = logging.getLogger("ndx.providers.eodhd")

BASE = "https://eodhd.com/api"
EQ = frozenset({AssetClass.EQUITY, AssetClass.INDEX})

# EU/Nordic exchanges of the security master (data/symbology/exchanges.csv) this source covers
# by decision D13; US listings have their own sources (Finnhub, Tiingo, Massive).
EXCHANGES = frozenset({"DC", "SS", "NO", "FH", "GY", "LN", "FP", "NA", "SW"})
# LSE prices are quoted in pence on EODHD (as on most feeds); the currency is not stated per
# row, so it stays N.A. instead of a wrong "GBP".
NO_CURRENCY = frozenset({"LN"})

# Decision 2026-11-09 (P17): these index levels have first claim on
# the daily budget — a call stays reserved for each until it is fetched for the session; every
# other symbol (equities, other indices) uses what is left.
PRIORITY_INDICES = ("OMXC25", "DAX")

HISTORY_DAYS = 365  # Free plan: one year of EOD history
# Self-imposed: EODHD does not state when a close appears. On 2026-11-09 Novo B's close was
# still missing two hours after Copenhagen closed, so a session counts as published 4 h after
# its close; if a fetch after that still lacks it, try again 2 h later (budget permitting).
SETTLE = timedelta(hours=4)
RETRY = timedelta(hours=2)
NO_CALENDAR_TTL = timedelta(hours=6)


def _exchanges() -> dict[str, Exchange]:
    from ..secmaster import symbology

    return symbology().exchanges


def exchange_of(inst: Instrument) -> Exchange | None:
    """The EU/Nordic exchange of an equity's internal symbol (`NOVO-B.CO` -> DC), else None."""
    if inst.asset_class is not AssetClass.EQUITY or "." not in inst.symbol:
        return None
    suffix = "." + inst.symbol.rsplit(".", 1)[1]
    for ex in _exchanges().values():
        if ex.yahoo_suffix == suffix and ex.code in EXCHANGES:
            return ex
    return None


def eodhd_symbol(inst: Instrument, ex: Exchange) -> str:
    return inst.symbol.rsplit(".", 1)[0] + ex.eodhd_suffix


def index_code(inst: Instrument) -> str | None:
    """The index-table ID (`OMXC25`) of an index instrument (`^OMXC25`), else None."""
    if inst.asset_class is not AssetClass.INDEX:
        return None
    from ..secmaster import symbology

    for k, r in symbology().indices.items():
        if r.get("yahoo") == inst.symbol:
            return k
    return None


def venue(inst: Instrument) -> tuple[Exchange, str] | None:
    """(exchange whose sessions time the close, EODHD symbol) for a covered instrument: an
    EU/Nordic listing, or an index with a checked EODHD code (data/symbology/indices.csv)."""
    ex = exchange_of(inst)
    if ex is not None:
        return ex, eodhd_symbol(inst, ex)
    k = index_code(inst)
    if k is None:
        return None
    from ..secmaster import symbology

    sm = symbology()
    row = sm.indices[k]
    cal = sm.exchanges.get(row.get("calendar") or "")
    code = row.get("eodhd") or ""
    if not code or cal is None or cal.code not in EXCHANGES:
        return None
    return cal, code


def _day_t(d: date) -> int:
    """Daily bars: exchange-local date at 00:00 encoded as unix seconds (models.Bar)."""
    return calendar.timegm(d.timetuple())


def bar_date(b: Bar) -> date:
    return datetime.fromtimestamp(b.t, UTC).date()


def parse_eod(rows: Any, symbol: str, ex: Exchange, now: datetime) -> BarSeries:
    """EOD rows (`date, open, high, low, close, adjusted_close, volume`) -> daily bars. Prices
    are the unadjusted session values; a row without a close is skipped, never filled."""
    if not isinstance(rows, list):
        raise ProviderError(f"EODHD: unexpected EOD payload for {symbol}")
    bars: list[Bar] = []
    for r in rows:
        try:
            d = date.fromisoformat(str(r["date"]))
            c = r.get("close")
            if c is None:
                continue
            o, h, low = r.get("open"), r.get("high"), r.get("low")
            v = r.get("volume")
            bars.append(
                Bar(
                    t=_day_t(d),
                    o=float(o if o is not None else c),
                    h=float(h if h is not None else c),
                    l=float(low if low is not None else c),
                    c=float(c),
                    v=float(v) if v is not None else None,
                )
            )
        except (KeyError, TypeError, ValueError):
            continue
    if not bars:
        raise NotFound(f"EODHD has no end-of-day rows for {symbol} in the last year")
    bars.sort(key=lambda b: b.t)
    tz = ZoneInfo(ex.tz)
    offset = now.astimezone(tz).utcoffset()
    as_of = session_close_on(ex.mic, bar_date(bars[-1])) if ex.mic else None
    return BarSeries(
        bars=bars,
        tz=ex.tz,
        utc_offset_s=int(offset.total_seconds()) if offset else 0,
        as_of=as_of,
    )


def valid_until(ex: Exchange, fetched_at: datetime, last: date | None) -> datetime:
    """When a series fetched at `fetched_at` (newest bar dated `last`) is due for a refetch:
    once the next session's close should be published (close + SETTLE). If the newest close
    that should already have been published is missing, sooner (RETRY)."""
    if not ex.mic:
        return fetched_at + NO_CALENDAR_TTL
    nxt = next_session_close(ex.mic, fetched_at - SETTLE)
    if nxt is None:
        return fetched_at + NO_CALENDAR_TTL
    until = nxt + SETTLE
    prev = previous_session_close(ex.mic, fetched_at - SETTLE)
    if prev is not None and last is not None and last < prev.astimezone(ZoneInfo(ex.tz)).date():
        until = min(until, fetched_at + RETRY)
    return until


def quote_from_series(inst: Instrument, ex: Exchange, series: BarSeries) -> Quote:
    """The latest close as an end-of-day quote (tag EOD): change vs the previous close."""
    last = series.bars[-1]
    prev = series.bars[-2] if len(series.bars) > 1 else None
    change = last.c - prev.c if prev is not None else None
    pct = change / prev.c * 100 if change is not None and prev is not None and prev.c else None
    index = inst.asset_class is AssetClass.INDEX  # a level in points, not a price
    return Quote(
        symbol=inst.symbol,
        currency=None if index or ex.code in NO_CURRENCY else ex.currency,
        price=last.c,
        change=change,
        change_pct=pct,
        prev_close=prev.c if prev is not None else None,
        open=last.o,
        high=last.h,
        low=last.l,
        volume=last.v,
        ts=series.as_of,
    )


@dataclass
class Daily:
    series: BarSeries
    fetched_at: datetime


@dataclass
class Served:
    daily: Daily
    cached: bool
    note: str | None = None


class EodhdProvider(DataProvider):
    name: ClassVar[str] = "eodhd"
    label: ClassVar[str] = "EODHD"
    requires_key: ClassVar[bool] = True
    scarce: ClassVar[bool] = True  # 18 calls/day
    capabilities: ClassVar[dict[Capability, frozenset[AssetClass]]] = {
        Capability.QUOTE: EQ,
        Capability.BARS: EQ,
    }

    def __init__(
        self,
        api_key: str,
        data_dir: Path | None = None,
        client: httpx.AsyncClient | None = None,
        clock: Callable[[], datetime] = utc_now,
    ) -> None:
        # The router's bucket guards EODHD's own per-minute limit (1,000 requests/min); the
        # plan's daily allowance is the persisted `daily` counter, spent only on real calls.
        super().__init__(TokenBucket.per_minute(1000, 50), api_key)
        self.daily = DailyQuota(self.name, int(BUDGETS[self.name].limit), data_dir, clock)
        self.clock = clock
        self._client = client or make_client()
        self._store: BarStore | None = None
        self._mem: dict[str, Daily] = {}
        self._locks: dict[str, asyncio.Lock] = {}
        self._served: dict[str, Served] = {}
        self._synced: date | None = None

    # ----- wiring -----

    def attach_store(self, store: BarStore) -> None:
        self._store = store

    def latency(self, asset: AssetClass) -> tuple[Latency, int | None]:
        return Latency.EOD, None

    def serves(self, cap: Capability, inst: Instrument | None) -> bool:
        return inst is None or venue(inst) is not None

    def provider_symbol(self, inst: Instrument) -> str:
        v = venue(inst)
        return v[1] if v is not None else inst.symbol

    def quota_source(self) -> DailyQuota:
        return self.daily

    def daily_valid_until(
        self, inst: Instrument, fetched_at: datetime, series: BarSeries | None
    ) -> datetime | None:
        v = venue(inst)
        if v is None:
            return None
        ex = v[0]
        last = bar_date(series.bars[-1]) if series is not None and series.bars else None
        return valid_until(ex, fetched_at, last)

    def meta_overrides(self, inst: Instrument | None, value: Any) -> dict[str, Any]:
        served = self._served.get(inst.symbol) if inst is not None else None
        v = venue(inst) if inst is not None else None
        if served is None or v is None:
            return {}
        ex = v[0]
        d = served.daily
        last = bar_date(d.series.bars[-1]) if d.series.bars else None
        life = (valid_until(ex, d.fetched_at, last) - d.fetched_at).total_seconds()
        out: dict[str, Any] = {
            "fetched_at": d.fetched_at,
            "cached": served.cached,
            "stale_after_s": 2 * max(60.0, life),
        }
        if served.note:
            out["note"] = served.note
        return out

    # ----- HTTP -----

    async def _get(self, path: str, params: dict[str, str] | None = None) -> Any:
        query = {**(params or {}), "api_token": self.api_key, "fmt": "json"}
        try:
            resp = await self._client.get(f"{BASE}/{path}", params=query)
        except (httpx.ConnectError, httpx.ConnectTimeout) as exc:
            raise NetworkError(f"EODHD: {type(exc).__name__}") from exc
        except (httpx.TimeoutException, httpx.NetworkError, httpx.RemoteProtocolError) as exc:
            raise TransientError(f"EODHD: {type(exc).__name__}") from exc
        if resp.status_code == 402:  # the plan's calls for the day are gone
            self.daily.sync(self.daily.limit, self.daily.today())
            raise RateLimited("EODHD HTTP 402: daily API calls used up (resets 00:00 UTC)")
        check(resp, "EODHD")
        try:
            return resp.json()
        except ValueError as exc:
            raise ProviderError("EODHD: invalid JSON") from exc

    async def account(self) -> dict[str, Any]:
        """The day's call count as EODHD sees it (`/api/user`, free). Only the counters are
        kept: the endpoint also returns the account holder's name and email."""
        raw = await self._get("user")
        if not isinstance(raw, dict):
            raise ProviderError("EODHD: unexpected /user payload")
        try:
            day = date.fromisoformat(str(raw.get("apiRequestsDate")))
        except ValueError:
            day = None  # no call spent yet on this account
        used = int(raw.get("apiRequests") or 0)
        self.daily.sync(used, day)
        self._synced = self.daily.today()
        return {
            "used": used,
            "day": day.isoformat() if day else None,
            "daily_limit": raw.get("dailyRateLimit"),
        }

    async def _sync_once_a_day(self) -> None:
        if self._synced == self.daily.today():
            return
        self._synced = self.daily.today()
        try:
            await self.account()
        except ProviderError as exc:  # our own count still applies
            log.info("EODHD call count not synced: %s", exc)

    # ----- the daily store -----

    async def _from_store(self, symbol: str) -> Daily | None:
        if self._store is None:
            return None
        stored = await asyncio.to_thread(self._store.get, symbol, "1d")
        if stored is None or stored.source != self.label:
            return None
        return Daily(stored.series, stored.fetched_at)

    def _is_fresh(self, symbol: str, ex: Exchange, now: datetime) -> bool:
        d = self._mem.get(symbol)
        if d is None:
            return False
        last = bar_date(d.series.bars[-1]) if d.series.bars else None
        return valid_until(ex, d.fetched_at, last) > now

    def reserved(self, now: datetime) -> int:
        """Calls held back for priority indices not yet fetched for the current session."""
        from ..secmaster import symbology

        out = 0
        for k in PRIORITY_INDICES:
            row = symbology().indices.get(k)
            cal = symbology().exchanges.get((row or {}).get("calendar") or "")
            if row is None or cal is None or not self._is_fresh(row["yahoo"], cal, now):
                out += 1
        return out

    async def _daily(self, inst: Instrument) -> Served:
        v = venue(inst)
        if v is None:
            raise NotSupported(
                f"EODHD covers EU/Nordic listings and checked index codes only, not {inst.symbol}"
            )
        ex, code = v
        lock = self._locks.setdefault(inst.symbol, asyncio.Lock())
        async with lock:  # concurrent quote + bars requests share one call
            now = self.clock()
            d = self._mem.get(inst.symbol) or await self._from_store(inst.symbol)
            if d is not None:
                last = bar_date(d.series.bars[-1]) if d.series.bars else None
                if valid_until(ex, d.fetched_at, last) > now:
                    self._mem[inst.symbol] = d
                    return Served(d, cached=True)
            await self._sync_once_a_day()
            priority = index_code(inst) in PRIORITY_INDICES
            held = 0 if priority else self.reserved(now)
            if self.daily.left <= held or not self.daily.try_take():
                limit = self.daily.limit
                why = (
                    f"EODHD daily budget used ({limit}/{limit})"
                    if not held or self.daily.left == 0
                    else f"EODHD daily budget: last {held} call(s) kept for "
                    + " and ".join(PRIORITY_INDICES)
                )
                if d is not None:
                    return Served(d, cached=True, note=why)
                raise LocalRateLimited(f"{why}; resets 00:00 UTC")
            since = (now - timedelta(days=HISTORY_DAYS)).date().isoformat()
            try:
                rows = await self._get(f"eod/{code}", {"from": since})
            except NetworkError:
                self.daily.give_back()  # never reached EODHD: not one of the day's calls
                raise
            except TransientError as exc:
                # One attempt per symbol and day: a router retry would spend another of the
                # plan's 20 daily calls on the same answer (review 2 M1).
                raise ProviderError(str(exc), retryable=False) from exc
            series = parse_eod(rows, inst.symbol, ex, now)
            d = Daily(series, now)
            self._mem[inst.symbol] = d
            if self._store is not None:
                try:
                    await asyncio.to_thread(
                        self._store.put, inst.symbol, "1d", series, self.label, Latency.EOD, now
                    )
                except Exception as exc:  # a cache write must not fail the request
                    log.warning("EODHD bar store write failed: %s", exc)
            return Served(d, cached=False)

    # ----- data -----

    async def quote(self, inst: Instrument) -> Quote:
        served = await self._daily(inst)
        v = venue(inst)
        assert v is not None
        ex = v[0]
        self._served[inst.symbol] = served
        return quote_from_series(inst, ex, served.daily.series)

    async def bars(self, inst: Instrument, interval: Interval, lookback_days: int) -> BarSeries:
        if interval != "1d":
            raise NotSupported(f"EODHD Free: daily bars only, not {interval}")
        served = await self._daily(inst)
        self._served[inst.symbol] = served
        s = served.daily.series
        cutoff = int(self.clock().timestamp()) - lookback_days * 86400
        return BarSeries(
            bars=[b for b in s.bars if b.t >= cutoff],
            tz=s.tz,
            utc_offset_s=s.utc_offset_s,
            as_of=s.as_of,
        )

    async def aclose(self) -> None:
        await self._client.aclose()
