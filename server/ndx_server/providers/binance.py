"""Binance spot market data (keyless, real-time). REST here; streaming lives in `live.py`."""

from __future__ import annotations

import json
import time
from datetime import UTC, datetime
from typing import Any, ClassVar

import httpx

from ..models import AssetClass, Bar, Instrument, Interval, Latency, Profile, Quote, SearchResult
from ..symbols import CRYPTO_QUOTES
from .base import (
    BarSeries,
    Capability,
    DataProvider,
    NotFound,
    ProviderError,
    TransientError,
)
from .budgets import BUDGETS
from .http import get_json, make_client
from .ratelimit import TokenBucket

BASES = ("https://api.binance.com/api/v3", "https://data-api.binance.vision/api/v3")
CRYPTO = frozenset({AssetClass.CRYPTO})

INTERVALS: dict[str, str] = {
    "1m": "1m",
    "5m": "5m",
    "15m": "15m",
    "30m": "30m",
    "1h": "1h",
    "4h": "4h",
    "1d": "1d",
    "1wk": "1w",
    "1mo": "1M",
}
_SECONDS = {
    "1m": 60,
    "5m": 300,
    "15m": 900,
    "30m": 1800,
    "1h": 3600,
    "4h": 14400,
    "1d": 86400,
    "1wk": 604800,
    "1mo": 2592000,
}
MAX_BARS = 5000


def _f(v: Any) -> float | None:
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def parse_ticker(raw: dict[str, Any]) -> Quote:
    """/api/v3/ticker/24hr item -> Quote."""
    price = _f(raw.get("lastPrice"))
    bid, ask = _f(raw.get("bidPrice")), _f(raw.get("askPrice"))
    sym = str(raw.get("symbol"))
    return Quote(
        symbol=sym,
        name=sym,
        currency=next((q for q in CRYPTO_QUOTES if sym.endswith(q)), None),
        exchange="Binance",
        price=price,
        change=_f(raw.get("priceChange")),
        change_pct=_f(raw.get("priceChangePercent")),
        prev_close=_f(raw.get("prevClosePrice")) or _f(raw.get("openPrice")),
        open=_f(raw.get("openPrice")),
        high=_f(raw.get("highPrice")),
        low=_f(raw.get("lowPrice")),
        volume=_f(raw.get("volume")),
        bid=bid if bid else None,
        ask=ask if ask else None,
        bid_size=_f(raw.get("bidQty")) or None,
        ask_size=_f(raw.get("askQty")) or None,
        market_state="REGULAR",
        ts=datetime.fromtimestamp(int(raw["closeTime"]) / 1000, UTC)
        if raw.get("closeTime")
        else None,
    )


def parse_ws_ticker(d: dict[str, Any]) -> Quote:
    """Stream `<symbol>@ticker` payload -> Quote."""
    sym = str(d.get("s"))
    return Quote(
        symbol=sym,
        name=sym,
        currency=next((q for q in CRYPTO_QUOTES if sym.endswith(q)), None),
        exchange="Binance",
        price=_f(d.get("c")),
        change=_f(d.get("p")),
        change_pct=_f(d.get("P")),
        prev_close=_f(d.get("x")) or _f(d.get("o")),
        open=_f(d.get("o")),
        high=_f(d.get("h")),
        low=_f(d.get("l")),
        volume=_f(d.get("v")),
        bid=_f(d.get("b")) or None,
        ask=_f(d.get("a")) or None,
        bid_size=_f(d.get("B")) or None,
        ask_size=_f(d.get("A")) or None,
        market_state="REGULAR",
        ts=datetime.fromtimestamp(int(d["E"]) / 1000, UTC) if d.get("E") else None,
    )


def parse_klines(rows: list[list[Any]]) -> list[Bar]:
    out: list[Bar] = []
    for r in rows:
        out.append(
            Bar(
                t=int(r[0]) // 1000,
                o=float(r[1]),
                h=float(r[2]),
                l=float(r[3]),
                c=float(r[4]),
                v=float(r[5]),
            )
        )
    return out


def parse_ws_kline(k: dict[str, Any]) -> Bar:
    return Bar(
        t=int(k["t"]) // 1000,
        o=float(k["o"]),
        h=float(k["h"]),
        l=float(k["l"]),
        c=float(k["c"]),
        v=float(k["v"]),
    )


class BinanceProvider(DataProvider):
    name = "binance"
    label = "Binance"
    capabilities: ClassVar[dict[Capability, frozenset[AssetClass]]] = {
        Capability.QUOTE: CRYPTO,
        Capability.BARS: CRYPTO,
        Capability.PROFILE: CRYPTO,
        Capability.SEARCH: CRYPTO,
    }

    def __init__(
        self, rate: TokenBucket | None = None, client: httpx.AsyncClient | None = None
    ) -> None:
        super().__init__(rate or BUDGETS["binance"].bucket())
        self.client = client or make_client()
        self._base_idx = 0
        self._symbols: list[dict[str, Any]] = []
        self._symbols_at = 0.0

    def latency(self, asset: AssetClass) -> tuple[Latency, int | None]:
        return Latency.REALTIME, None

    async def aclose(self) -> None:
        await self.client.aclose()

    async def _get(self, path: str, params: dict[str, Any] | None = None) -> Any:
        """Try the preferred base URL, then the public-data mirror (some regions block one)."""
        last: Exception | None = None
        for i in range(len(BASES)):
            idx = (self._base_idx + i) % len(BASES)
            try:
                data = await get_json(self.client, f"{BASES[idx]}{path}", "Binance", params)
            except (TransientError, ProviderError) as exc:
                if isinstance(exc, NotFound):
                    raise
                msg = str(exc)
                # 451 = restricted location; 403 = WAF; network errors: try the mirror
                if isinstance(exc, TransientError) or " 451" in msg or " 403" in msg:
                    last = exc
                    continue
                raise
            self._base_idx = idx
            return data
        assert last is not None
        raise last

    @staticmethod
    def _bad_symbol(exc: Exception) -> bool:
        return "-1121" in str(exc) or "Invalid symbol" in str(exc)

    async def quote(self, inst: Instrument) -> Quote:
        try:
            raw = await self._get("/ticker/24hr", {"symbol": inst.symbol})
        except ProviderError as exc:
            if self._bad_symbol(exc):
                raise NotFound(f"Binance has no symbol {inst.symbol}") from exc
            raise
        return parse_ticker(raw)

    async def quotes(self, insts: list[Instrument]) -> dict[str, Quote]:
        syms = [i.symbol for i in insts]
        try:
            raw = await self._get(
                "/ticker/24hr", {"symbols": json.dumps(syms, separators=(",", ":"))}
            )
        except ProviderError as exc:
            if not self._bad_symbol(exc) or len(insts) == 1:
                raise
            # One bad symbol fails the whole batch: fall back to individual requests.
            out: dict[str, Quote] = {}
            for inst in insts:
                try:
                    out[inst.symbol] = await self.quote(inst)
                except NotFound:
                    continue
            return out
        return {q.symbol: q for q in (parse_ticker(r) for r in raw)}

    async def bars(self, inst: Instrument, interval: Interval, lookback_days: int) -> BarSeries:
        bi = INTERVALS[interval]
        want = min(MAX_BARS, max(1, int(lookback_days * 86400 / _SECONDS[interval]) + 1))
        bars: list[Bar] = []
        end: int | None = None
        while len(bars) < want:
            params: dict[str, Any] = {
                "symbol": inst.symbol,
                "interval": bi,
                "limit": min(1000, want - len(bars)),
            }
            if end is not None:
                params["endTime"] = end
            try:
                rows = await self._get("/klines", params)
            except ProviderError as exc:
                if self._bad_symbol(exc):
                    raise NotFound(f"Binance has no symbol {inst.symbol}") from exc
                raise
            page = parse_klines(rows)
            if not page:
                break
            bars = page + bars
            end = page[0].t * 1000 - 1
            if len(page) < params["limit"]:
                break
        if not bars:
            raise NotFound(f"no klines for {inst.symbol}")
        return BarSeries(
            bars=bars, tz="UTC", utc_offset_s=0, as_of=datetime.fromtimestamp(bars[-1].t, UTC)
        )

    async def exchange_symbols(self) -> list[dict[str, Any]]:
        if self._symbols and time.time() - self._symbols_at < 24 * 3600:
            return self._symbols
        info = await self._get("/exchangeInfo", {"permissions": "SPOT"})
        self._symbols = [
            {k: s.get(k) for k in ("symbol", "status", "baseAsset", "quoteAsset")}
            for s in info.get("symbols", [])
            if s.get("status") == "TRADING" and s.get("quoteAsset") in CRYPTO_QUOTES
        ]
        self._symbols_at = time.time()
        return self._symbols

    async def search(self, query: str) -> list[SearchResult]:
        q = query.upper().replace("/", "").replace("-", "")
        syms = await self.exchange_symbols()
        hits = [s for s in syms if s["symbol"].startswith(q) or s["baseAsset"] == q]
        hits.sort(key=lambda s: (s["baseAsset"] != q, s["quoteAsset"] != "USDT", s["symbol"]))
        return [
            SearchResult(
                symbol=s["symbol"],
                name=f"{s['baseAsset']} / {s['quoteAsset']}",
                exchange="Binance",
                type="Crypto",
                asset_class=AssetClass.CRYPTO,
            )
            for s in hits[:8]
        ]

    async def profile(self, inst: Instrument) -> Profile:
        syms = await self.exchange_symbols()
        meta = next((s for s in syms if s["symbol"] == inst.symbol), None)
        if meta is None:
            raise NotFound(f"Binance has no trading symbol {inst.symbol}")
        q = await self.quote(inst)
        return Profile(
            symbol=inst.symbol,
            name=f"{meta['baseAsset']} / {meta['quoteAsset']}",
            asset_class=AssetClass.CRYPTO,
            quote_type="CRYPTO",
            exchange="Binance",
            currency=meta["quoteAsset"],
            week52_high=None,
            week52_low=None,
            extra={
                "base_asset": meta["baseAsset"],
                "quote_asset": meta["quoteAsset"],
                "status": meta["status"],
                "high_24h": q.high,
                "low_24h": q.low,
                "volume_24h_base": q.volume,
            },
        )
