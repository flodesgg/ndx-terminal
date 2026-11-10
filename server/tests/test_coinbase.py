"""Coinbase public WS, the crypto secondary (Phase 2 step 2.3): recorded ticker messages."""

from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime
from typing import Any

import pytest
from websockets.asyncio.server import ServerConnection, serve

from ndx_server.live import Client, LiveHub
from ndx_server.market import MarketService
from ndx_server.models import Quote
from ndx_server.providers.coinbase_ws import CoinbaseFeed, parse_ticker, product_id
from ndx_server.providers.router import ProviderRouter
from ndx_server.stream import SymbolFeed
from ndx_server.symbols import classify

from .helpers import FIXTURES, fixture

if not (FIXTURES / "coinbase_ws_ticker.json").exists():
    pytest.skip(
        "coinbase_ws_ticker.json: recorded provider response, not included", allow_module_level=True
    )
MESSAGES: list[dict[str, Any]] = fixture("coinbase_ws_ticker.json")


class FakeWS:
    async def send_text(self, _: str) -> None:  # pragma: no cover - not used
        return None


class OfflineCoinbase(CoinbaseFeed):
    run = SymbolFeed.run  # type: ignore[assignment]  # no network: the hub test only


def captured(feed: CoinbaseFeed) -> list[tuple[str, Quote, str, str | None]]:
    out: list[tuple[str, Quote, str, str | None]] = []
    feed.quote_sink = lambda _f, s, q, p, n: out.append((s, q, p, n))
    return out


def test_products_and_scope() -> None:
    assert product_id("BTCUSDT") == "BTC-USD" and product_id("SOLUSDC") == "SOL-USD"
    assert product_id("AAPL") is None
    feed = CoinbaseFeed()
    assert feed.accepts(classify("BTCUSD CURNCY")) and not feed.accepts(classify("AAPL"))
    assert not feed.accepts(classify("EURUSD"))


def test_parse_recorded_snapshot() -> None:
    t = MESSAGES[0]["events"][0]["tickers"][0]
    ts = datetime(2026, 11, 9, 18, 16, 45, tzinfo=UTC)
    q = parse_ticker(t, "BTCUSDT", ts)
    assert q is not None and q.price == 74641.44 and q.currency == "USD"
    assert q.change_pct == pytest.approx(-1.58358502828297)
    # 24 h change in price units from the stated %: price - price / (1 + pct/100)
    assert q.change == pytest.approx(74641.44 - 74641.44 / (1 - 0.0158358502828297))
    assert (q.low, q.high, q.bid, q.ask) == (73477.0, 75873.07, 74641.44, 74641.45)
    assert q.volume == pytest.approx(10243.20026362) and q.prev_close is None
    assert parse_ticker({"product_id": "BTC-USD"}, "BTCUSDT", ts) is None  # no price, no quote


def test_handle_emits_only_carried_symbols_with_the_usd_note() -> None:
    feed = CoinbaseFeed()
    feed.symbols = {"BTCUSDT"}
    got = captured(feed)
    for m in MESSAGES:
        feed.handle(m)
    assert {s for s, *_ in got} == {"BTCUSDT"}  # ETH-USD updates are not ours
    _sym, q, product, note = got[0]
    assert product == "BTC-USD" and note == "Coinbase BTC-USD: quoted in USD, not USDT"
    assert q.ts is not None and q.ts.isoformat().startswith("2026-11-09T18:16:45.911195")


async def test_feed_protocol_against_a_local_server() -> None:
    received: list[dict[str, Any]] = []
    done = asyncio.Event()

    async def handler(ws: ServerConnection) -> None:
        async for raw in ws:
            msg = json.loads(raw)
            received.append(msg)
            if msg.get("channel") == "heartbeats":
                for m in MESSAGES:
                    await ws.send(json.dumps(m))
            if msg.get("type") == "unsubscribe":
                done.set()

    async with serve(handler, "127.0.0.1", 0) as server:
        port = server.sockets[0].getsockname()[1]
        feed = CoinbaseFeed(f"ws://127.0.0.1:{port}")
        feed.cap = 5
        got = captured(feed)
        feed.set_symbols({"BTCUSDT", "ETHUSDT"})
        for _ in range(100):
            if len(got) >= 4:
                break
            await asyncio.sleep(0.02)
        assert feed.state == "connected"
        assert received[0] == {
            "type": "subscribe",
            "product_ids": ["BTC-USD", "ETH-USD"],
            "channel": "ticker",
        }
        assert received[1] == {"type": "subscribe", "channel": "heartbeats"}
        assert {s for s, *_ in got} == {"BTCUSDT", "ETHUSDT"}
        feed.set_symbols({"BTCUSDT"})
        await asyncio.wait_for(done.wait(), 2)
        assert received[-1] == {
            "type": "unsubscribe",
            "product_ids": ["ETH-USD"],
            "channel": "ticker",
        }
        await feed.stop()


async def test_hub_moves_crypto_to_coinbase_while_binance_fails(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    hub = LiveHub(MarketService(ProviderRouter([])), stream_crypto=True)
    monkeypatch.setattr(hub.binance, "set_wanted", lambda streams: None)  # no network
    hub.feeds.clear()
    feed = OfflineCoinbase()
    hub.add_feed(feed)
    c = Client(FakeWS())  # type: ignore[arg-type]
    await hub._subscribe(c, ["quote:BTCUSDT", "quote:AAPL"], "focus")
    assert feed.symbols == set()  # Binance streams crypto
    hub.binance._set_failing(True)
    assert feed.symbols == {"BTCUSDT"} and "BTCUSDT" not in hub._poll_symbols()
    feed.handle(MESSAGES[0])
    msg = json.loads(c.queue.get_nowait())
    assert msg["data"]["price"] == 74641.44 and msg["meta"]["source"] == "Coinbase"
    assert msg["meta"]["tag"] == "RT" and msg["meta"]["provider_symbol"] == "BTC-USD"
    assert "quoted in USD" in msg["meta"]["note"]
    hub.binance._set_failing(False)  # Binance is back: Coinbase lets go
    assert feed.symbols == set()
    await hub.stop()


def test_hub_without_network_streams_has_no_coinbase() -> None:
    hub = LiveHub(MarketService(ProviderRouter([])), stream_crypto=False)  # DEMO
    assert hub.feeds == []
