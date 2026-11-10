"""Alpha Vantage free tier (API key, ~25 requests/day): last-resort fallback for quotes, FX
rates, company overview and daily bars."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any, ClassVar

import httpx

from ..models import AssetClass, Bar, Instrument, Interval, Latency, Profile, Quote
from .barutil import current_offset
from .base import (
    BarSeries,
    Capability,
    DataProvider,
    NotFound,
    NotSupported,
    ProviderError,
    RateLimited,
)
from .budgets import BUDGETS
from .http import get_json, make_client
from .ratelimit import TokenBucket

BASE = "https://www.alphavantage.co/query"


def _num(v: Any) -> float | None:
    try:
        x = float(str(v).rstrip("%"))
    except (TypeError, ValueError):
        return None
    return x


def check_payload(raw: Any) -> dict[str, Any]:
    """AV signals limits and bad symbols inside HTTP 200 responses."""
    if not isinstance(raw, dict):
        raise ProviderError("Alpha Vantage: unexpected payload")
    for key in ("Information", "Note"):
        if key in raw:
            raise RateLimited(f"Alpha Vantage: {str(raw[key])[:160]}")
    if "Error Message" in raw:
        raise NotFound(f"Alpha Vantage: {str(raw['Error Message'])[:160]}")
    return raw


def parse_global_quote(symbol: str, raw: dict[str, Any]) -> Quote:
    q = check_payload(raw).get("Global Quote") or {}
    if not q or _num(q.get("05. price")) is None:
        raise NotFound(f"Alpha Vantage has no quote for {symbol}")
    day = q.get("07. latest trading day")
    return Quote(
        symbol=symbol,
        price=_num(q.get("05. price")),
        change=_num(q.get("09. change")),
        change_pct=_num(q.get("10. change percent")),
        prev_close=_num(q.get("08. previous close")),
        open=_num(q.get("02. open")),
        high=_num(q.get("03. high")),
        low=_num(q.get("04. low")),
        volume=_num(q.get("06. volume")),
        ts=datetime.fromisoformat(day).replace(tzinfo=UTC) if day else None,
    )


def parse_fx(symbol: str, raw: dict[str, Any]) -> Quote:
    r = check_payload(raw).get("Realtime Currency Exchange Rate") or {}
    rate = _num(r.get("5. Exchange Rate"))
    if rate is None:
        raise NotFound(f"Alpha Vantage has no FX rate for {symbol}")
    ts_raw = r.get("6. Last Refreshed")
    ts = datetime.fromisoformat(str(ts_raw)).replace(tzinfo=UTC) if ts_raw else None
    return Quote(
        symbol=symbol,
        price=rate,
        bid=_num(r.get("8. Bid Price")),
        ask=_num(r.get("9. Ask Price")),
        currency=r.get("3. To_Currency Code"),
        ts=ts,
    )


def parse_overview(inst: Instrument, raw: dict[str, Any]) -> Profile:
    o = check_payload(raw)
    if not o.get("Symbol"):
        raise NotFound(f"Alpha Vantage has no overview for {inst.symbol}")
    dy = _num(o.get("DividendYield"))
    return Profile(
        symbol=inst.symbol,
        name=o.get("Name"),
        asset_class=inst.asset_class,
        quote_type=o.get("AssetType"),
        exchange=o.get("Exchange"),
        currency=o.get("Currency"),
        country=o.get("Country"),
        sector=str(o.get("Sector") or "").title() or None,
        industry=str(o.get("Industry") or "").title() or None,
        website=o.get("OfficialSite") or None,
        description=o.get("Description"),
        market_cap=_num(o.get("MarketCapitalization")),
        shares_outstanding=_num(o.get("SharesOutstanding")),
        pe_trailing=_num(o.get("PERatio")),
        pe_forward=_num(o.get("ForwardPE")),
        eps_trailing=_num(o.get("EPS")),
        dividend_yield=dy * 100 if dy is not None else None,  # AV reports a fraction
        beta=_num(o.get("Beta")),
        week52_high=_num(o.get("52WeekHigh")),
        week52_low=_num(o.get("52WeekLow")),
    )


class AlphaVantageProvider(DataProvider):
    name = "alphavantage"
    label = "Alpha Vantage"
    requires_key = True
    capabilities: ClassVar[dict[Capability, frozenset[AssetClass]]] = {
        Capability.QUOTE: frozenset({AssetClass.EQUITY, AssetClass.FX}),
        Capability.PROFILE: frozenset({AssetClass.EQUITY}),
        Capability.BARS: frozenset({AssetClass.EQUITY}),
    }

    def __init__(
        self, api_key: str, client: httpx.AsyncClient | None = None, rate: TokenBucket | None = None
    ) -> None:
        # 25 requests/day with a small burst.
        super().__init__(rate or BUDGETS["alphavantage"].bucket(), api_key=api_key)
        self.client = client or make_client()

    def latency(self, asset: AssetClass) -> tuple[Latency, int | None]:
        return (Latency.DELAYED, None) if asset is AssetClass.FX else (Latency.EOD, None)

    async def aclose(self) -> None:
        await self.client.aclose()

    async def _get(self, params: dict[str, Any]) -> Any:
        return await get_json(
            self.client, BASE, "Alpha Vantage", {**params, "apikey": self.api_key}
        )

    async def quote(self, inst: Instrument) -> Quote:
        if inst.asset_class is AssetClass.FX:
            raw = await self._get(
                {
                    "function": "CURRENCY_EXCHANGE_RATE",
                    "from_currency": inst.symbol[:3],
                    "to_currency": inst.symbol[3:],
                }
            )
            return parse_fx(inst.symbol, raw)
        raw = await self._get({"function": "GLOBAL_QUOTE", "symbol": inst.symbol})
        return parse_global_quote(inst.symbol, raw)

    async def profile(self, inst: Instrument) -> Profile:
        return parse_overview(
            inst, await self._get({"function": "OVERVIEW", "symbol": inst.symbol})
        )

    async def bars(self, inst: Instrument, interval: Interval, lookback_days: int) -> BarSeries:
        if interval != "1d":
            raise NotSupported("Alpha Vantage fallback provides daily bars only")
        raw = check_payload(
            await self._get(
                {"function": "TIME_SERIES_DAILY", "symbol": inst.symbol, "outputsize": "compact"}
            )
        )
        series = raw.get("Time Series (Daily)") or {}
        if not series:
            raise NotFound(f"Alpha Vantage has no daily bars for {inst.symbol}")
        bars = []
        for day, row in sorted(series.items()):
            t = int(datetime.fromisoformat(day).replace(tzinfo=UTC).timestamp())
            bars.append(
                Bar(
                    t=t,
                    o=float(row["1. open"]),
                    h=float(row["2. high"]),
                    l=float(row["3. low"]),
                    c=float(row["4. close"]),
                    v=float(row["5. volume"]),
                )
            )
        return BarSeries(
            bars=bars,
            tz="America/New_York",
            utc_offset_s=current_offset("America/New_York"),
            as_of=datetime.fromtimestamp(bars[-1].t, UTC),
        )
