from __future__ import annotations

import asyncio
import json

import pytest
from fastapi.testclient import TestClient

from ndx_server.config import Settings
from ndx_server.live import Client, LiveHub, parse_topic
from ndx_server.market import MarketService
from ndx_server.providers.router import ProviderRouter
from ndx_server.symbols import SymbolError

from .conftest import make_client
from .fakes import FakeEquity


def test_parse_topic() -> None:
    assert parse_topic("quote:aapl") == ("quote", "AAPL", None)
    assert parse_topic("bar:BTCUSDT:1m") == ("bar", "BTCUSDT", "1m")
    with pytest.raises(SymbolError):
        parse_topic("bar:BTCUSDT:7m")
    with pytest.raises(SymbolError):
        parse_topic("nonsense")


class FakeWS:
    async def send_text(self, _: str) -> None:  # pragma: no cover - not used
        return None


async def test_binance_messages_fan_out_to_subscribers() -> None:
    hub = LiveHub(MarketService(ProviderRouter([])))
    client = Client(FakeWS())  # type: ignore[arg-type]
    await hub._subscribe(client, ["quote:BTCUSDT", "bar:BTCUSDT:1m"])
    assert hub.binance.wanted == {"btcusdt@ticker", "btcusdt@kline_1m"}
    hub.on_binance("btcusdt@ticker", {"s": "BTCUSDT", "c": "100", "E": 1700000000000})
    hub.on_binance(
        "btcusdt@kline_1m",
        {
            "E": 1700000000000,
            "k": {
                "s": "BTCUSDT",
                "i": "1m",
                "t": 1700000000000,
                "o": "1",
                "h": "2",
                "l": "0.5",
                "c": "1.5",
                "v": "3",
                "x": False,
            },
        },
    )
    msgs = [json.loads(client.queue.get_nowait()) for _ in range(client.queue.qsize())]
    assert [m["type"] for m in msgs] == ["quote", "bar"]
    assert msgs[0]["meta"]["latency"] == "REALTIME" and msgs[1]["interval"] == "1m"
    hub._unsubscribe(client, list(client.topics))
    assert hub.binance.wanted == set()
    await hub.stop()


def test_ws_endpoint_snapshot(settings: Settings) -> None:
    # Auth probes live in test_security.py.
    with make_client(settings, [FakeEquity()]) as c:
        protos = ["ndx.v1", f"ndx-token.{settings.token}"]
        with c.websocket_connect("ws://127.0.0.1/ws", subprotocols=protos) as ws:
            ws.send_text(json.dumps({"op": "sub", "topics": ["quote:AAPL", "quote:$$"]}))
            got = [json.loads(ws.receive_text()) for _ in range(2)]
            types = sorted(m["type"] for m in got)
            assert types == ["error", "quote"]
            q = next(m for m in got if m["type"] == "quote")
            assert q["data"]["price"] == 200.0 and q["meta"]["source"] == "Fake Equities"


def test_client_queue_drops_when_full() -> None:
    c = Client(FakeWS())  # type: ignore[arg-type]
    for _ in range(2100):
        c.send("x")
    assert c.dropped == 100


def test_providers_endpoint_lists_live_feed(client: TestClient) -> None:
    names = [p["name"] for p in client.get("/providers").json()]
    assert "binance-ws" in names


def test_every_new_fetch_is_sent_even_if_unchanged() -> None:
    # Review 1a #5: a 10 s resend timer skipped every other 10 s poll, so unchanged quotes
    # aged past stale_after_s (16 s) and flickered to STALE although every poll succeeded.
    hub = LiveHub(MarketService(ProviderRouter([])))
    sig = (100.0, None, None, None, 1700000000, None, "CLOSED")
    assert hub._should_send("quote:AAPL", sig, "2026-11-09T10:00:00Z")
    assert not hub._should_send("quote:AAPL", sig, "2026-11-09T10:00:00Z")  # cache hit
    assert hub._should_send("quote:AAPL", sig, "2026-11-09T10:00:10Z")  # new fetch, same values


class RecordingMarket:
    """Records snapshot batches; answers with no items."""

    def __init__(self) -> None:
        self.batches: list[list[str]] = []

    async def quotes(self, symbols: list[str]) -> object:
        self.batches.append(list(symbols))

        class Res:
            items: list[object] = []

        return Res()


async def test_closed_client_leaves_no_topic_behind() -> None:
    # Review 2 H1: subscriptions in the UI's spelling (NOVOB DC EQUITY) stayed polled after
    # the socket closed, because the cleanup passed internal names (NOVO-B.CO).
    hub = LiveHub(RecordingMarket())  # type: ignore[arg-type]
    client = Client(FakeWS())  # type: ignore[arg-type]
    hub.clients.add(client)
    await hub._subscribe(client, ["quote:NOVOB DC EQUITY", "quote:AAPL US EQUITY", "quote:AAPL"])
    assert set(hub.subs) == {"quote:NOVO-B.CO", "quote:AAPL"}
    hub._drop_client(client)
    assert dict(hub.subs) == {} and hub._poll_symbols() == []
    assert client not in hub.clients
    await hub.stop()


async def test_a_burst_of_subs_is_one_snapshot_and_skips_closed_rows() -> None:
    # Review 2 M2: one `sub` message per MON row made one snapshot batch per row.
    market = RecordingMarket()
    hub = LiveHub(market)  # type: ignore[arg-type]
    client = Client(FakeWS())  # type: ignore[arg-type]
    for t in ["quote:NOVOB DC EQUITY", "quote:DSV DC EQUITY", "quote:MAERSKB DC EQUITY"]:
        await hub._subscribe(client, [t])
    hub._unsubscribe(client, ["quote:DSV DC EQUITY"])
    await asyncio.sleep(0.1)
    assert market.batches == [["NOVO-B.CO", "MAERSK-B.CO"]]
    # A pending snapshot goes with the connection.
    await hub._subscribe(client, ["quote:GMAB DC EQUITY"])
    task = client.snap_task
    hub._drop_client(client)
    await asyncio.sleep(0.1)
    assert task is not None and task.cancelled() and len(market.batches) == 1
    await hub.stop()
