"""Tiingo 24x5 stream, the US live secondary (Phase 2 step 2.6): recorded messages."""

from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest
from websockets.asyncio.server import ServerConnection, serve

from ndx_server.live import Client, LiveHub
from ndx_server.market import MarketService
from ndx_server.providers.finnhub_ws import FinnhubFeed
from ndx_server.providers.quota import MonthlyBytes, MonthlySymbols
from ndx_server.providers.router import ProviderRouter
from ndx_server.providers.tiingo_ws import NOTE, TiingoFeed, parse_time, parse_update
from ndx_server.stream import SymbolFeed
from ndx_server.symbols import classify

from .helpers import fixture

# Shape and timing recorded 2026-11-09 13:52 ET at thresholdLevel 4; values synthetic (P13).
MESSAGES: list[dict[str, Any]] = fixture("tiingo_ws_level4.json")
UPDATES = [m for m in MESSAGES if m.get("messageType") == "A"]
# A subscription change on an open connection: acknowledged, then closed by the server.
RESUBSCRIBE: list[dict[str, Any]] = fixture("tiingo_ws_resubscribe.json")
KEY = "test-key-456"


class FakeWS:
    async def send_text(self, _: str) -> None:  # pragma: no cover - not used
        return None


class OfflineTiingo(TiingoFeed):
    run = SymbolFeed.run  # no network: hub tests only


class OfflineFinnhub(FinnhubFeed):
    run = SymbolFeed.run


class Clock:
    def __init__(self, now: datetime) -> None:
        self.now = now

    def __call__(self) -> datetime:
        return self.now


Tick = tuple[str, float, datetime | None, dict[str, float | None] | None]


def captured(feed: TiingoFeed) -> list[Tick]:
    out: list[Tick] = []
    feed.sink = lambda _f, s, p, ts, _v, b: out.append((s, p, ts, b))
    return out


def test_time_with_nanoseconds_and_offset() -> None:
    ts = parse_time("2026-11-09T13:52:02.581744471-05:00")
    assert ts == datetime(2026, 11, 9, 18, 52, 2, 581744, tzinfo=UTC)
    assert parse_time("not a time") is None and parse_time(None) is None


def test_level4_update_is_reference_price_and_estimated_book() -> None:
    first = UPDATES[0]["data"]
    assert first[1] == "spy" and len(first) == 8
    upd = parse_update(first)
    assert upd is not None
    ticker, price, _ts, book = upd
    assert ticker == "spy" and price == first[5]  # index 5: the reference price
    assert book == {
        "bid": first[4],
        "ask": first[6],
        "bid_size": first[3],
        "ask_size": first[7],
    }
    assert book["bid"] is not None and book["ask"] is not None
    assert book["bid"] <= price <= book["ask"]
    # level 6 carries the reference price only
    lvl6 = parse_update(["2026-11-09T13:48:41.824769615-05:00", "aapl", 350.325])
    assert lvl6 is not None and lvl6[1] == 350.325 and lvl6[3] == {}
    assert parse_update(["2026-11-09T13:48:41-05:00", "aapl", 0]) is None  # no price, no tick


def test_replay_shows_newest_update_per_symbol_and_counts_control_messages() -> None:
    feed = TiingoFeed(KEY)
    feed.symbols = {"SPY", "AAPL", "MSFT"}
    got = captured(feed)
    for m in MESSAGES:
        feed.handle(m)
    assert feed.subscription_id == MESSAGES[0]["data"]["subscriptionId"]
    assert feed.heartbeats == 1
    assert {s for s, *_ in got} == {"SPY", "AAPL", "MSFT"}
    last: dict[str, datetime] = {}
    for sym, _p, ts, _b in got:
        assert ts is not None and ts >= last.get(sym, ts)
        last[sym] = ts
    # the recording has one update older than one before it: dropped, not shown
    assert len(got) == len(UPDATES) - 1


def test_error_response_is_recorded_without_the_key() -> None:
    feed = TiingoFeed(KEY)
    feed.handle({"messageType": "I", "response": {"code": 401, "message": "Unauthorized"}})
    assert feed.last_error == "Tiingo: Unauthorized" and feed.errors == 1
    feed.record_error(RuntimeError(f"bad authorization {KEY}"))
    assert feed.last_error is not None and KEY not in feed.last_error


def test_scope_and_spelling() -> None:
    feed = TiingoFeed(KEY)
    assert feed.accepts(classify("BRK-B")) and feed.provider_symbol("BRK-B") == "brk-b"
    assert not feed.accepts(classify("NOVO-B.CO")) and not feed.accepts(classify("EURUSD"))
    assert not TiingoFeed("").accepts(classify("AAPL"))


# ----- plan allowances -----


def test_monthly_unique_symbols_persist_and_roll(tmp_path: Path) -> None:
    clock = Clock(datetime(2026, 11, 30, 23, 0, tzinfo=UTC))
    ledger = MonthlySymbols("tiingo", 3, tmp_path, clock)
    assert ledger.admit({"A", "B"}) == {"A", "B"}
    assert ledger.admit({"A", "C", "D"}) == {"A", "C"}  # D: no room left this month
    again = MonthlySymbols("tiingo", 3, tmp_path, clock)  # after a restart
    assert again.used == 3 and again.admit({"D", "B"}) == {"B"}
    clock.now = datetime(2026, 12, 1, 0, 1, tzinfo=UTC)
    assert again.admit({"D"}) == {"D"} and again.used == 1
    assert "123" not in (tmp_path / "symbols_month.json").read_text()  # names only


def test_monthly_bytes_persist_and_roll(tmp_path: Path) -> None:
    clock = Clock(datetime(2026, 11, 9, 12, 0, tzinfo=UTC))
    traffic = MonthlyBytes("tiingo", 1000, tmp_path, clock)
    traffic.add(400)
    traffic.flush()
    assert MonthlyBytes("tiingo", 1000, tmp_path, clock).used == 400
    traffic.add(700)
    assert traffic.left == 0
    clock.now = datetime(2026, 12, 1, 0, 0, tzinfo=UTC)
    assert traffic.used == 0


def test_feed_takes_only_what_the_month_allows(tmp_path: Path) -> None:
    feed = OfflineTiingo(KEY, tmp_path)
    feed.month.limit = 2
    feed.set_symbols({"AAPL", "MSFT", "SPY"})
    assert feed.symbols == {"AAPL", "MSFT"}  # SPY stays with the poller
    feed.traffic.limit = 0  # data budget spent
    feed.set_symbols({"AAPL"})
    assert feed.symbols == set()
    assert "this month" in (feed.status().detail or "")


# ----- connection -----


async def test_symbol_change_reconnects_with_the_whole_new_list() -> None:
    """Tiingo closes a connection whose subscription changes (recorded): the feed opens a
    new one with the new list instead of sending a change."""
    assert RESUBSCRIBE[-1]["_closed"].startswith("ConnectionClosedOK")
    subs: list[dict[str, Any]] = []
    second = asyncio.Event()

    async def handler(ws: ServerConnection) -> None:
        async for raw in ws:
            msg = json.loads(raw)
            subs.append(msg)
            await ws.send(json.dumps(MESSAGES[0]))  # I: subscriptionId
            await ws.send(json.dumps(MESSAGES[1]))  # H
            for m in UPDATES[:20]:
                await ws.send(json.dumps(m))
            if len(subs) == 2:
                second.set()

    async with serve(handler, "127.0.0.1", 0) as server:
        port = server.sockets[0].getsockname()[1]
        feed = TiingoFeed(KEY, url=f"ws://127.0.0.1:{port}", reconnect_gap_s=0.2)
        got = captured(feed)
        feed.set_symbols({"SPY", "AAPL"})
        for _ in range(200):
            if got:
                break
            await asyncio.sleep(0.02)
        assert feed.state == "connected" and feed.heartbeats >= 1
        assert subs[0] == {
            "eventName": "subscribe",
            "authorization": KEY,
            "eventData": {"thresholdLevel": 4, "tickers": ["aapl", "spy"]},
        }
        feed.set_symbols({"SPY", "MSFT"})
        await asyncio.wait_for(second.wait(), 3)
        assert subs[1]["eventData"]["tickers"] == ["msft", "spy"]
        assert all("subscriptionId" not in s["eventData"] for s in subs)
        assert feed.connects.quota().used == 2
        await feed.stop()


async def test_hourly_connection_budget_is_respected() -> None:
    feed = TiingoFeed(KEY, url="ws://127.0.0.1:9")  # never reached
    while await feed.connects.acquire(max_wait=0):
        pass
    feed.set_symbols({"SPY"})
    for _ in range(50):
        if feed.state == "down":
            break
        await asyncio.sleep(0.01)
    assert feed.state == "down" and "hourly connection budget" in (feed.detail or "")
    await feed.stop()


# ----- hub -----


async def test_hub_gives_tiingo_what_finnhub_cannot_carry() -> None:
    hub = LiveHub(MarketService(ProviderRouter([])), stream_crypto=False)
    finnhub = OfflineFinnhub("k")
    finnhub.cap = 1
    tiingo = OfflineTiingo(KEY)
    hub.add_feed(finnhub)
    hub.add_feed(tiingo)
    c = Client(FakeWS())  # type: ignore[arg-type]
    await hub._subscribe(c, ["quote:AAPL"], "focus")
    await hub._subscribe(c, ["quote:SPY"], "other")
    assert finnhub.symbols == {"AAPL"} and tiingo.symbols == {"SPY"}
    assert hub._poll_symbols() == []
    tiingo.handle(UPDATES[0])  # spy
    msg = json.loads(c.queue.get_nowait())
    data, meta = msg["data"], msg["meta"]
    assert data["price"] == UPDATES[0]["data"][5] and data["bid"] == UPDATES[0]["data"][4]
    assert data["ask"] == UPDATES[0]["data"][6]
    assert meta["tag"] == "RT·REF" and meta["source"] == "Tiingo" and meta["note"] == NOTE
    assert meta["provider_symbol"] == "spy" and meta["stale_after_s"] == 60
    await hub.stop()


@pytest.mark.parametrize("key", ["", KEY])
def test_without_a_key_the_feed_takes_nothing(key: str) -> None:
    feed = TiingoFeed(key)
    assert feed.accepts(classify("SPY")) is bool(key)
