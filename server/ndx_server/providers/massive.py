"""Massive (formerly Polygon.io) Stocks Basic: US bars history (SPEC §6.2), tag `EOD`.

docs/PROVIDERS.md §3.18 and recordings of 2026-11-09 (`tests/fixtures/massive_*.json`):
- `GET /v2/aggs/ticker/{T}/range/{n}/{minute|hour|day}/{from}/{to}`, key as a Bearer header
  (never in a URL); `adjusted=true` (split-adjusted), `sort=asc`, `limit` caps the *base*
  minute aggregates scanned (max 50,000, about 50 sessions of minutes incl. extended hours),
  so long intraday ranges come in pages (`next_url`, one call each);
- `t` is the bar's start in ms; daily bars start at 00:00 New York; minute bars cover the
  extended session (04:00-20:00 ET);
- Basic serves the previous session and older only: the previous day becomes available after
  midnight New York time, and asking for today answers HTTP 403 `NOT_AUTHORIZED`;
- two years of history (oldest recorded daily bar 2024-11-11 on 2026-11-09);
- an unknown ticker answers 200 with no results.
Plan limit "5 API Calls / Minute" → the router's bucket allows 4 (*self-imposed*), and every
extra page waits for its own token. Bars may be stored, kept to the rolling 2-year window
(storage rule `massive`).
"""

from __future__ import annotations

import calendar
from collections.abc import Callable
from datetime import UTC, date, datetime, time, timedelta
from typing import Any, ClassVar
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo

import httpx

from ..markets import session_close_on
from ..models import AssetClass, Bar, ChartEvent, Instrument, Interval, Latency
from .base import (
    BarSeries,
    Capability,
    DataProvider,
    LocalRateLimited,
    NetworkError,
    NotFound,
    NotSupported,
    ProviderError,
    TransientError,
)
from .budgets import BUDGETS
from .finnhub_ws import is_us_equity
from .http import check, make_client
from .quota import utc_now

BASE = "https://api.massive.com"
NY = ZoneInfo("America/New_York")
HISTORY_DAYS = 730  # Stocks Basic: two years
SPANS: dict[str, tuple[int, str, int]] = {  # interval -> (multiplier, timespan, seconds)
    "1m": (1, "minute", 60),
    "5m": (5, "minute", 300),
    "15m": (15, "minute", 900),
    "30m": (30, "minute", 1800),
    "1h": (1, "hour", 3600),
    "4h": (4, "hour", 14400),
    "1d": (1, "day", 86400),
}
MAX_PAGES = 3  # *self-imposed*: each extra page waits up to 16 s for a token
PAGE_WAIT_S = 16.0
AVAILABLE_AFTER = time(0, 5)  # the previous session "a few minutes after 12:00 AM ET"


def massive_symbol(symbol: str) -> str:
    """Internal US symbol -> Massive's ticker (share classes use a dot: BRK-B -> BRK.B)."""
    return symbol.replace("-", ".")


def last_available_day(now: datetime) -> date:
    """Basic serves up to the previous New York calendar day (after 00:05 ET)."""
    ny = now.astimezone(NY)
    back = 1 if ny.time() >= AVAILABLE_AFTER else 2
    return ny.date() - timedelta(days=back)


def valid_until(fetched_at: datetime) -> datetime:
    """Bars fetched now gain a session only after the next New York midnight (+5 min)."""
    ny = fetched_at.astimezone(NY)
    day = ny.date() if ny.time() < AVAILABLE_AFTER else ny.date() + timedelta(days=1)
    return datetime.combine(day, AVAILABLE_AFTER, NY)


def _local_t(ms: int) -> int:
    """Massive's UTC ms -> exchange-local wall clock as unix seconds (models.Bar)."""
    local = datetime.fromtimestamp(ms / 1000, NY).replace(tzinfo=None)
    return calendar.timegm(local.timetuple())


def parse_aggs(results: list[dict[str, Any]], symbol: str, interval: str) -> list[Bar]:
    bars: list[Bar] = []
    for r in results:
        try:
            v = r.get("v")
            bars.append(
                Bar(
                    t=_local_t(int(r["t"])),
                    o=float(r["o"]),
                    h=float(r["h"]),
                    l=float(r["l"]),
                    c=float(r["c"]),
                    v=float(v) if v is not None else None,
                )
            )
        except (KeyError, TypeError, ValueError):
            continue  # a malformed row is dropped, never filled
    return bars


def series_as_of(bars: list[Bar], interval: str) -> datetime | None:
    """When the newest bar's data ends: a daily bar at that session's close (16:00 ET on a
    regular day), an intraday bar at its window's end."""
    if not bars:
        return None
    last = bars[-1]
    local = datetime.fromtimestamp(last.t, UTC).replace(tzinfo=None)
    if interval == "1d":
        return session_close_on("XNYS", local.date()) or datetime.combine(
            local.date(), time(16, 0), NY
        )
    return (local + timedelta(seconds=SPANS[interval][2])).replace(tzinfo=NY)


def parse_dividends(results: list[dict[str, Any]]) -> list[ChartEvent]:
    out: list[ChartEvent] = []
    for r in results:
        day, cash = r.get("ex_dividend_date"), r.get("cash_amount")
        if not isinstance(day, str) or not isinstance(cash, int | float):
            continue  # no date or amount: not shown, never guessed
        kind = r.get("distribution_type")
        label = "Dividend" if kind in (None, "recurring", "unknown") else f"Dividend ({kind})"
        out.append(
            ChartEvent(
                kind="D",
                date=day,
                title=f"{label}, ex-date",
                value=float(cash),
                currency=r.get("currency") if isinstance(r.get("currency"), str) else None,
                source="Massive",
            )
        )
    return sorted(out, key=lambda e: e.date)


def parse_splits(results: list[dict[str, Any]]) -> list[ChartEvent]:
    out: list[ChartEvent] = []
    for r in results:
        day, new, old = r.get("execution_date"), r.get("split_to"), r.get("split_from")
        if not isinstance(day, str) or not isinstance(new, int | float):
            continue
        if not isinstance(old, int | float) or old <= 0 or new <= 0:
            continue
        kind = r.get("adjustment_type")
        label = {"reverse_split": "Reverse split", "stock_dividend": "Stock dividend"}.get(
            str(kind), "Split"
        )
        out.append(
            ChartEvent(
                kind="S",
                date=day,
                title=f"{label} {new:g}:{old:g}",
                value=float(new) / float(old),
                source="Massive",
            )
        )
    return sorted(out, key=lambda e: e.date)


class MassiveProvider(DataProvider):
    name: ClassVar[str] = "massive"
    label: ClassVar[str] = "Massive"
    requires_key: ClassVar[bool] = True
    scarce: ClassVar[bool] = True  # 4 calls/min
    capabilities: ClassVar[dict[Capability, frozenset[AssetClass]]] = {
        Capability.BARS: frozenset({AssetClass.EQUITY}),
        Capability.ACTIONS: frozenset({AssetClass.EQUITY}),
    }

    def __init__(
        self,
        api_key: str,
        client: httpx.AsyncClient | None = None,
        clock: Callable[[], datetime] = utc_now,
    ) -> None:
        super().__init__(BUDGETS["massive"].bucket(), api_key)
        self.clock = clock
        self._client = client or make_client(timeout=20.0)

    def latency(self, asset: AssetClass) -> tuple[Latency, int | None]:
        return Latency.EOD, None

    def serves(self, cap: Capability, inst: Instrument | None) -> bool:
        return inst is None or is_us_equity(inst)

    def provider_symbol(self, inst: Instrument) -> str:
        return massive_symbol(inst.symbol)

    def daily_valid_until(
        self, inst: Instrument, fetched_at: datetime, series: BarSeries | None
    ) -> datetime | None:
        return valid_until(fetched_at) if is_us_equity(inst) else None

    def cache_ttl(self, inst: Instrument | None, value: Any, ttl: float) -> float:
        """Basic serves up to the previous session: nothing new until the next New York day
        is available, so intraday bars are not asked again every minute."""
        if isinstance(value, BarSeries):
            now = self.clock()
            return max(ttl, (valid_until(now) - now).total_seconds())
        return ttl

    def meta_overrides(self, inst: Instrument | None, value: Any) -> dict[str, Any]:
        if isinstance(value, BarSeries) and value.note:
            return {"note": value.note}
        return {}

    async def _get(self, url: str, params: dict[str, str] | None = None) -> dict[str, Any]:
        headers = {"Authorization": f"Bearer {self.api_key}"}
        try:
            resp = await self._client.get(url, params=params, headers=headers)
        except (httpx.ConnectError, httpx.ConnectTimeout) as exc:
            raise NetworkError(f"Massive: {type(exc).__name__}") from exc
        except (httpx.TimeoutException, httpx.NetworkError, httpx.RemoteProtocolError) as exc:
            raise TransientError(f"Massive: {type(exc).__name__}") from exc
        if resp.status_code == 403 and "NOT_AUTHORIZED" in resp.text and "timeframe" in resp.text:
            # Basic: today's data (or anything outside the plan's window); not a bad key
            raise NotSupported("Massive Basic: this time range is outside the plan")
        check(resp, "Massive")
        try:
            body = resp.json()
        except ValueError as exc:
            raise ProviderError("Massive: invalid JSON") from exc
        if not isinstance(body, dict):
            raise ProviderError("Massive: unexpected payload")
        return body

    async def bars(self, inst: Instrument, interval: Interval, lookback_days: int) -> BarSeries:
        if not is_us_equity(inst):
            raise NotSupported(f"Massive covers US stocks only, not {inst.symbol}")
        span = SPANS.get(interval)
        if span is None:
            raise NotSupported(f"Massive: {interval} bars are not requested (1m-1d)")
        now = self.clock()
        to = last_available_day(now)
        oldest = now.astimezone(NY).date() - timedelta(days=HISTORY_DAYS)
        frm = max(oldest, now.astimezone(NY).date() - timedelta(days=max(1, lookback_days)))
        if frm > to:
            raise NotFound(f"Massive: no completed session in the last {lookback_days} day(s)")
        sym = massive_symbol(inst.symbol)
        n, unit, _ = span
        url = f"{BASE}/v2/aggs/ticker/{sym}/range/{n}/{unit}/{frm.isoformat()}/{to.isoformat()}"
        body = await self._get(url, {"adjusted": "true", "sort": "desc", "limit": "50000"})
        rows: list[dict[str, Any]] = list(body.get("results") or [])
        pages, note = 1, None
        nxt = body.get("next_url")
        while isinstance(nxt, str) and nxt:
            if urlsplit(nxt).netloc != urlsplit(BASE).netloc:
                raise ProviderError("Massive: next page on an unexpected host")
            if pages >= MAX_PAGES or not await self.rate.acquire(max_wait=PAGE_WAIT_S):
                # Newest first, so what is missing is the oldest part: say from when.
                note = "Massive: older bars not loaded (4 calls/min)"
                break
            page = await self._get(nxt)
            rows += list(page.get("results") or [])
            nxt = page.get("next_url")
            pages += 1
        rows.sort(key=lambda r: int(r.get("t", 0)))
        bars = parse_aggs(rows, inst.symbol, interval)
        if not bars:
            raise NotFound(f"Massive has no {interval} bars for {sym} from {frm} to {to}")
        if note:
            note = f"{note}; from {datetime.fromtimestamp(bars[0].t, UTC).date()}"
        offset = now.astimezone(NY).utcoffset()
        return BarSeries(
            bars=bars,
            tz="America/New_York",
            utc_offset_s=int(offset.total_seconds()) if offset else 0,
            as_of=series_as_of(bars, interval),
            note=note,
        )

    async def corp_actions(self, inst: Instrument) -> list[ChartEvent]:
        """Dividends and splits (`/stocks/v1/dividends`, `/stocks/v1/splits`; all Stocks plans,
        2 years on Basic). Two calls: the second waits for its own token of the 4/min bucket."""
        if not is_us_equity(inst):
            raise NotSupported(f"Massive covers US stocks only, not {inst.symbol}")
        sym = massive_symbol(inst.symbol)
        divs = await self._get(
            f"{BASE}/stocks/v1/dividends",
            {"ticker": sym, "limit": "1000", "sort": "ex_dividend_date.desc"},
        )
        if not await self.rate.acquire(max_wait=PAGE_WAIT_S):
            # Not retried at once: that would spend the bucket on the dividends again.
            # Our own budget said no: not a Massive failure (review 2 M4: it tripped the
            # breaker and blocked bars for 30 s).
            raise LocalRateLimited("Massive: splits not loaded (4 calls/min), try again shortly")
        splits = await self._get(
            f"{BASE}/stocks/v1/splits",
            {"ticker": sym, "limit": "1000", "sort": "execution_date.desc"},
        )
        return parse_dividends(list(divs.get("results") or [])) + parse_splits(
            list(splits.get("results") or [])
        )

    async def aclose(self) -> None:
        await self._client.aclose()
