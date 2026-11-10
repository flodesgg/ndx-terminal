"""Coinbase Advanced Trade public WebSocket: crypto secondary (SPEC §6.2), keyless.

docs/PROVIDERS.md §3.5: `wss://advanced-trade-ws.coinbase.com`, public `ticker` channel (a
price update on every match) plus `heartbeats` (every second; channels without updates close
after 60-90 s otherwise); 8 unauthenticated messages/s per IP. Recorded 2026-11-09: the first
message per product is a `snapshot` with 24 h low/high/volume, the 24 h % change and best
bid/ask; unknown product ids are dropped silently (the `subscriptions` echo lacks them).

The hub hands this feed the crypto subscriptions only while the Binance stream is failing.
Coinbase books are quoted in USD, ours (Binance) in USDT/USDC/FDUSD: every value says so.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import re
from datetime import UTC, datetime
from typing import Any, ClassVar

from ..models import AssetClass, Instrument, Quote
from ..stream import SymbolFeed

log = logging.getLogger("ndx.coinbase")

URL = "wss://advanced-trade-ws.coinbase.com"
# Product ids per subscription are not documented: a self-imposed cap.
CAP = 50
SEND_GAP_S = 0.25  # stay well under 8 control messages per second
_PAIR = re.compile(r"([A-Z0-9]{2,12})(USDT|USDC|FDUSD)")


def product_id(symbol: str) -> str | None:
    """Our crypto symbol (a Binance stablecoin pair) -> the Coinbase USD book."""
    m = _PAIR.fullmatch(symbol)
    return f"{m.group(1)}-USD" if m else None


def note_for(symbol: str, product: str) -> str:
    quote = _PAIR.fullmatch(symbol)
    stable = quote.group(2) if quote else "USDT"
    return f"Coinbase {product}: quoted in USD, not {stable}"


def _f(v: Any) -> float | None:
    try:
        return float(v) if v not in (None, "") else None
    except (TypeError, ValueError):
        return None


def parse_ticker(t: dict[str, Any], symbol: str, ts: datetime | None) -> Quote | None:
    price = _f(t.get("price"))
    if price is None:
        return None
    pct = _f(t.get("price_percent_chg_24_h"))
    # the 24 h change in price units follows from the stated % (no other source mixed in)
    change = price * pct / (100 + pct) if pct is not None and pct != -100 else None
    return Quote(
        symbol=symbol,
        currency="USD",
        price=price,
        change=change,
        change_pct=pct,
        high=_f(t.get("high_24_h")),
        low=_f(t.get("low_24_h")),
        volume=_f(t.get("volume_24_h")),
        bid=_f(t.get("best_bid")),
        ask=_f(t.get("best_ask")),
        bid_size=_f(t.get("best_bid_quantity")),
        ask_size=_f(t.get("best_ask_quantity")),
        ts=ts,
    )


def _ts(raw: Any) -> datetime | None:
    if not isinstance(raw, str):
        return None
    s = raw.rstrip("Z")
    head, _, frac = s.partition(".")
    try:
        dt = datetime.fromisoformat(head + (f".{frac[:6]}" if frac else ""))
    except ValueError:
        return None
    return dt.replace(tzinfo=UTC)


class CoinbaseFeed(SymbolFeed):
    name: ClassVar[str] = "coinbase"
    label: ClassVar[str] = "Coinbase"
    venue: ClassVar[str | None] = None  # one venue's own book: plain RT
    stale_after_s: ClassVar[float] = 10.0  # heartbeats every second keep it alive

    def __init__(self, url: str = URL) -> None:
        super().__init__()
        self.url = url
        self.cap = CAP
        self._changed = asyncio.Event()

    def accepts(self, inst: Instrument) -> bool:
        return inst.asset_class is AssetClass.CRYPTO and product_id(inst.symbol) is not None

    def on_symbols(self, symbols: set[str]) -> None:
        self._changed.set()

    def handle(self, msg: dict[str, Any]) -> None:
        if msg.get("channel") != "ticker":
            return
        ts = _ts(msg.get("timestamp"))
        by_product = {product_id(s): s for s in self.symbols}
        for event in msg.get("events") or []:
            for t in event.get("tickers") or []:
                product = t.get("product_id")
                symbol = by_product.get(product)
                if symbol is None:
                    continue
                q = parse_ticker(t, symbol, ts)
                if q is not None:
                    self.emit_quote(symbol, q, product, note_for(symbol, product))

    async def _send(self, ws: Any, kind: str, products: list[str]) -> None:
        if products:
            msg = {"type": kind, "product_ids": sorted(products), "channel": "ticker"}
            await ws.send(json.dumps(msg))
            await asyncio.sleep(SEND_GAP_S)

    def _products(self) -> set[str]:
        return {p for s in self.symbols if (p := product_id(s)) is not None}

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
                    self.url, max_size=2**22, open_timeout=10, ping_interval=20
                ) as ws:
                    subscribed = self._products()
                    await self._send(ws, "subscribe", list(subscribed))
                    await ws.send(json.dumps({"type": "subscribe", "channel": "heartbeats"}))
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
                            wanted = self._products()
                            await self._send(ws, "unsubscribe", list(subscribed - wanted))
                            await self._send(ws, "subscribe", list(wanted - subscribed))
                            subscribed = wanted
                            if not subscribed:
                                break  # nothing to carry: close until symbols come back
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
                log.warning("coinbase ws error: %s (retry in %.0fs)", exc, backoff)
                await asyncio.sleep(backoff)
                backoff = min(30.0, backoff * 2)

    async def _read(self, ws: Any) -> None:
        async for raw in ws:
            try:
                msg = json.loads(raw)
                if isinstance(msg, dict):
                    self.handle(msg)
            except Exception as exc:  # a malformed message must not kill the feed
                log.warning("coinbase message error: %s", exc)
