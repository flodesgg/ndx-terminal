"""Market data service: the single entry point API routes and the live hub use."""

from __future__ import annotations

import asyncio
import logging
import time
from datetime import UTC, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from .barstore import BarStore, StoredSeries
from .fields import FieldRegistry
from .markets import next_session_close
from .models import (
    AssetClass,
    BarsResponse,
    ChartEvent,
    CryptoMarket,
    CryptoMarketsResponse,
    EventsResponse,
    Instrument,
    Interval,
    Latency,
    Meta,
    NewsItem,
    NewsResponse,
    Profile,
    ProfileResponse,
    Quote,
    QuoteItem,
    QuoteResponse,
    QuotesResponse,
    SearchResponse,
    SearchResult,
    YtdBase,
    YtdResponse,
)
from .providers.base import BarSeries, Capability, DataProvider
from .providers.router import ProviderRouter, RouterError
from .providers.storage import DEFAULT as DEFAULT_RULE
from .providers.storage import StorageRule, rule_for
from .symbols import SymbolError, classify, echo_key

log = logging.getLogger("ndx.market")

QUOTE_TTL = {AssetClass.CRYPTO: 3.0, AssetClass.FX: 8.0}
DEFAULT_QUOTE_TTL = 8.0
# SPEC §6.3 TTLs: quotes 2-15 s; intraday bars 60 s; daily bars until the next session close;
# reference data 7 d. Per-provider storage rules (providers/storage.py) override them.
INTRADAY_BARS_TTL = 60.0
DAILY_BARS_FALLBACK_TTL = 15 * 60.0  # no exchange calendar known for the instrument
PROFILE_TTL = 7 * 86400.0
SEARCH_TTL = 7 * 86400.0
NEWS_TTL = 120.0
EARNINGS_TTL = 6 * 3600.0  # new 8-K filings show in EDGAR within minutes
ACTIONS_TTL = 24 * 3600.0  # Massive updates dividends and splits daily
CRYPTO_MARKETS_TTL = 120.0

DEFAULT_LOOKBACK: dict[str, int] = {
    "1m": 3,
    "5m": 20,
    "15m": 45,
    "30m": 59,
    "1h": 240,
    "4h": 540,
    "1d": 365 * 5,
    "1wk": 365 * 20,
    "1mo": 365 * 60,
}


# The US composite listing has no single MIC; NYSE and Nasdaq share sessions and holidays.
CALENDAR_ALIAS = {"US": "XNYS"}
DAY_S = 86400


def calendar_mic(inst: Instrument) -> str | None:
    """Exchange calendar for an equity's canonical ID (`NOVOB DC EQUITY` -> XCSE)."""
    parts = (inst.id or "").split()
    if len(parts) < 3 or parts[-1] != "EQUITY":
        return None
    code = parts[-2]
    if code in CALENDAR_ALIAS:
        return CALENDAR_ALIAS[code]
    from .secmaster import symbology

    ex = symbology().exchanges.get(code)
    return ex.mic if ex is not None and ex.mic else None


def daily_valid_until(inst: Instrument, fetched_at: datetime) -> datetime:
    """A daily bar series fetched at `fetched_at` is current until the next session close."""
    if inst.asset_class is AssetClass.CRYPTO:  # 24/7, daily candles close at 00:00 UTC
        day = fetched_at.astimezone(UTC).replace(hour=0, minute=0, second=0, microsecond=0)
        return day + timedelta(days=1)
    mic = calendar_mic(inst)
    close = next_session_close(mic, fetched_at) if mic else None
    return close or fetched_at + timedelta(seconds=DAILY_BARS_FALLBACK_TTL)


def _quote_ttl(asset: AssetClass) -> float:
    return QUOTE_TTL.get(asset, DEFAULT_QUOTE_TTL)


def _quote_as_of(q: Quote) -> datetime | None:
    return q.ts


class MarketService:
    def __init__(self, router: ProviderRouter, barstore: BarStore | None = None) -> None:
        self.router = router
        self.barstore = barstore
        self.fields = FieldRegistry()
        # Providers that keep their own daily store (EODHD: one call per symbol per session)
        # read and write the same bar store.
        for p in router.providers:
            attach = getattr(p, "attach_store", None)
            if attach is not None and barstore is not None:
                attach(barstore)

    # ---------- quotes ----------

    async def quote(self, symbol: str) -> QuoteResponse:
        inst = classify(symbol)
        q, meta = await self.router.fetch(
            Capability.QUOTE,
            inst.asset_class,
            inst.symbol,
            _quote_ttl(inst.asset_class),
            lambda p: p.quote(inst),
            as_of=_quote_as_of,
            inst=inst,
        )
        self.fields.observe_quote(meta.source, q)
        return QuoteResponse(meta=meta, data=q)

    async def quotes(self, symbols: list[str]) -> QuotesResponse:
        items: dict[str, QuoteItem] = {}
        groups: dict[AssetClass, dict[str, Instrument]] = {}
        order: list[str] = []
        # Items answer in the caller's style: canonical IDs in, canonical IDs out (SPEC §5).
        echo: dict[str, list[str]] = {}
        for raw in symbols:
            try:
                inst = classify(raw)
            except SymbolError as exc:
                key = raw.strip().upper()
                order.append(key)
                items[key] = QuoteItem(symbol=key, error=str(exc))
                continue
            out = echo_key(raw, inst)
            if out in order:
                continue
            order.append(out)
            echo.setdefault(inst.symbol, []).append(out)
            groups.setdefault(inst.asset_class, {})[inst.symbol] = inst

        async def batch(p: DataProvider, insts: list[Instrument]) -> dict[str, Quote]:
            return await p.quotes(insts)

        results = await asyncio.gather(
            *(
                self.router.fetch_batch(
                    Capability.QUOTE, asset, insts, _quote_ttl(asset), batch, as_of=_quote_as_of
                )
                for asset, insts in groups.items()
            )
        )
        for res in results:
            for internal, r in res.items():
                for key in echo.get(internal, [internal]):
                    if isinstance(r, RouterError):
                        items[key] = QuoteItem(symbol=key, error=f"[{r.code}] {r}")
                    else:
                        self.fields.observe_quote(r[1].source, r[0])
                        items[key] = QuoteItem(symbol=key, data=r[0], meta=r[1])
        return QuotesResponse(items=[items[k] for k in order if k in items])

    # ---------- bars ----------

    async def bars(
        self, symbol: str, interval: Interval, lookback: int | None, defer: bool = False
    ) -> BarsResponse:
        """`defer`: asked by a window not in focus. Stored or cached bars, or a source without a
        tight budget; otherwise RouterError "deferred" (the stored copy, if any, tagged STALE,
        until the window is focused)."""
        inst = classify(symbol)
        days = lookback or DEFAULT_LOOKBACK[interval]
        daily = interval in ("1d", "1wk", "1mo")
        now = datetime.now(UTC)
        use_store = self.barstore is not None and daily and lookback is None
        stored = None
        if use_store:
            assert self.barstore is not None
            stored = await asyncio.to_thread(self.barstore.get, inst.symbol, interval)
            owner = self._owner(stored.source) if stored else None
            # Serve stored bars only while their provider is still switched on (an opt-in
            # source the user disabled must not keep showing up from the cache).
            if stored is not None and (
                owner is None or not self.router.available(owner) or not owner.covers(inst)
            ):
                stored = None
            fresh = (
                stored is not None
                and owner is not None
                and self._valid_until(inst, owner, stored) > now
            )
            if fresh and stored is not None and owner is not None:
                meta = self._stored_meta(inst, stored, owner, stale=False)
                return self._bars_response(
                    inst, interval, self._window(stored.series, rule_for(owner)), meta
                )

        ttl = (
            max(1.0, (daily_valid_until(inst, now) - now).total_seconds())
            if daily
            else INTRADAY_BARS_TTL
        )
        fetch_days = days
        if stored is not None and stored.series.bars:
            # Incremental update: only the tail since the last stored bar (+ overlap).
            gap = (int(time.time()) - stored.series.bars[-1].t) // DAY_S + 5
            fetch_days = min(days, max(5, gap))
        try:
            series, meta = await self._fetch_bars(inst, interval, fetch_days, ttl, defer)
        except RouterError as exc:
            # Offline (SPEC §6.3), or deferred: the stored copy, tagged STALE, unless its rule
            # forbids it.
            owner = self._owner(stored.source) if stored is not None else None
            usable = exc.network or exc.code == "deferred"
            if not usable or stored is None or owner is None:
                raise
            rule = rule_for(owner)
            if rule.memory_only:
                raise
            meta = self._stored_meta(inst, stored, owner, stale=True)
            return self._bars_response(inst, interval, self._window(stored.series, rule), meta)
        if stored is not None and fetch_days < days and meta.source != stored.source:
            # Another provider answered the tail request: take its full series instead.
            series, meta = await self._fetch_bars(inst, interval, days, ttl, defer)
            stored = None
        owner = self._owner(meta.source)
        rule = rule_for(owner) if owner is not None else DEFAULT_RULE
        if use_store and rule.bar_store and not rule.memory_only:
            assert self.barstore is not None
            try:
                if not meta.cached:
                    await asyncio.to_thread(
                        self.barstore.put,
                        inst.symbol,
                        interval,
                        series,
                        meta.source,
                        meta.latency,
                        meta.fetched_at,
                    )
                if rule.history_days:
                    await asyncio.to_thread(
                        self.barstore.prune_source,
                        meta.source,
                        rule.history_days,
                        int(time.time()),
                    )
                if stored is not None:
                    merged = await asyncio.to_thread(self.barstore.get, inst.symbol, interval)
                    if merged is not None:
                        series = merged.series
            except Exception as exc:  # cache write failure must not fail the request
                log.warning("bar cache write failed: %s", exc)
        return self._bars_response(inst, interval, self._window(series, rule), meta)

    async def _fetch_bars(
        self, inst: Instrument, interval: Interval, days: int, ttl: float, defer: bool = False
    ) -> tuple[BarSeries, Meta]:
        return await self.router.fetch(
            Capability.BARS,
            inst.asset_class,
            f"{inst.symbol}:{interval}:{days}",
            ttl,
            lambda p: p.bars(inst, interval, days),
            as_of=lambda s: s.as_of,
            inst=inst,
            defer=defer,
        )

    def _owner(self, label: str) -> DataProvider | None:
        return next((p for p in self.router.providers if p.label == label), None)

    @staticmethod
    def _window(series: BarSeries, rule: StorageRule) -> BarSeries:
        """Never serve bars beyond a plan's history window (Massive Basic: 2 years)."""
        if not rule.history_days:
            return series
        cutoff = int(time.time()) - rule.history_days * DAY_S
        return BarSeries(
            bars=[b for b in series.bars if b.t >= cutoff],
            tz=series.tz,
            utc_offset_s=series.utc_offset_s,
            as_of=series.as_of,
        )

    @staticmethod
    def _valid_until(inst: Instrument, owner: DataProvider, stored: StoredSeries) -> datetime:
        own = owner.daily_valid_until(inst, stored.fetched_at, stored.series)
        return own or daily_valid_until(inst, stored.fetched_at)

    @classmethod
    def _stored_meta(
        cls, inst: Instrument, stored: StoredSeries, owner: DataProvider, stale: bool
    ) -> Meta:
        valid = cls._valid_until(inst, owner, stored)
        return Meta(
            source=stored.source,
            latency=stored.latency,
            as_of=stored.series.as_of,
            fetched_at=stored.fetched_at,
            cached=True,
            stale=stale,
            stale_after_s=2 * max(1.0, (valid - stored.fetched_at).total_seconds()),
            personal_use=owner.personal_use,
            demo=owner.demo,
            provider_symbol=owner.provider_symbol(inst),
        )

    @staticmethod
    def _bars_response(
        inst: Instrument, interval: Interval, series: BarSeries, meta: Meta
    ) -> BarsResponse:
        return BarsResponse(
            meta=meta,
            symbol=inst.symbol,
            interval=interval,
            tz=series.tz,
            utc_offset_s=series.utc_offset_s,
            data=series.bars,
        )

    async def ytd_base(self, symbol: str, defer: bool = False) -> YtdBase:
        """The last daily close of the previous calendar year (year of now in the series' own
        zone), from the same daily series GP 1D shows (bar store / cache): no extra request
        once the chart or the quote's daily series has been fetched. Daily bars carry the
        venue's wall-clock date at 00:00 (barutil.wall_clock), so reading `t` as UTC gives it."""
        try:
            res = await self.bars(symbol, "1d", None, defer)
        except (RouterError, SymbolError) as exc:
            code = exc.code if isinstance(exc, RouterError) else "bad_request"
            return YtdBase(symbol=symbol, error=f"[{code}] {exc}")
        year = datetime.now(ZoneInfo(res.tz) if res.tz else UTC).year
        before = [b for b in res.data if datetime.fromtimestamp(b.t, UTC).year < year]
        if not before:
            return YtdBase(symbol=symbol, meta=res.meta)  # history starts this year: N.A.
        last = before[-1]
        day = datetime.fromtimestamp(last.t, UTC).date()
        if day.year != year - 1:
            return YtdBase(symbol=symbol, meta=res.meta)  # no close in the previous year
        return YtdBase(symbol=symbol, close=last.c, day=day, meta=res.meta)

    async def ytd_bases(self, symbols: list[str], defer: bool = False) -> YtdResponse:
        got = await asyncio.gather(*(self.ytd_base(s, defer) for s in symbols))
        return YtdResponse(items=list(got))

    # ---------- reference data ----------

    async def profile(self, symbol: str) -> ProfileResponse:
        inst = classify(symbol)
        prof, meta = await self.router.fetch(
            Capability.PROFILE,
            inst.asset_class,
            inst.symbol,
            PROFILE_TTL,
            lambda p: p.profile(inst),
            inst=inst,
        )
        assert isinstance(prof, Profile)
        self.fields.observe_profile(meta.source, prof)
        return ProfileResponse(meta=meta, data=prof)

    async def search(self, query: str) -> SearchResponse:
        q = query.strip()
        if not q:
            return SearchResponse(
                meta=Meta(source="—", latency=Latency.STATIC, fetched_at=datetime.now(UTC)),
                data=[],
            )
        chain: dict[str, DataProvider] = {}
        for asset in AssetClass:
            for p in self.router.chain(Capability.SEARCH, asset):
                chain.setdefault(p.name, p)

        async def one(p: DataProvider) -> tuple[list[SearchResult], Meta] | RouterError:
            try:
                return await self.router.fetch(
                    Capability.SEARCH,
                    next(iter(p.capabilities[Capability.SEARCH])),
                    f"{p.name}:{q.upper()}",
                    SEARCH_TTL,
                    lambda pp: pp.search(q),
                    only=p.name,
                )
            except RouterError as exc:
                return exc

        results = await asyncio.gather(*(one(p) for p in chain.values()))
        merged: list[SearchResult] = []
        seen: set[str] = set()
        sources: list[str] = []
        errors: list[str] = []
        personal = False
        for r in results:
            if isinstance(r, RouterError):
                errors.append(str(r))
                continue
            data, meta = r
            sources.append(meta.source)
            personal = personal or meta.personal_use
            for item in data:
                if item.symbol not in seen:
                    seen.add(item.symbol)
                    merged.append(item)
        if not sources and errors:
            raise RouterError("upstream", "; ".join(errors), list(chain))
        # Exact symbol matches first.
        merged.sort(key=lambda x: (x.symbol != q.upper(), not x.symbol.startswith(q.upper())))
        meta = Meta(
            source=" + ".join(sources),
            latency=Latency.STATIC,
            fetched_at=datetime.now(UTC),
            personal_use=personal,
        )
        return SearchResponse(meta=meta, data=merged[:15])

    # ---------- news ----------

    async def news(self, symbol: str | None, limit: int = 60) -> NewsResponse:
        inst = classify(symbol) if symbol else None
        asset = inst.asset_class if inst else AssetClass.EQUITY
        key = inst.symbol if inst else "*"
        providers = self.router.chain(Capability.NEWS, asset)

        async def one(p: DataProvider) -> tuple[list[NewsItem], Meta] | RouterError | None:
            try:
                return await self.router.fetch(
                    Capability.NEWS,
                    asset,
                    f"{p.name}:{key}:{limit}",
                    NEWS_TTL,
                    lambda pp: pp.news(inst, limit),
                    only=p.name,
                    inst=inst,
                )
            except RouterError as exc:
                return exc if exc.attempts else None  # None: provider doesn't cover this

        results = await asyncio.gather(*(one(p) for p in providers))
        items: dict[str, NewsItem] = {}
        seen_titles: set[str] = set()
        sources: list[str] = []
        notes: list[str] = []
        errors: list[str] = []
        cached = True
        personal_use = False
        demo = False
        fetched: list[datetime] = []
        for r in results:
            if r is None:
                continue
            if isinstance(r, RouterError):
                errors.append(f"{','.join(r.attempts)}: {r}")
                continue
            data, meta = r
            sources.append(meta.source)
            cached = cached and meta.cached
            personal_use = personal_use or meta.personal_use
            demo = demo or meta.demo
            if meta.fetched_at:
                fetched.append(meta.fetched_at)
            if meta.note:
                notes.append(meta.note)
            for n in data:
                title_key = " ".join(n.headline.lower().split())[:120]
                if n.url in items or title_key in seen_titles:
                    continue
                seen_titles.add(title_key)
                items[n.url] = n
        if not sources and errors:
            raise RouterError("upstream", "; ".join(errors), [p.name for p in providers])
        if not sources:
            raise RouterError("no_provider", "no enabled news provider for this symbol", [])
        merged = sorted(items.values(), key=lambda n: n.published, reverse=True)[:limit]
        meta = Meta(
            source=" + ".join(sources),
            latency=Latency.STATIC,  # publisher timestamps + CACHE hh:mm (SPEC §6.3)
            # CACHE hh:mm is when the oldest merged source was fetched, not this request.
            fetched_at=min(fetched) if fetched else datetime.now(UTC),
            stale_after_s=2 * NEWS_TTL,
            as_of=merged[0].published if merged else None,
            cached=cached,
            # Any opt-in personal-use source (yfinance) marks the whole list (§6.1, §6.2).
            personal_use=personal_use,
            demo=demo,
            note="; ".join(dict.fromkeys(notes)) or None,
        )
        return NewsResponse(meta=meta, data=merged, errors=errors)

    # ---------- corporate events (GP E/D/S markers) ----------

    async def events(self, symbol: str, defer: bool = False) -> EventsResponse:
        """Earnings releases (E) and dividends/splits (D/S), each from its own source; one
        failing leaves the other shown and named in `errors`."""
        inst = classify(symbol)
        parts = {
            "E": (Capability.EARNINGS, EARNINGS_TTL, "earnings_events"),
            "DS": (Capability.ACTIONS, ACTIONS_TTL, "corp_actions"),
        }

        async def one(cap: Capability, ttl: float, method: str) -> Any:
            try:
                return await self.router.fetch(
                    cap,
                    inst.asset_class,
                    inst.symbol,
                    ttl,
                    lambda p: getattr(p, method)(inst),
                    inst=inst,
                    defer=defer,
                )
            except RouterError as exc:
                return exc

        results = await asyncio.gather(*(one(*v) for v in parts.values()))
        events: list[ChartEvent] = []
        sources: list[str] = []
        errors: list[str] = []
        uncovered: list[str] = []
        fetched: list[datetime] = []
        cached = True
        demo = False
        for kinds, r in zip(parts, results, strict=True):
            if isinstance(r, RouterError):
                if r.code == "no_provider":
                    uncovered += list(kinds)
                else:
                    errors.append(f"{'/'.join(kinds)}: {r}")
                continue
            data, meta = r
            events += data
            sources.append(meta.source)
            cached = cached and meta.cached
            demo = demo or meta.demo
            if meta.fetched_at:
                fetched.append(meta.fetched_at)
        if not sources and errors:
            raise RouterError("upstream", "; ".join(errors), [])
        if not sources:
            raise RouterError(
                "no_provider",
                f"no event source for {inst.symbol} (US stocks: SEC EDGAR for earnings, "
                "Massive for dividends and splits)",
                [],
            )
        meta = Meta(
            source=" + ".join(dict.fromkeys(sources)),
            latency=Latency.STATIC,
            fetched_at=min(fetched) if fetched else datetime.now(UTC),
            cached=cached,
            demo=demo,
            stale_after_s=2 * ACTIONS_TTL,
        )
        events.sort(key=lambda e: (e.date, e.kind))
        return EventsResponse(
            meta=meta, symbol=inst.symbol, data=events, errors=errors, uncovered=uncovered
        )

    # ---------- crypto ----------

    async def crypto_markets(self, limit: int = 50) -> CryptoMarketsResponse:
        markets, meta = await self.router.fetch(
            Capability.MARKETCAP,
            AssetClass.CRYPTO,
            f"top:{limit}",
            CRYPTO_MARKETS_TTL,
            lambda p: p.markets(limit),  # type: ignore[attr-defined]
        )
        binance = self.router.by_name.get("binance")
        pairs: set[str] = set()
        if binance is not None and binance.enabled:
            try:
                pairs = {s["symbol"] for s in await binance.exchange_symbols()}  # type: ignore[attr-defined]
            except Exception as exc:  # live mapping is optional; prices still come from CG
                log.warning("binance symbol list unavailable: %s", exc)
        out: list[CryptoMarket] = []
        for m in markets:
            pair = f"{m.symbol}USDT"
            out.append(m.model_copy(update={"binance_symbol": pair if pair in pairs else None}))
        return CryptoMarketsResponse(meta=meta, data=out)

    def provider(self, name: str) -> Any:
        return self.router.by_name.get(name)
