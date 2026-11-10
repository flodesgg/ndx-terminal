"""Streaming hub (SPEC §6.3): symbol caps with priority and rotation, tick coalescing, one WS."""

from __future__ import annotations

import json
from datetime import UTC, datetime

from ndx_server.live import FLUSH_S, Client, LiveHub
from ndx_server.market import MarketService
from ndx_server.models import AssetClass, Instrument, Quote
from ndx_server.providers.router import ProviderRouter
from ndx_server.stream import FOCUS, OTHER, WATCH, SymbolFeed, allocate


class FakeWS:
    async def send_text(self, _: str) -> None:  # pragma: no cover - not used
        return None


class FakeFeed(SymbolFeed):
    name = "fakefeed"
    label = "Fake Feed"
    venue = "TRD"

    def __init__(self, cap: int) -> None:
        super().__init__()
        self.cap = cap
        self.history: list[set[str]] = []

    def accepts(self, inst: Instrument) -> bool:
        return inst.asset_class is AssetClass.EQUITY

    def on_symbols(self, symbols: set[str]) -> None:
        self.history.append(set(symbols))


def test_allocate_focus_then_watch_then_rotation() -> None:
    wanted = {"A": FOCUS, "B": WATCH, "C": OTHER, "D": OTHER, "E": OTHER}
    assert allocate(wanted, 3, 0) == {"A", "B", "C"}
    assert allocate(wanted, 3, 1) == {"A", "B", "D"}
    assert allocate(wanted, 3, 2) == {"A", "B", "E"}
    assert allocate(wanted, 3, 3) == {"A", "B", "C"}
    # more focused symbols than slots: focus only, nothing else
    assert allocate({"A": FOCUS, "B": FOCUS, "C": WATCH}, 2, 0) == {"A", "B"}
    assert allocate(wanted, 10, 5) == set(wanted)
    assert allocate(wanted, 0, 0) == set()


def _hub(feed: SymbolFeed) -> LiveHub:
    hub = LiveHub(MarketService(ProviderRouter([])), stream_crypto=False)
    hub.add_feed(feed)
    return hub


async def test_caps_follow_priority_across_clients() -> None:
    feed = FakeFeed(cap=2)
    hub = _hub(feed)
    c1, c2 = Client(FakeWS()), Client(FakeWS())  # type: ignore[arg-type]
    await hub._subscribe(c1, ["quote:AAPL"], "focus")
    await hub._subscribe(c1, ["quote:MSFT", "quote:NVDA"], "other")
    await hub._subscribe(c2, ["quote:NVDA"], "watch")
    assert feed.symbols == {"AAPL", "NVDA"}
    assert "MSFT" in hub._poll_symbols() and "AAPL" not in hub._poll_symbols()
    # the watchlist client leaves: NVDA falls back to "other" and competes with MSFT
    hub._unsubscribe(c2, ["quote:NVDA"])
    assert feed.symbols == {"AAPL", "MSFT"}
    # re-subscribing with a higher priority upgrades the topic
    await hub._subscribe(c1, ["quote:NVDA"], "focus")
    assert feed.symbols == {"AAPL", "NVDA"}
    await hub.stop()


async def test_the_rest_rotates_through_free_slots() -> None:
    feed = FakeFeed(cap=2)
    hub = _hub(feed)
    c = Client(FakeWS())  # type: ignore[arg-type]
    await hub._subscribe(c, ["quote:AAPL"], "focus")
    await hub._subscribe(c, ["quote:MSFT", "quote:NVDA", "quote:TSLA"], "other")
    seen = [set(feed.symbols)]
    for _ in range(3):
        hub.rotate()
        seen.append(set(feed.symbols))
    assert seen == [{"AAPL", "MSFT"}, {"AAPL", "NVDA"}, {"AAPL", "TSLA"}, {"AAPL", "MSFT"}]
    assert all("AAPL" in s for s in seen)
    await hub.stop()


async def test_non_stream_symbols_are_not_given_to_the_feed() -> None:
    feed = FakeFeed(cap=5)
    hub = _hub(feed)
    c = Client(FakeWS())  # type: ignore[arg-type]
    await hub._subscribe(c, ["quote:AAPL", "quote:EURUSD"], "focus")
    assert feed.symbols == {"AAPL"}
    await hub.stop()


async def test_ticks_merge_into_the_snapshot_with_realtime_provenance() -> None:
    feed = FakeFeed(cap=5)
    hub = _hub(feed)
    c = Client(FakeWS())  # type: ignore[arg-type]
    await hub._subscribe(c, ["quote:AAPL"], "focus")
    hub._rest_base["AAPL"] = Quote(symbol="AAPL", price=100.0, prev_close=100.0, name="Apple")
    ts = datetime(2026, 11, 9, 15, 0, tzinfo=UTC)
    feed.tick("AAPL", price=101.0, ts=ts, size=10)
    msg = json.loads(c.queue.get_nowait())
    assert msg["type"] == "quote" and msg["data"]["price"] == 101.0
    assert msg["data"]["name"] == "Apple" and msg["data"]["change"] == 1.0
    assert abs(msg["data"]["change_pct"] - 1.0) < 1e-9
    assert msg["meta"]["tag"] == "RT·TRD" and msg["meta"]["source"] == "Fake Feed"
    assert msg["meta"]["as_of"].startswith("2026-11-09T15:00")
    assert feed.messages == 1 and feed.last_msg is not None
    await hub.stop()


def test_ticks_are_coalesced_per_topic() -> None:
    t = [0.0]
    c = Client(FakeWS(), clock=lambda: t[0])  # type: ignore[arg-type]
    for i in range(10):
        c.push("quote:AAPL", f"m{i}")
    c.push("quote:MSFT", "x0")
    sent = [c.queue.get_nowait() for _ in range(c.queue.qsize())]
    assert [m for m in sent if m] == ["m0", "x0"]  # leading edge goes at once
    assert c.due() == []  # nothing more within the window
    t[0] = FLUSH_S
    assert c.due() == ["m9"]  # only the latest of the burst
    assert c.due() == []
    # at most 1 / FLUSH_S messages per topic
    assert FLUSH_S >= 0.25
