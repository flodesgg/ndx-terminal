"""Tiingo 24x5 equity WebSocket: the US live secondary (SPEC §6.2), tag `RT·REF`.

docs/PROVIDERS.md §3.17: `wss://api.tiingo.com/equity/intraday`, free Starter plan, a price
Tiingo derives from the consolidated feed (not exchange prints). `thresholdLevel` 4 sends
`[time, ticker, lqSpread, lqBidSize, lqBidPrice, refPrice, lqAskPrice, lqAskSize]`, so one
subscription gives the reference price and Tiingo's *estimated* bid/ask.

Recorded with my key on 2026-11-09 13:48-13:53 ET (market open):
- `subscribe` answers `I` (code 200, `subscriptionId`) and an `H` heartbeat; unknown tickers are
  accepted silently; updates arrive several per second per busy name, a few out of time order;
- changing the subscription on an open connection (adding or removing tickers by
  `subscriptionId`) is acknowledged and then **the server closes the connection** (1005)
  ~0.15 s later, every time (three runs; client pings on or off); an unchanged connection
  stayed up for 65 s. So a change of symbols is a reconnect with the whole new list, and
  reconnects are paced (Starter counts 50 requests/hour; whether a WS connect counts is not
  documented, so each one takes a token from the hourly budget).

Starter terms (P13): values live in memory only. The plan also counts 500 unique symbols per
month: `MonthlySymbols` remembers which names were used (names only) and admits new ones only
while the month has room.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import re
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, ClassVar

from ..models import Instrument, ProviderStatus
from ..stream import SymbolFeed
from .budgets import BUDGETS
from .finnhub_ws import is_us_equity
from .quota import MonthlyBytes, MonthlySymbols

log = logging.getLogger("ndx.tiingo_ws")

URL = "wss://api.tiingo.com/equity/intraday"
THRESHOLD = 4  # reference price + estimated bid/ask in one message
CAP = 50  # self-imposed: per-connection ticker caps are not documented
MONTH_LIMIT = 450  # self-imposed, under Starter's 500 unique symbols/month
# Starter: 1 GB/month. Recorded level-4 traffic: ~1 KB/s for three busy names, so a whole
# 24x5 month of even a few names would exceed it; the feed stops at 900 MB (self-imposed).
MONTH_BYTES = 900_000_000
RECONNECT_GAP_S = 60.0  # self-imposed: a symbol change waits for this since the last connect
NOTE = "Tiingo reference price (derived by Tiingo, not exchange prints); bid/ask estimated"
_FRAC = re.compile(r"\.(\d+)")


def tiingo_symbol(symbol: str) -> str:
    """Internal US symbol -> Tiingo's ticker (lower case; share classes keep the dash)."""
    return symbol.lower()


def parse_time(raw: Any) -> datetime | None:
    """`2026-11-09T13:52:02.581744471-05:00` (nanoseconds) -> aware datetime in UTC."""
    if not isinstance(raw, str):
        return None
    s = _FRAC.sub(lambda m: "." + m.group(1)[:6], raw, count=1)
    try:
        dt = datetime.fromisoformat(s)
    except ValueError:
        return None
    return dt.astimezone(UTC) if dt.tzinfo else None


def _pos(v: Any) -> float | None:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if f > 0 else None


def parse_update(data: Any) -> tuple[str, float, datetime, dict[str, float | None]] | None:
    """(ticker, reference price, time, estimated book) of one `A` update, level 4 or 6."""
    if not isinstance(data, list) or len(data) < 3:
        return None
    ts = parse_time(data[0])
    ticker = str(data[1])
    if len(data) >= 8:
        price = _pos(data[5])
        book = {
            "bid": _pos(data[4]),
            "ask": _pos(data[6]),
            "bid_size": _pos(data[3]),
            "ask_size": _pos(data[7]),
        }
    else:  # level 6: reference price only
        price, book = _pos(data[2]), {}
    if ts is None or price is None:
        return None
    return ticker, price, ts, book


class BudgetSpent(Exception):
    pass


class TiingoFeed(SymbolFeed):
    name: ClassVar[str] = "tiingo-ws"
    label: ClassVar[str] = "Tiingo"
    venue: ClassVar[str | None] = "REF"
    note: ClassVar[str | None] = NOTE
    memory_only: ClassVar[bool] = True
    # Self-imposed: busy names update several times a second; a quiet name may not for a while.
    stale_after_s: ClassVar[float] = 60.0

    def __init__(
        self,
        api_key: str,
        data_dir: Path | None = None,
        url: str = URL,
        reconnect_gap_s: float = RECONNECT_GAP_S,
    ) -> None:
        super().__init__()
        self.api_key = api_key
        self.url = url
        self.cap = CAP
        self.reconnect_gap_s = reconnect_gap_s
        self.month = MonthlySymbols("tiingo", MONTH_LIMIT, data_dir)
        self.traffic = MonthlyBytes("tiingo", MONTH_BYTES, data_dir)
        self.connects = BUDGETS["tiingo"].bucket()
        self.heartbeats = 0
        self.subscription_id: int | None = None
        self._changed = asyncio.Event()
        self._last_ts: dict[str, datetime] = {}
        self._last_connect: float | None = None

    def accepts(self, inst: Instrument) -> bool:
        return bool(self.api_key) and is_us_equity(inst)

    def provider_symbol(self, symbol: str) -> str:
        return tiingo_symbol(symbol)

    def set_symbols(self, symbols: set[str]) -> None:
        # names beyond the month's unique-symbol or data allowance stay with the poller
        if self.traffic.left <= 0:
            symbols = set()
        super().set_symbols(self.month.admit(symbols) if symbols else set())

    def on_symbols(self, symbols: set[str]) -> None:
        self._changed.set()

    def record_error(self, exc: BaseException) -> None:
        super().record_error(exc)
        if self.api_key and self.last_error:
            self.last_error = self.last_error.replace(self.api_key, "<key>")

    def status(self) -> ProviderStatus:
        st = super().status()
        q = self.month.quota()
        mb = self.traffic.used / 1e6
        month = f"{q.used}/{q.limit} symbols, {mb:.0f}/{MONTH_BYTES / 1e6:.0f} MB this month"
        st.detail = f"{st.detail} · {month}" if st.detail else month
        return st

    # ----- messages -----

    def handle(self, msg: dict[str, Any]) -> None:
        kind = msg.get("messageType")
        if kind == "H":
            self.heartbeats += 1
            return
        if kind in ("I", "E"):
            resp = msg.get("response") or {}
            code = resp.get("code")
            if kind == "E" or (isinstance(code, int) and code >= 400):
                text = str(resp.get("message") or "error")[:200]
                self.last_error, self.last_error_at = f"Tiingo: {text}", datetime.now(UTC)
                self.errors += 1
                return
            data = msg.get("data")
            if isinstance(data, dict) and isinstance(data.get("subscriptionId"), int):
                self.subscription_id = data["subscriptionId"]
            return
        if kind != "A":
            return
        upd = parse_update(msg.get("data"))
        if upd is None:
            return
        ticker, price, ts, book = upd
        sym = next((s for s in self.symbols if tiingo_symbol(s) == ticker), None)
        if sym is None or (sym in self._last_ts and ts < self._last_ts[sym]):
            return  # not ours, or older than an update already shown
        self._last_ts[sym] = ts
        self.tick(sym, price, ts, None, book)

    # ----- connection -----

    def _subscribe_msg(self, symbols: set[str]) -> str:
        tickers = sorted(tiingo_symbol(s) for s in symbols)
        return json.dumps(
            {
                "eventName": "subscribe",
                "authorization": self.api_key,
                "eventData": {"thresholdLevel": THRESHOLD, "tickers": tickers},
            }
        )

    def _gap_left(self) -> float:
        if self._last_connect is None:
            return 0.0
        loop = asyncio.get_running_loop()
        return max(0.0, self._last_connect + self.reconnect_gap_s - loop.time())

    async def run(self) -> None:
        from websockets.asyncio.client import connect

        backoff = 5.0
        while True:
            if not self.symbols:
                self.traffic.flush()
                if self.state != "down" or self.traffic.left > 0:
                    self.state, self.detail = "idle", None
                self._changed.clear()
                await self._changed.wait()
                continue
            gap = self._gap_left()
            if gap > 0:
                await asyncio.sleep(gap)
                continue  # the wanted set may have changed (or emptied) meanwhile
            if not await self.connects.acquire(max_wait=0):
                self.state = "down"
                self.detail = "hourly connection budget spent; waiting"
                await asyncio.sleep(max(1.0, self.connects.wait_time()))
                continue
            self.state = "connecting"
            self._last_connect = asyncio.get_running_loop().time()
            try:
                # close_timeout: once the reader stops, a busy stream fills the incoming queue
                # and the server's close frame is not read; don't wait the default 10 s for it
                async with connect(
                    self.url, open_timeout=10, ping_interval=20, close_timeout=2
                ) as ws:
                    subscribed = set(self.symbols)
                    await ws.send(self._subscribe_msg(subscribed))
                    self.state, self.detail = "connected", None
                    reader = asyncio.create_task(self._read(ws))
                    try:
                        while not reader.done():
                            self._changed.clear()
                            waiter = asyncio.create_task(self._changed.wait())
                            await asyncio.wait(
                                {reader, waiter}, return_when=asyncio.FIRST_COMPLETED
                            )
                            waiter.cancel()
                            if reader.done() or set(self.symbols) == subscribed:
                                continue
                            # Tiingo drops the connection on any subscription change: keep
                            # streaming the old set until a reconnect is allowed, then
                            # reconnect with the whole new list.
                            await asyncio.wait({reader}, timeout=self._gap_left())
                            break
                    finally:
                        reader.cancel()
                        with contextlib.suppress(asyncio.CancelledError, Exception):
                            await reader
                    if reader.done() and not reader.cancelled():
                        exc = reader.exception()
                        raise exc if exc else ConnectionError("closed by Tiingo")
                backoff = 5.0
            except asyncio.CancelledError:
                raise
            except BudgetSpent as exc:
                self.record_error(exc)
                self.state, self.detail = "down", str(exc)
                continue  # no symbols now: waits idle until the hub assigns some again
            except Exception as exc:
                self.record_error(exc)
                self.state, self.detail = "down", self.last_error
                log.warning("tiingo ws error: %s (retry in %.0fs)", self.last_error, backoff)
                await asyncio.sleep(backoff)
                backoff = min(300.0, backoff * 2)

    async def _read(self, ws: Any) -> None:
        async for raw in ws:
            self.traffic.add(len(raw))
            if self.traffic.left <= 0:
                self.traffic.flush()
                self.symbols = set()  # hand everything back to the poller
                raise BudgetSpent("monthly data budget spent (900 MB of Starter's 1 GB)")
            try:
                msg = json.loads(raw)
                if isinstance(msg, dict):
                    self.handle(msg)
            except Exception as exc:  # a malformed message must not kill the feed
                log.warning("tiingo message error: %s", exc)
