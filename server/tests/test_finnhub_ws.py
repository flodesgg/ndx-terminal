"""Finnhub trade stream, the US live primary (Phase 2 step 2.5): recorded messages."""

from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime
from typing import Any

import pytest
from websockets.asyncio.server import ServerConnection, serve

from ndx_server.live import Client, LiveHub
from ndx_server.market import MarketService
from ndx_server.providers.finnhub_ws import FinnhubFeed, finnhub_symbol, trade_rows
from ndx_server.providers.router import ProviderRouter
from ndx_server.stream import SymbolFeed
from ndx_server.symbols import classify

from .helpers import FIXTURES, fixture

# Recorded 2026-11-09 13:40-13:41 ET with my key (not in the file): AAPL, MSFT, SPY.
if not (FIXTURES / "finnhub_ws_trades.json").exists():
    pytest.skip(
        "finnhub_ws_trades.json: recorded provider response, not included", allow_module_level=True
    )
MESSAGES: list[dict[str, Any]] = fixture("finnhub_ws_trades.json")
KEY = "test-key-123"


class FakeWS:
    async def send_text(self, _: str) -> None:  # pragma: no cover - not used
        return None


class OfflineFinnhub(FinnhubFeed):
    run = SymbolFeed.run  # no network: the hub test only


Tick = tuple[str, float, datetime | None, float | None]


def captured(feed: FinnhubFeed) -> list[Tick]:
    out: list[Tick] = []
    feed.sink = lambda _f, s, p, ts, v, _b: out.append((s, p, ts, v))
    return out


def newest_prints() -> dict[str, tuple[int, float]]:
    """Per symbol: the newest trade time in the recording and the price of a print at it."""
    best: dict[str, tuple[int, float]] = {}
    for m in MESSAGES:
        for s, p, t, _v in trade_rows(m):
            if s not in best or t >= best[s][0]:
                best[s] = (t, p)
    return best


def test_symbols_and_scope() -> None:
    assert finnhub_symbol("BRK-B") == "BRK.B" and finnhub_symbol("AAPL") == "AAPL"
    feed = FinnhubFeed(KEY)
    assert feed.accepts(classify("AAPL")) and feed.accepts(classify("BRK-B"))
    assert not feed.accepts(classify("NOVO-B.CO"))  # Copenhagen, not US
    assert not feed.accepts(classify("EURUSD")) and not feed.accepts(classify("BTCUSDT"))
    assert not FinnhubFeed("").accepts(classify("AAPL"))  # no key, no stream
    assert feed.provider_symbol("BRK-B") == "BRK.B"


def test_recording_has_the_documented_quirks() -> None:
    """docs/PROVIDERS.md §3.1: exact duplicate rows and rows out of time order."""
    rows = [(s, p, t, v) for m in MESSAGES for s, p, t, v in trade_rows(m)]
    assert len(rows) != len(set(rows))  # duplicates
    by_sym: dict[str, list[int]] = {}
    for s, _p, t, _v in rows:
        by_sym.setdefault(s, []).append(t)
    assert any(ts != sorted(ts) for ts in by_sym.values())  # out of order
    assert sum(m["type"] == "ping" for m in MESSAGES) == 1


def test_zero_size_rows_are_not_prints() -> None:
    msg = {"type": "trade", "data": [{"s": "AAPL", "p": 1.0, "t": 1, "v": 0}]}
    assert trade_rows(msg) == []
    assert trade_rows({"type": "trade", "data": [{"s": "AAPL"}]}) == []  # malformed: skipped


def test_shown_price_is_the_newest_print_never_an_older_late_one() -> None:
    feed = FinnhubFeed(KEY)
    feed.symbols = {"AAPL", "MSFT", "SPY"}
    got = captured(feed)
    for m in MESSAGES:
        feed.handle(m)
    last: dict[str, Tick] = {}
    for i, tick in enumerate(got):
        sym, _p, ts, _v = tick
        assert ts is not None
        if sym in last:  # each emitted print is no older than the one before it
            prev_ts = last[sym][2]
            assert prev_ts is not None and ts >= prev_ts, i
        last[sym] = tick
    for sym, (t, p) in newest_prints().items():
        _s, price, ts, _v = last[sym]
        assert ts == datetime.fromtimestamp(t / 1000, UTC) and price == p
    assert feed.pings == 1


def test_late_older_row_is_dropped() -> None:
    feed = FinnhubFeed(KEY)
    feed.symbols = {"AAPL"}
    got = captured(feed)
    row = {"s": "AAPL", "p": 2.0, "t": 2_000, "v": 1}
    feed.handle({"type": "trade", "data": [row]})
    feed.handle({"type": "trade", "data": [{**row, "p": 1.0, "t": 1_000}]})
    assert [p for _s, p, _t, _v in got] == [2.0]


def test_not_our_symbols_are_ignored_and_dotted_classes_map_back() -> None:
    feed = FinnhubFeed(KEY)
    feed.symbols = {"BRK-B"}
    got = captured(feed)
    feed.handle(MESSAGES[0])  # MSFT rows: not ours
    feed.handle({"type": "trade", "data": [{"s": "BRK.B", "p": 480.0, "t": 5, "v": 3}]})
    assert [(s, p) for s, p, _t, _v in got] == [("BRK-B", 480.0)]


def test_errors_never_keep_the_key() -> None:
    feed = FinnhubFeed(KEY)
    feed.record_error(RuntimeError(f"server rejected wss://ws.finnhub.io?token={KEY}"))
    assert feed.last_error is not None and KEY not in feed.last_error
    assert "<key>" in feed.last_error
    feed.handle({"type": "error", "msg": "Invalid symbol"})
    assert feed.last_error == "Finnhub: Invalid symbol" and feed.errors == 2


async def test_feed_protocol_against_a_local_server() -> None:
    received: list[dict[str, Any]] = []
    paths: list[str] = []
    done = asyncio.Event()

    async def handler(ws: ServerConnection) -> None:
        assert ws.request is not None
        paths.append(ws.request.path)
        async for raw in ws:
            msg = json.loads(raw)
            received.append(msg)
            if len(received) == 3:  # all three subscribed: replay the recording
                for m in MESSAGES:
                    await ws.send(json.dumps(m))
            if msg["type"] == "unsubscribe":
                done.set()

    async with serve(handler, "127.0.0.1", 0) as server:
        port = server.sockets[0].getsockname()[1]
        feed = FinnhubFeed(KEY, url=f"ws://127.0.0.1:{port}")
        got = captured(feed)
        feed.set_symbols({"AAPL", "MSFT", "SPY"})
        for _ in range(200):
            if feed.pings:
                break
            await asyncio.sleep(0.02)
        assert feed.state == "connected" and paths == [f"/?token={KEY}"]
        assert received[:3] == [{"type": "subscribe", "symbol": s} for s in ("AAPL", "MSFT", "SPY")]
        assert {s for s, *_ in got} == {"AAPL", "MSFT", "SPY"}
        feed.set_symbols({"AAPL", "MSFT"})
        await asyncio.wait_for(done.wait(), 2)
        assert received[-1] == {"type": "unsubscribe", "symbol": "SPY"}
        await feed.stop()


async def test_hub_streams_us_equities_with_trade_provenance() -> None:
    hub = LiveHub(MarketService(ProviderRouter([])), stream_crypto=False)
    feed = OfflineFinnhub(KEY)
    hub.add_feed(feed)
    c = Client(FakeWS())  # type: ignore[arg-type]
    await hub._subscribe(c, ["quote:BRK-B", "quote:NOVO-B.CO", "quote:EURUSD"], "focus")
    assert feed.symbols == {"BRK-B"}
    assert set(hub._poll_symbols()) == {"NOVO-B.CO", "EURUSD"}
    feed.handle({"type": "trade", "data": [{"s": "BRK.B", "p": 480.0, "t": 1794249640499, "v": 3}]})
    msg = json.loads(c.queue.get_nowait())
    assert msg["data"]["price"] == 480.0 and msg["meta"]["source"] == "Finnhub (stream)"
    assert msg["meta"]["tag"] == "RT·TRD" and msg["meta"]["provider_symbol"] == "BRK.B"
    assert msg["meta"]["stale_after_s"] == 120
    await hub.stop()
