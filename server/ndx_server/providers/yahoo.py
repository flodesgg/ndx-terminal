"""Yahoo Finance adapter (keyless). Uses yfinance's session (cookie/crumb handling) to call
Yahoo's JSON endpoints directly; all parsing lives in pure functions that are unit-tested
against recorded fixtures."""

from __future__ import annotations

import asyncio
import hashlib
import math
import time
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import UTC, date, datetime
from typing import Any, ClassVar, Literal
from zoneinfo import ZoneInfo

from ..models import (
    AssetClass,
    Bar,
    EconEvent,
    Filing,
    InsiderTxn,
    Instrument,
    Interval,
    Latency,
    NewsItem,
    Profile,
    Quote,
    ScreenRow,
    SearchResult,
)
from ..symbols import to_yahoo
from .barutil import DAILY_PLUS, current_offset, resample_session, wall_clock
from .base import (
    BarSeries,
    Capability,
    DataProvider,
    NotFound,
    NotSupported,
    ProviderError,
    RateLimited,
    TransientError,
)
from .budgets import BUDGETS
from .ratelimit import TokenBucket
from .yahoo_research import YahooResearchMixin, dumps

Q1 = "https://query1.finance.yahoo.com"
Q2 = "https://query2.finance.yahoo.com"


@dataclass(frozen=True)
class OptInScope:
    """A limited yfinance opt-in: the instruments it covers (decision 2026-11-10,
    Danish stocks and all indices; EODHD stays the fallback)."""

    key: str
    label: str
    test: Callable[[Instrument], bool]

    def covers(self, inst: Instrument) -> bool:
        return self.test(inst)


def _index_symbols() -> frozenset[str]:
    from ..secmaster import symbology

    return frozenset(r["yahoo"] for r in symbology().indices.values() if r.get("yahoo"))


def _danish_or_index(inst: Instrument) -> bool:
    sym = inst.symbol.upper()
    if inst.asset_class is AssetClass.EQUITY:
        return sym.endswith(".CO")  # Nasdaq Copenhagen
    if inst.asset_class is AssetClass.INDEX:  # futures (CL=F) are INDEX too: not indices
        return not sym.endswith("=F") and (sym.startswith("^") or sym in _index_symbols())
    return False


OPT_IN_SCOPES = {
    "dk_indices": OptInScope("dk_indices", "Danish stocks and indices", _danish_or_index),
}

ALL = frozenset(AssetClass)
NON_CRYPTO = frozenset({AssetClass.EQUITY, AssetClass.INDEX, AssetClass.FX})

# Yahoo interval name and max lookback (days) per interval.
_INTERVALS: dict[str, tuple[str, int]] = {
    "1m": ("1m", 7),
    "5m": ("5m", 59),
    "15m": ("15m", 59),
    "30m": ("30m", 59),
    "1h": ("60m", 729),
    "4h": ("60m", 729),
    "1d": ("1d", 365 * 60),
    "1wk": ("1wk", 365 * 60),
    "1mo": ("1mo", 365 * 60),
}

_QUOTE_TYPE_CLASS = {
    "EQUITY": AssetClass.EQUITY,
    "ETF": AssetClass.EQUITY,
    "MUTUALFUND": AssetClass.EQUITY,
    "INDEX": AssetClass.INDEX,
    "FUTURE": AssetClass.INDEX,
    "CURRENCY": AssetClass.FX,
    "CRYPTOCURRENCY": AssetClass.CRYPTO,
}


def _f(v: Any) -> float | None:
    """Finite float or None (Yahoo uses 0 for 'no bid' outside sessions)."""
    if v is None or isinstance(v, bool):
        return None
    try:
        x = float(v)
    except (TypeError, ValueError):
        return None
    return x if math.isfinite(x) else None


def _pos(v: Any) -> float | None:
    x = _f(v)
    return x if x is not None and x > 0 else None


def _ts(v: Any) -> datetime | None:
    x = _f(v)
    return datetime.fromtimestamp(x, UTC) if x else None


def from_yahoo_symbol(sym: str) -> str:
    """Map Yahoo symbols back to ours (EURUSD=X -> EURUSD, JPY=X -> USDJPY)."""
    if sym.endswith("=X"):
        core = sym[:-2]
        return f"USD{core}" if len(core) == 3 else core
    return sym


# ---------------------------------------------------------------- parsing


def quote_latency(raw: dict[str, Any]) -> tuple[Latency, int | None, str | None]:
    """Delay tag from Yahoo's own per-exchange field (`D{n}`). Yahoo is a redistributor: even a
    stated 0-minute delay is not labelled `RT` (venue vs consolidated is undocumented, PROVIDERS
    P2; open question 3). A missing field means the delay is unknown -> no `D{n}` claim."""
    raw_delay = raw.get("exchangeDataDelayedBy")
    source = str(raw.get("quoteSourceName") or "")
    note = f"Yahoo: {source}" if source else None
    if raw_delay is None:
        return Latency.DELAYED, None, note
    delay = int(raw_delay)
    if delay == 0:
        note = (note + "; " if note else "") + "Yahoo states no delay (redistributor, unverified)"
    return Latency.DELAYED, delay, note


def parse_quote(raw: dict[str, Any], symbol: str | None = None) -> Quote:
    q = _parse_quote(raw, symbol)
    q._latency = quote_latency(raw)
    return q


def _parse_quote(raw: dict[str, Any], symbol: str | None) -> Quote:
    price = _f(raw.get("regularMarketPrice"))
    state = raw.get("marketState")
    ext_price: float | None = None
    ext_pct: float | None = None
    ext_session: Literal["PRE", "POST"] | None = None
    if state in ("PRE", "PREPRE") and _pos(raw.get("preMarketPrice")):
        ext_price, ext_pct, ext_session = (
            _f(raw.get("preMarketPrice")),
            _f(raw.get("preMarketChangePercent")),
            "PRE",
        )
    elif state in ("POST", "POSTPOST", "CLOSED") and _pos(raw.get("postMarketPrice")):
        ext_price, ext_pct, ext_session = (
            _f(raw.get("postMarketPrice")),
            _f(raw.get("postMarketChangePercent")),
            "POST",
        )
    return Quote(
        symbol=symbol or from_yahoo_symbol(str(raw.get("symbol", ""))),
        name=raw.get("longName") or raw.get("shortName") or raw.get("displayName"),
        currency=raw.get("currency"),
        exchange=raw.get("fullExchangeName") or raw.get("exchange"),
        price=price,
        change=_f(raw.get("regularMarketChange")),
        change_pct=_f(raw.get("regularMarketChangePercent")),
        prev_close=_f(raw.get("regularMarketPreviousClose")),
        open=_pos(raw.get("regularMarketOpen")),
        high=_pos(raw.get("regularMarketDayHigh")),
        low=_pos(raw.get("regularMarketDayLow")),
        # Indices/FX report 0 volume meaning "not available" -> None (N.A.), never 0.
        volume=(
            _pos(raw.get("regularMarketVolume"))
            if raw.get("quoteType") in ("INDEX", "CURRENCY")
            else _f(raw.get("regularMarketVolume"))
        ),
        # Yahoo's bid/ask is neither a stated venue book nor consolidated -> N.A. (SPEC §8 Q).
        bid=None,
        ask=None,
        bid_size=None,
        ask_size=None,
        market_state=state,
        ts=_ts(raw.get("regularMarketTime")),
        ext_price=ext_price,
        ext_change_pct=ext_pct,
        ext_session=ext_session,
        week52_high=_pos(raw.get("fiftyTwoWeekHigh")),
        week52_low=_pos(raw.get("fiftyTwoWeekLow")),
        avg_volume=_pos(raw.get("averageDailyVolume3Month")),
        market_cap=_pos(raw.get("marketCap")),
    )


def quote_results(payload: dict[str, Any]) -> list[dict[str, Any]]:
    resp = payload.get("quoteResponse") or {}
    if resp.get("error"):
        raise ProviderError(f"Yahoo quote error: {resp['error']}")
    return list(resp.get("result") or [])


def parse_chart(payload: dict[str, Any], interval: str) -> BarSeries:
    chart = payload.get("chart") or {}
    if chart.get("error"):
        err = chart["error"]
        msg = f"{err.get('code')}: {err.get('description')}"
        raise NotFound(msg) if err.get("code") == "Not Found" else ProviderError(msg)
    results = chart.get("result") or []
    if not results:
        raise NotFound("no chart data")
    res = results[0]
    meta = res.get("meta") or {}
    tz_name = meta.get("exchangeTimezoneName") or "UTC"
    tz = ZoneInfo(tz_name)
    stamps = res.get("timestamp") or []
    q = ((res.get("indicators") or {}).get("quote") or [{}])[0]
    adj = ((res.get("indicators") or {}).get("adjclose") or [{}])[0].get("adjclose")
    daily = interval in DAILY_PLUS
    # Indices/FX report 0 volume meaning "not available" -> None (N.A.), as in parse_quote.
    no_volume = meta.get("instrumentType") in ("INDEX", "CURRENCY")
    bars: list[Bar] = []
    for i, ts in enumerate(stamps):
        o, h, lo, c = (
            _f(q.get(k, [None] * len(stamps))[i]) for k in ("open", "high", "low", "close")
        )
        if o is None or h is None or lo is None or c is None or c <= 0:
            continue  # Yahoo emits null rows for halts / empty minutes
        raw_v = (q.get("volume") or [None] * len(stamps))[i]
        v = _pos(raw_v) if no_volume else _f(raw_v)  # missing stays None (N.A.)
        if daily and adj is not None:
            a = _f(adj[i])
            if a and c:
                r = a / c  # split/dividend adjustment, like yfinance auto_adjust
                o, h, lo, c = o * r, h * r, lo * r, a
        bars.append(Bar(t=wall_clock(int(ts), tz, daily), o=o, h=h, l=lo, c=c, v=v))
    # Collapse duplicate timestamps (Yahoo sometimes repeats the live bar).
    dedup: dict[int, Bar] = {}
    for b in bars:
        dedup[b.t] = b
    bars = [dedup[t] for t in sorted(dedup)]
    if interval == "4h":
        bars = resample_session(bars, 4 * 3600)
    return BarSeries(
        bars=bars,
        tz=tz_name,
        utc_offset_s=current_offset(tz_name),
        as_of=_ts(meta.get("regularMarketTime")),
    )


def parse_search(payload: dict[str, Any]) -> list[SearchResult]:
    out: list[SearchResult] = []
    for q in payload.get("quotes") or []:
        sym = q.get("symbol")
        qt = str(q.get("quoteType") or "").upper()
        ac = _QUOTE_TYPE_CLASS.get(qt)
        if not sym or ac is None:
            continue
        out.append(
            SearchResult(
                symbol=from_yahoo_symbol(sym),
                name=q.get("longname") or q.get("shortname"),
                exchange=q.get("exchDisp") or q.get("exchange"),
                type=q.get("typeDisp") or qt.title(),
                asset_class=ac,
            )
        )
    return out


def _dividend_yield_pct(summary: dict[str, Any], quote: dict[str, Any]) -> float | None:
    """Percent. v7 quote reports percent (0.32); quoteSummary reports a fraction (0.0032)."""
    q = _pos(quote.get("dividendYield"))
    if q is not None:
        return q
    s = _pos(summary.get("dividendYield"))
    return s * 100 if s is not None else None


def parse_news(payload: dict[str, Any]) -> list[NewsItem]:
    out: list[NewsItem] = []
    for n in payload.get("news") or []:
        url, title, ts = n.get("link"), n.get("title"), n.get("providerPublishTime")
        if not url or not title or not ts:
            continue
        out.append(
            NewsItem(
                id=str(n.get("uuid") or hashlib.sha1(url.encode()).hexdigest()[:16]),
                headline=str(title).strip(),
                url=url,
                source=n.get("publisher") or "Yahoo Finance",
                provider="Yahoo Finance",
                published=datetime.fromtimestamp(int(ts), UTC),
                tickers=[from_yahoo_symbol(t) for t in n.get("relatedTickers") or []],
            )
        )
    return out


def _raw(v: Any) -> Any:
    """quoteSummary values may be {raw, fmt} dicts even with formatted=false."""
    if isinstance(v, dict) and "raw" in v:
        return v["raw"]
    return v


def parse_profile(
    inst: Instrument, summary: dict[str, Any] | None, quote: dict[str, Any] | None
) -> Profile:
    s: dict[str, Any] = {}
    if summary:
        res = ((summary.get("quoteSummary") or {}).get("result") or [{}])[0] or {}
        for module in ("price", "summaryDetail", "defaultKeyStatistics", "assetProfile"):
            for k, v in (res.get(module) or {}).items():
                s.setdefault(k, _raw(v))
        cal = (res.get("calendarEvents") or {}).get("earnings") or {}
        s["_earnings"] = [_raw(x) for x in (cal.get("earningsDate") or [])]
        s["_earnings_est"] = cal.get("isEarningsDateEstimate")
        s["_exdiv"] = _raw((res.get("calendarEvents") or {}).get("exDividendDate"))
    qd = quote or {}
    now = time.time()
    future = sorted(
        x
        for x in [
            *s.get("_earnings", []),
            qd.get("earningsTimestampStart"),
            qd.get("earningsTimestamp"),
        ]
        if isinstance(x, int | float) and x > now - 86400
    )
    exdiv = _f(s.get("_exdiv"))
    return Profile(
        symbol=inst.symbol,
        name=qd.get("longName") or s.get("longName") or qd.get("shortName") or s.get("shortName"),
        asset_class=inst.asset_class,
        quote_type=qd.get("quoteType") or s.get("quoteType"),
        exchange=qd.get("fullExchangeName") or s.get("exchangeName"),
        currency=qd.get("currency") or s.get("currency"),
        country=s.get("country"),
        sector=s.get("sector") or s.get("sectorDisp"),
        industry=s.get("industry") or s.get("industryDisp"),
        website=s.get("website"),
        employees=int(s["fullTimeEmployees"]) if s.get("fullTimeEmployees") else None,
        description=s.get("longBusinessSummary") or s.get("description"),
        market_cap=_pos(qd.get("marketCap") or s.get("marketCap")),
        shares_outstanding=_pos(qd.get("sharesOutstanding") or s.get("sharesOutstanding")),
        pe_trailing=_pos(qd.get("trailingPE") or s.get("trailingPE")),
        pe_forward=_pos(qd.get("forwardPE") or s.get("forwardPE")),
        eps_trailing=_f(qd.get("epsTrailingTwelveMonths") or s.get("trailingEps")),
        dividend_yield=_dividend_yield_pct(s, qd),
        beta=_f(s.get("beta")),
        week52_high=_pos(qd.get("fiftyTwoWeekHigh") or s.get("fiftyTwoWeekHigh")),
        week52_low=_pos(qd.get("fiftyTwoWeekLow") or s.get("fiftyTwoWeekLow")),
        avg_volume=_pos(qd.get("averageDailyVolume3Month") or s.get("averageVolume")),
        next_earnings=datetime.fromtimestamp(future[0], UTC) if future else None,
        earnings_estimate=bool(s.get("_earnings_est") or qd.get("isEarningsDateEstimate"))
        if future
        else None,
        ex_dividend_date=datetime.fromtimestamp(exdiv, UTC) if exdiv else None,
        extra={
            k: v
            for k, v in {
                "price_to_book": _pos(qd.get("priceToBook")),
                "fifty_day_avg": _pos(qd.get("fiftyDayAverage")),
                "two_hundred_day_avg": _pos(qd.get("twoHundredDayAverage")),
                "analyst_rating": qd.get("averageAnalystRating"),
                "float_shares": _pos(s.get("floatShares")),
                "short_ratio": _pos(s.get("shortRatio")),
                "profit_margins": _f(s.get("profitMargins")),
            }.items()
            if v is not None
        },
    )


# ---------------------------------------------------------------- provider


class YahooProvider(YahooResearchMixin, DataProvider):
    """Unofficial; Yahoo's terms forbid automated collection (PROVIDERS P1) -> opt-in, off by
    default, every value marked PERSONAL USE. Still uses yfinance's private transport (v1);
    the public-API rewrite with contract tests is Phase 2 work."""

    name = "yahoo"
    label = "Yahoo Finance"
    opt_in = True
    personal_use = True
    capabilities: ClassVar[dict[Capability, frozenset[AssetClass]]] = {
        Capability.QUOTE: ALL,
        Capability.BARS: ALL,
        Capability.PROFILE: ALL,
        Capability.SEARCH: ALL,
        Capability.NEWS: ALL,
        Capability.FUNDAMENTALS: frozenset({AssetClass.EQUITY}),
        Capability.FILINGS: frozenset({AssetClass.EQUITY}),
        Capability.INSIDERS: frozenset({AssetClass.EQUITY}),
        # "global" datasets are routed under the INDEX asset class
        Capability.CALENDAR: frozenset({AssetClass.INDEX}),
        Capability.SCREENER: frozenset({AssetClass.EQUITY}),
    }

    def __init__(self, rate: TokenBucket | None = None, workers: int = 4) -> None:
        # Self-imposed budget from PROVIDERS.md §3.3 (Yahoo documents none); quotes are batched,
        # so one live poll is one token (review 1a #24).
        super().__init__(rate or BUDGETS["yahoo"].bucket())
        self._pool = ThreadPoolExecutor(max_workers=workers, thread_name_prefix="yahoo")
        # What the user's opt-in covers: None = every market (PDF YFINANCE ON); a scope
        # (PDF YFINANCE DK) limits it, and outside it this source says NotSupported so the
        # router goes on to the next one (EODHD, ECB, Massive...).
        self.scope: OptInScope | None = None

    def set_scope(self, scope: OptInScope | None) -> None:
        self.scope = scope

    @property
    def scope_label(self) -> str:
        return self.scope.label if self.scope is not None else "every market"

    async def fundamentals(self, inst: Instrument, period: str) -> Any:
        self._check(inst)
        return await super().fundamentals(inst, period)

    async def filings(self, inst: Instrument) -> list[Filing]:
        self._check(inst)
        return await super().filings(inst)

    async def insiders(self, inst: Instrument) -> list[InsiderTxn]:
        self._check(inst)
        return await super().insiders(inst)

    async def econ_calendar(self, start: date, end: date) -> list[EconEvent]:
        self._no_scope("economic calendar")
        return await super().econ_calendar(start, end)

    async def screen(self, body: dict[str, Any]) -> tuple[int, list[ScreenRow]]:
        self._no_scope("screener")
        return await super().screen(body)

    def covers(self, inst: Instrument) -> bool:
        return self.scope is None or self.scope.covers(inst)

    def _check(self, inst: Instrument) -> None:
        if self.scope is not None and not self.scope.covers(inst):
            raise NotSupported(f"yfinance opt-in is limited to {self.scope.label}")

    def _no_scope(self, what: str) -> None:
        if self.scope is not None:
            raise NotSupported(f"yfinance {what}: opt-in limited to {self.scope.label}")

    def provider_symbol(self, inst: Instrument) -> str:
        return to_yahoo(inst)

    def result_meta(self, asset: AssetClass, value: Any) -> tuple[Latency, int | None, str | None]:
        if isinstance(value, Quote) and value._latency is not None:
            return value._latency
        if isinstance(value, list) and value and isinstance(value[0], NewsItem):
            return Latency.DELAYED, None, "headlines via Yahoo search"
        if asset is AssetClass.CRYPTO:
            return Latency.DELAYED, None, "Yahoo crypto quotes are USD (CoinMarketCap), not USDT"
        return Latency.DELAYED, None, None

    async def aclose(self) -> None:
        self._pool.shutdown(wait=False, cancel_futures=True)

    # -- transport --

    def _get_sync(self, url: str, params: dict[str, Any]) -> Any:
        from yfinance.data import YfData
        from yfinance.exceptions import YFRateLimitError

        try:
            resp = YfData().get(url, params=params, timeout=15)
        except YFRateLimitError as exc:
            raise RateLimited("Yahoo rate limit (429)") from exc
        except Exception as exc:  # network errors from curl_cffi/requests
            raise TransientError(f"{type(exc).__name__}: {exc}") from exc
        status = int(resp.status_code)
        if status == 429:
            raise RateLimited("Yahoo rate limit (429)")
        if status >= 500:
            raise TransientError(f"Yahoo HTTP {status}")
        try:
            body = resp.json()
        except Exception as exc:
            raise ProviderError(f"Yahoo returned non-JSON (HTTP {status})") from exc
        if status == 404:
            # chart/quoteSummary return structured errors with 404
            return body
        if status >= 400:
            raise ProviderError(f"Yahoo HTTP {status}")
        return body

    async def _get(self, url: str, params: dict[str, Any]) -> Any:
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(self._pool, self._get_sync, url, params)

    def _post_sync(self, url: str, params: dict[str, Any], body: dict[str, Any]) -> Any:
        from yfinance.data import YfData
        from yfinance.exceptions import YFRateLimitError

        try:
            resp = YfData().post(
                url,
                params=params,
                data=dumps(body),
                headers={"Content-Type": "application/json"},
                timeout=15,
            )
        except YFRateLimitError as exc:
            raise RateLimited("Yahoo rate limit (429)") from exc
        except Exception as exc:
            raise TransientError(f"{type(exc).__name__}: {exc}") from exc
        status = int(resp.status_code)
        if status == 429:
            raise RateLimited("Yahoo rate limit (429)")
        if status >= 500:
            raise TransientError(f"Yahoo HTTP {status}")
        if status >= 400:
            raise ProviderError(f"Yahoo HTTP {status}: {resp.text[:160]}")
        return resp.json()

    async def _post(self, url: str, params: dict[str, Any], body: dict[str, Any]) -> Any:
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(self._pool, self._post_sync, url, params, body)

    # -- data --

    async def raw_quotes(self, yahoo_symbols: list[str]) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        for i in range(0, len(yahoo_symbols), 50):
            chunk = yahoo_symbols[i : i + 50]
            payload = await self._get(
                f"{Q1}/v7/finance/quote", {"symbols": ",".join(chunk), "formatted": "false"}
            )
            out.extend(quote_results(payload))
        return out

    async def quote(self, inst: Instrument) -> Quote:
        self._check(inst)
        raws = await self.raw_quotes([to_yahoo(inst)])
        if not raws or raws[0].get("regularMarketPrice") is None:
            raise NotFound(f"Yahoo has no quote for {inst.symbol}")
        return parse_quote(raws[0], inst.symbol)

    async def quotes(self, insts: list[Instrument]) -> dict[str, Quote]:
        insts = [i for i in insts if self.covers(i)]  # the rest fall through to the next source
        if not insts:
            raise NotSupported(f"yfinance opt-in is limited to {self.scope_label}")
        by_yahoo = {to_yahoo(i): i for i in insts}
        raws = await self.raw_quotes(list(by_yahoo))
        out: dict[str, Quote] = {}
        for raw in raws:
            inst = by_yahoo.get(str(raw.get("symbol")))
            if inst is not None and raw.get("regularMarketPrice") is not None:
                out[inst.symbol] = parse_quote(raw, inst.symbol)
        return out

    async def bars(self, inst: Instrument, interval: Interval, lookback_days: int) -> BarSeries:
        self._check(inst)
        yi, max_days = _INTERVALS[interval]
        days = max(1, min(lookback_days, max_days))
        now = int(time.time())
        params: dict[str, Any] = {
            "interval": yi,
            "period1": now - days * 86400,
            "period2": now,
            "includePrePost": "false",
            "events": "div,splits",
            "includeAdjustedClose": "true",
        }
        payload = await self._get(f"{Q2}/v8/finance/chart/{to_yahoo(inst)}", params)
        series = parse_chart(payload, interval)
        if not series.bars:
            raise NotFound(f"Yahoo returned no {interval} bars for {inst.symbol}")
        return series

    async def profile(self, inst: Instrument) -> Profile:
        self._check(inst)
        ys = to_yahoo(inst)
        summary_task = self._get(
            f"{Q2}/v10/finance/quoteSummary/{ys}",
            {
                "modules": "assetProfile,summaryDetail,defaultKeyStatistics,price,calendarEvents",
                "formatted": "false",
            },
        )
        quote_task = self.raw_quotes([ys])
        summary, quotes = await asyncio.gather(summary_task, quote_task, return_exceptions=True)
        q = quotes[0] if isinstance(quotes, list) and quotes else None
        sm = summary if isinstance(summary, dict) else None
        if sm is not None and (sm.get("quoteSummary") or {}).get("error"):
            sm = None
        if q is None and sm is None:
            err = summary if isinstance(summary, BaseException) else quotes
            if isinstance(err, BaseException):
                raise err
            raise NotFound(f"Yahoo has no profile for {inst.symbol}")
        return parse_profile(inst, sm, q)

    async def news(self, inst: Instrument | None, limit: int) -> list[NewsItem]:
        if inst is None:
            raise NotSupported("Yahoo news is per symbol")
        self._check(inst)
        payload = await self._get(
            f"{Q2}/v1/finance/search",
            {"q": to_yahoo(inst), "quotesCount": 0, "newsCount": min(limit, 30)},
        )
        return parse_news(payload)

    async def search(self, query: str) -> list[SearchResult]:
        self._no_scope("search")
        payload = await self._get(
            f"{Q2}/v1/finance/search",
            {"q": query, "quotesCount": 10, "newsCount": 0, "enableFuzzyQuery": "false"},
        )
        return parse_search(payload)
