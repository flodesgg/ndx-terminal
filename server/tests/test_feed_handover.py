"""Phase 2 step 2.8: streamed symbols keep a fresh REST snapshot under them, and a failing
feed hands its symbols to the next feed (Finnhub down -> Tiingo) or to the poller."""

from __future__ import annotations

import json
import time
from datetime import UTC, datetime
from typing import Any

from ndx_server.live import FLUSH_S, Client, LiveHub
from ndx_server.models import Latency, Meta, Quote, QuoteItem, QuotesResponse
from ndx_server.providers.finnhub_ws import FinnhubFeed
from ndx_server.providers.tiingo_ws import TiingoFeed
from ndx_server.stream import SymbolFeed


class FakeWS:
    async def send_text(self, _: str) -> None:  # pragma: no cover - not used
        return None


class OfflineFinnhub(FinnhubFeed):
    run = SymbolFeed.run


class OfflineTiingo(TiingoFeed):
    run = SymbolFeed.run


class FakeMarket:
    """REST snapshots by symbol; counts what was asked."""

    def __init__(self) -> None:
        self.quotes_by: dict[str, Quote] = {}
        self.asked: list[list[str]] = []

    async def quotes(self, symbols: list[str]) -> QuotesResponse:
        self.asked.append(list(symbols))
        meta = Meta(source="REST", latency=Latency.REALTIME, fetched_at=datetime.now(UTC))
        return QuotesResponse(
            items=[
                QuoteItem(symbol=s, data=self.quotes_by[s], meta=meta)
                if s in self.quotes_by
                else QuoteItem(symbol=s, error="N.A.")
                for s in symbols
            ]
        )


def hub_with(*feeds: SymbolFeed) -> tuple[LiveHub, FakeMarket]:
    market = FakeMarket()
    hub = LiveHub(market, stream_crypto=False)  # type: ignore[arg-type]
    for f in feeds:
        hub.add_feed(f)
    return hub, market


class Clocked:
    """A client whose coalescing window is driven by the test."""

    def __init__(self) -> None:
        self.t = 0.0
        self.client = Client(FakeWS(), clock=lambda: self.t)  # type: ignore[arg-type]

    def drain(self) -> list[dict[str, Any]]:
        """Everything sent so far, one window later (the coalescer holds a burst's tail)."""
        out = []
        while not self.client.queue.empty():
            raw = self.client.queue.get_nowait()
            if raw:
                out.append(json.loads(raw))
        self.t += FLUSH_S
        out += [json.loads(m) for m in self.client.due()]
        return out


async def test_tiingo_carries_us_equities_while_finnhub_is_down() -> None:
    finnhub, tiingo = OfflineFinnhub("k"), OfflineTiingo("t")
    hub, _ = hub_with(finnhub, tiingo)
    c = Client(FakeWS())  # type: ignore[arg-type]
    await hub._subscribe(c, ["quote:AAPL", "quote:MSFT"], "focus")
    assert finnhub.symbols == {"AAPL", "MSFT"} and tiingo.symbols == set()
    finnhub.state = "down"
    assert finnhub.failing and tiingo.symbols == {"AAPL", "MSFT"}
    assert finnhub.symbols == {"AAPL", "MSFT"}  # kept, so it reconnects with them
    assert hub._poll_symbols() == []
    finnhub.state = "connecting"  # a retry is not a recovery: no flapping
    assert tiingo.symbols == {"AAPL", "MSFT"}
    finnhub.state = "connected"
    assert not finnhub.failing and tiingo.symbols == set()
    await hub.stop()


async def test_a_failing_feed_without_a_fallback_leaves_its_symbols_to_the_poller() -> None:
    finnhub = OfflineFinnhub("k")
    hub, _ = hub_with(finnhub)
    c = Client(FakeWS())  # type: ignore[arg-type]
    await hub._subscribe(c, ["quote:AAPL"], "focus")
    assert hub._poll_symbols() == []
    finnhub.state = "down"
    assert hub._poll_symbols() == ["AAPL"]
    finnhub.state = "connected"
    assert hub._poll_symbols() == []
    await hub.stop()


async def test_book_fields_belong_to_the_feed_that_stated_them() -> None:
    """Tiingo's estimated bid/ask must not reappear under a later Finnhub print (RT·TRD)."""
    finnhub, tiingo = OfflineFinnhub("k"), OfflineTiingo("t")
    hub, _ = hub_with(finnhub, tiingo)
    finnhub.state = "down"
    cc = Clocked()
    await hub._subscribe(cc.client, ["quote:SPY"], "focus")
    hub._rest_base["SPY"] = Quote(symbol="SPY", price=300.0, prev_close=299.0)
    cc.drain()
    t0 = datetime(2026, 11, 9, 18, 52, tzinfo=UTC)
    tiingo.tick("SPY", 300.5, t0, None, {"bid": 300.4, "ask": 300.6})
    (tiingo_msg,) = cc.drain()
    finnhub.state = "connected"
    finnhub.tick("SPY", 300.7, t0.replace(second=1), 10)
    (finnhub_msg,) = cc.drain()
    assert tiingo_msg["meta"]["tag"] == "RT·REF" and tiingo_msg["data"]["bid"] == 300.4
    assert finnhub_msg["meta"]["tag"] == "RT·TRD" and finnhub_msg["data"]["price"] == 300.7
    assert finnhub_msg["data"]["bid"] is None and finnhub_msg["data"]["ask"] is None
    await hub.stop()


async def test_snapshot_under_a_streamed_symbol_is_refreshed_and_a_new_prev_close_applies(
    monkeypatch: Any,
) -> None:
    import ndx_server.live as live

    finnhub = OfflineFinnhub("k")
    hub, market = hub_with(finnhub)
    market.quotes_by["AAPL"] = Quote(symbol="AAPL", price=100.0, prev_close=100.0, name="Apple")
    cc = Clocked()
    await hub._subscribe(cc.client, ["quote:AAPL"], "focus")
    for t in list(hub._tasks):
        await t  # the initial snapshot
    finnhub.tick("AAPL", 102.0, datetime(2026, 11, 9, 20, 0, tzinfo=UTC), 5)
    cc.drain()
    asked = len(market.asked)
    await hub.refresh_fed_bases()
    assert len(market.asked) == asked  # not due yet: one refresh per BASE_REFRESH_S

    # Next morning: the REST snapshot has a new previous close (yesterday's close).
    market.quotes_by["AAPL"] = Quote(symbol="AAPL", price=101.0, prev_close=101.0, name="Apple")
    later = time.monotonic() + live.BASE_REFRESH_S + 1
    monkeypatch.setattr("ndx_server.live.time.monotonic", lambda: later)
    await hub.refresh_fed_bases()
    assert market.asked[-1] == ["AAPL"]
    (msg,) = cc.drain()
    assert msg["meta"]["source"] == "Finnhub (stream)" and msg["data"]["price"] == 102.0
    assert msg["data"]["prev_close"] == 101.0 and msg["data"]["change"] == 1.0
    await hub.stop()
