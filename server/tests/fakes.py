from __future__ import annotations

from datetime import UTC, datetime
from typing import ClassVar

from ndx_server.models import AssetClass, Bar, Instrument, Interval, Latency, Quote, SearchResult
from ndx_server.providers.base import BarSeries, Capability, DataProvider, NotFound
from ndx_server.providers.ratelimit import TokenBucket

NOW = datetime(2026, 11, 6, 20, 0, tzinfo=UTC)


class FakeEquity(DataProvider):
    name = "fakeeq"
    label = "Fake Equities"
    capabilities: ClassVar[dict[Capability, frozenset[AssetClass]]] = {
        Capability.QUOTE: frozenset({AssetClass.EQUITY, AssetClass.FX}),
        Capability.BARS: frozenset({AssetClass.EQUITY}),
        Capability.SEARCH: frozenset({AssetClass.EQUITY}),
    }
    prices: ClassVar[dict[str, float]] = {"AAPL": 200.0, "MSFT": 400.0, "EURUSD": 1.1, "SPY": 500.0}

    def __init__(self) -> None:
        super().__init__(TokenBucket(1000, 1000))
        self.batch_calls = 0

    def latency(self, asset: AssetClass) -> tuple[Latency, int | None]:
        return Latency.DELAYED, 15

    async def quote(self, inst: Instrument) -> Quote:
        if inst.symbol not in self.prices:
            raise NotFound(inst.symbol)
        return Quote(
            symbol=inst.symbol,
            price=self.prices[inst.symbol],
            ts=NOW,
            currency="USD",
            prev_close=self.prices[inst.symbol] * 0.99,
        )

    async def quotes(self, insts: list[Instrument]) -> dict[str, Quote]:
        self.batch_calls += 1
        return {
            i.symbol: Quote(
                symbol=i.symbol,
                price=self.prices[i.symbol],
                ts=NOW,
                currency="USD",
                prev_close=self.prices[i.symbol] * 0.99,
            )
            for i in insts
            if i.symbol in self.prices
        }

    async def bars(self, inst: Instrument, interval: Interval, lookback_days: int) -> BarSeries:
        if inst.symbol in ("AAPL", "MSFT", "SPY"):
            # 60 synthetic daily closes: MSFT moves 2x AAPL, SPY = AAPL -> beta/corr are known
            k = {"AAPL": 1.0, "MSFT": 2.0, "SPY": 1.0}[inst.symbol]
            closes = [100 * (1 + k * 0.01 * ((-1) ** d) * (d % 7) / 7) for d in range(60)]
            bars = [
                Bar(t=86400 * (19000 + d), o=c, h=c, l=c, c=c, v=1) for d, c in enumerate(closes)
            ]
        else:
            bars = [Bar(t=86400 * d, o=1, h=2, l=0.5, c=1.5, v=10) for d in range(1, 6)]
        return BarSeries(bars=bars, tz="America/New_York", utc_offset_s=-18000, as_of=NOW)

    async def search(self, query: str) -> list[SearchResult]:
        return [
            SearchResult(
                symbol="AAPL",
                name="Apple",
                exchange="NMS",
                type="Equity",
                asset_class=AssetClass.EQUITY,
            )
        ]


class FakeCrypto(DataProvider):
    name = "fakecrypto"
    label = "Fake Crypto"
    capabilities: ClassVar[dict[Capability, frozenset[AssetClass]]] = {
        Capability.QUOTE: frozenset({AssetClass.CRYPTO}),
    }

    def __init__(self) -> None:
        super().__init__(TokenBucket(1000, 1000))

    def latency(self, asset: AssetClass) -> tuple[Latency, int | None]:
        return Latency.REALTIME, None

    async def quote(self, inst: Instrument) -> Quote:
        return Quote(symbol=inst.symbol, price=50000.0, ts=NOW)
