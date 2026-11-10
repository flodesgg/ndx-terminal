"""Finnhub WebSocket trades: the US live primary (SPEC §6.2), tag `RT·TRD`.

docs/PROVIDERS.md §3.1: `wss://ws.finnhub.io?token=…`, free plan 50 symbols and one connection
per key; `{"type":"subscribe","symbol":"AAPL"}` / `unsubscribe`; `trade` messages carry rows
`{s, p, t (ms), v, c}`; rows with v=0 are price updates, not trades. Recorded with my
key on 2026-11-09 13:40-13:41 ET (market open): 60 rows in 45 s for AAPL, MSFT, SPY (SPY: one),
in bursts, with exact duplicates and rows out of time order; a `ping` now and then; no error for
an unknown symbol. So the free feed is a sparse sample of prints, not the full tape: the price
we show is the print with the newest trade time, never a later-arriving older one.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
from datetime import UTC, datetime
from typing import Any, ClassVar

from ..models import AssetClass, Instrument
from ..stream import SymbolFeed

log = logging.getLogger("ndx.finnhub_ws")

URL = "wss://ws.finnhub.io"
CAP = 50  # free plan
SEND_GAP_S = 0.05  # no documented control-message limit; stay gentle


def finnhub_symbol(symbol: str) -> str:
    """Internal US symbol -> Finnhub's (share classes use a dot: BRK-B -> BRK.B)."""
    return symbol.replace("-", ".")


def is_us_equity(inst: Instrument) -> bool:
    # Internal US listings carry no exchange suffix (NOVO-B.CO is Copenhagen, not US).
    return inst.asset_class is AssetClass.EQUITY and "." not in inst.symbol


def trade_rows(msg: dict[str, Any]) -> list[tuple[str, float, int, float]]:
    """(Finnhub symbol, price, trade time ms, size) of the real trades in a message."""
    if msg.get("type") != "trade":
        return []
    out: list[tuple[str, float, int, float]] = []
    for row in msg.get("data") or []:
        try:
            s, p, t, v = str(row["s"]), float(row["p"]), int(row["t"]), float(row["v"])
        except (KeyError, TypeError, ValueError):
            continue
        if v <= 0:  # v=0: a price update, not a print (RT·TRD shows prints only)
            continue
        out.append((s, p, t, v))
    return out


class FinnhubFeed(SymbolFeed):
    name: ClassVar[str] = "finnhub-ws"
    label: ClassVar[str] = "Finnhub (stream)"
    venue: ClassVar[str | None] = "TRD"
    # Self-imposed: the free feed's prints are sparse (SPY printed once in 45 s on a weekday
    # afternoon), so a quiet minute is normal; two minutes without a print ages to STALE.
    stale_after_s: ClassVar[float] = 120.0

    def __init__(self, api_key: str, url: str = URL) -> None:
        super().__init__()
        self.api_key = api_key
        self.url = url
        self.cap = CAP
        self.pings = 0
        self._changed = asyncio.Event()
        self._last_t: dict[str, int] = {}

    def accepts(self, inst: Instrument) -> bool:
        return bool(self.api_key) and is_us_equity(inst)

    def provider_symbol(self, symbol: str) -> str:
        return finnhub_symbol(symbol)

    def on_symbols(self, symbols: set[str]) -> None:
        self._changed.set()

    def record_error(self, exc: BaseException) -> None:
        super().record_error(exc)
        if self.api_key and self.last_error:  # the key is part of the URL: never keep it
            self.last_error = self.last_error.replace(self.api_key, "<key>")

    def handle(self, msg: dict[str, Any]) -> None:
        kind = msg.get("type")
        if kind == "ping":
            self.pings += 1
            return
        if kind == "error":
            text = str(msg.get("msg") or "error")[:200]
            self.last_error, self.last_error_at = f"Finnhub: {text}", datetime.now(UTC)
            self.errors += 1
            return
        ours = {finnhub_symbol(s): s for s in self.symbols}
        # Every print goes to the tape (in trade time order); the price shown is the newest.
        for fs, p, t, v in sorted(trade_rows(msg), key=lambda r: r[2]):
            if (sym := ours.get(fs)) is not None:
                self.trade(sym, p, datetime.fromtimestamp(t / 1000, UTC), v)
        newest: dict[str, tuple[float, int, float]] = {}
        for fs, p, t, v in trade_rows(msg):
            sym = ours.get(fs)
            if sym is None or t < self._last_t.get(sym, 0):
                continue  # not ours, or older than a print already shown
            if sym not in newest or t >= newest[sym][1]:
                newest[sym] = (p, t, v)
        for sym, (p, t, v) in newest.items():
            self._last_t[sym] = t
            self.tick(sym, p, datetime.fromtimestamp(t / 1000, UTC), v)

    async def _send(self, ws: Any, kind: str, symbols: set[str]) -> None:
        for s in sorted(symbols):
            await ws.send(json.dumps({"type": kind, "symbol": finnhub_symbol(s)}))
            await asyncio.sleep(SEND_GAP_S)

    async def run(self) -> None:
        from websockets.asyncio.client import connect

        backoff = 1.0
        while True:
            if not self.symbols:
                self.state, self.detail = "idle", None
                self._changed.clear()
                await self._changed.wait()
                continue
            self.state = "connecting"
            try:
                async with connect(
                    f"{self.url}?token={self.api_key}",
                    max_size=2**22,
                    open_timeout=10,
                    ping_interval=20,
                ) as ws:
                    subscribed = set(self.symbols)
                    await self._send(ws, "subscribe", subscribed)
                    self.state, self.detail = "connected", None
                    backoff = 1.0
                    reader = asyncio.create_task(self._read(ws))
                    try:
                        while not reader.done():
                            self._changed.clear()
                            waiter = asyncio.create_task(self._changed.wait())
                            await asyncio.wait(
                                {reader, waiter}, return_when=asyncio.FIRST_COMPLETED
                            )
                            waiter.cancel()
                            if reader.done():
                                break
                            wanted = set(self.symbols)
                            await self._send(ws, "unsubscribe", subscribed - wanted)
                            await self._send(ws, "subscribe", wanted - subscribed)
                            for gone in subscribed - wanted:
                                self._last_t.pop(gone, None)
                            subscribed = wanted
                            if not subscribed:
                                break  # one connection per key: free it when unused
                    finally:
                        reader.cancel()
                        with contextlib.suppress(asyncio.CancelledError, Exception):
                            await reader
                    if reader.done() and not reader.cancelled() and reader.exception():
                        raise reader.exception()  # type: ignore[misc]
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self.record_error(exc)
                self.state, self.detail = "down", self.last_error
                log.warning("finnhub ws error: %s (retry in %.0fs)", self.last_error, backoff)
                await asyncio.sleep(backoff)
                backoff = min(60.0, backoff * 2)

    async def _read(self, ws: Any) -> None:
        async for raw in ws:
            try:
                msg = json.loads(raw)
                if isinstance(msg, dict):
                    self.handle(msg)
            except Exception as exc:  # a malformed message must not kill the feed
                log.warning("finnhub message error: %s", exc)
