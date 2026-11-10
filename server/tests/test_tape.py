"""Time & sales for Q (SPEC §8 `Q`: "time & sales when a real-time feed exists"): every print
of a real trade feed reaches the `trades:<SYMBOL>` topic, none is merged away; a feed that
carries no prints (a reference price) never fills the tape."""

from __future__ import annotations

import json
from typing import Any

from ndx_server.live import TAPE_KEEP, Client, LiveHub, parse_topic
from ndx_server.market import MarketService
from ndx_server.providers.finnhub_ws import FinnhubFeed
from ndx_server.providers.router import ProviderRouter
from ndx_server.stream import SymbolFeed

KEY = "test-key-123"


class FakeWS:
    async def send_text(self, _: str) -> None:  # pragma: no cover - not used
        return None


class OfflineFinnhub(FinnhubFeed):
    run = SymbolFeed.run  # no network


def drain(c: Client) -> list[dict[str, Any]]:
    out = []
    while not c.queue.empty():
        raw = c.queue.get_nowait()
        if raw:
            out.append(json.loads(raw))
    out += [json.loads(m) for m in c.pending.values()]
    c.pending.clear()
    return out


def test_trades_topic() -> None:
    assert parse_topic("trades:aapl") == ("trades", "AAPL", None)


def test_finnhub_hands_over_every_print_in_time_order() -> None:
    feed = FinnhubFeed(KEY)
    feed.symbols = {"AAPL"}
    prints: list[tuple[str, float, float | None]] = []
    feed.trade_sink = lambda _f, s, p, _ts, v: prints.append((s, p, v))
    feed.sink = lambda *_a: None
    feed.handle(
        {
            "type": "trade",
            "data": [
                {"s": "AAPL", "p": 231.02, "t": 1794249640600, "v": 5},
                {"s": "AAPL", "p": 231.00, "t": 1794249640500, "v": 100},
                {"s": "AAPL", "p": 231.01, "t": 1794249640550, "v": 0},  # price update
                {"s": "MSFT", "p": 512.0, "t": 1794249640500, "v": 7},  # not ours
            ],
        }
    )
    assert prints == [("AAPL", 231.00, 100.0), ("AAPL", 231.02, 5.0)]


async def test_hub_publishes_the_recent_window_with_sequence_numbers() -> None:
    hub = LiveHub(MarketService(ProviderRouter([])), stream_crypto=False)
    feed = OfflineFinnhub(KEY)
    hub.add_feed(feed)
    c = Client(FakeWS())  # type: ignore[arg-type]
    await hub._subscribe(c, ["quote:AAPL", "trades:AAPL"], "focus")
    assert feed.symbols == {"AAPL"}
    rows = [
        {"s": "AAPL", "p": 230.0 + i / 100, "t": 1794249640000 + i, "v": 1 + i} for i in range(3)
    ]
    feed.handle({"type": "trade", "data": rows})
    tapes = [m for m in drain(c) if m["type"] == "trades"]
    assert tapes, "no trades message"
    last = tapes[-1]
    assert last["symbol"] == "AAPL" and [p["size"] for p in last["prints"]] == [1, 2, 3]
    seqs = [p["seq"] for p in last["prints"]]
    assert seqs == sorted(seqs) and len(set(seqs)) == 3
    assert last["meta"]["source"] == "Finnhub (stream)" and last["meta"]["tag"] == "RT·TRD"
    # Only the last TAPE_KEEP prints travel; the sequence shows what a client missed.
    many = [{"s": "AAPL", "p": 230.0, "t": 1794249650000 + i, "v": 1} for i in range(TAPE_KEEP + 5)]
    feed.handle({"type": "trade", "data": many})
    last = [m for m in drain(c) if m["type"] == "trades"][-1]
    assert len(last["prints"]) == TAPE_KEEP
    assert last["prints"][-1]["seq"] - last["prints"][0]["seq"] == TAPE_KEEP - 1
    await hub.stop()


async def test_no_tape_without_a_subscriber() -> None:
    hub = LiveHub(MarketService(ProviderRouter([])), stream_crypto=False)
    feed = OfflineFinnhub(KEY)
    hub.add_feed(feed)
    c = Client(FakeWS())  # type: ignore[arg-type]
    await hub._subscribe(c, ["quote:AAPL"], "focus")
    feed.handle({"type": "trade", "data": [{"s": "AAPL", "p": 1.0, "t": 1794249640000, "v": 1}]})
    assert all(m["type"] != "trades" for m in drain(c))
    await hub.stop()


async def test_binance_aggregate_trades_feed_the_crypto_tape() -> None:
    hub = LiveHub(MarketService(ProviderRouter([])))
    c = Client(FakeWS())  # type: ignore[arg-type]
    await hub._subscribe(c, ["quote:BTCUSDT", "trades:BTCUSDT"])
    assert hub.binance.wanted == {"btcusdt@ticker", "btcusdt@aggTrade"}
    hub.on_binance(
        "btcusdt@aggTrade",
        {"e": "aggTrade", "s": "BTCUSDT", "p": "104250.5", "q": "0.012", "T": 1794249640000},
    )
    tape = [m for m in drain(c) if m["type"] == "trades"][-1]
    assert tape["prints"][0]["price"] == 104250.5 and tape["prints"][0]["size"] == 0.012
    assert tape["meta"]["source"] == "Binance (stream)" and tape["meta"]["latency"] == "REALTIME"
    hub._unsubscribe(c, list(c.topics))
    assert hub.binance.wanted == set()
    await hub.stop()
