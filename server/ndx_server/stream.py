"""Backend-owned provider WebSockets for the streaming hub (SPEC §6.3, domain `stream`).

A `SymbolFeed` is one provider connection with a symbol cap (Finnhub free: 50 symbols, one
connection). The hub decides which subscribed symbols each feed carries with `allocate`:
symbols of the focused window first, then watchlists, and the rest rotate through the free
slots; whatever no feed carries is polled. Concrete feeds (Finnhub trades, Tiingo) implement
`run()` in Phase 2 step 2; here the base keeps the subscription set, the counters for PROV and
the tick path into the hub.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from collections.abc import Callable
from datetime import UTC, datetime
from typing import ClassVar, Literal

from .models import Instrument, Latency, ProviderState, ProviderStatus, Quote

log = logging.getLogger("ndx.stream")

FOCUS, WATCH, OTHER = 0, 1, 2
PRIORITIES = {"focus": FOCUS, "watch": WATCH, "other": OTHER}

FeedState = Literal["idle", "connecting", "connected", "down"]
# symbol, price, time, size, book fields the feed states itself (estimated bid/ask...) or None
TickSink = Callable[
    ["SymbolFeed", str, float, datetime | None, float | None, dict[str, float | None] | None],
    None,
]
# One print of a real trade feed (time & sales): symbol, price, trade time, size
TradeSink = Callable[["SymbolFeed", str, float, datetime, float | None], None]
# A feed that carries whole quotes (24 h stats, best bid/ask): symbol, quote, provider symbol, note
QuoteSink = Callable[["SymbolFeed", str, Quote, str, str | None], None]


def allocate(wanted: dict[str, int], cap: int, rotation: int) -> set[str]:
    """Pick at most `cap` symbols: by priority (focus, watch), then the lowest class that does
    not fit rotates — a window over it that moves by one per `rotation` step."""
    if cap <= 0:
        return set()
    out: set[str] = set()
    for prio in sorted(set(wanted.values())):
        group = sorted(s for s, p in wanted.items() if p == prio)
        room = cap - len(out)
        if room <= 0:
            break
        if len(group) <= room:
            out.update(group)
            continue
        if prio == FOCUS:  # never rotate the focused window's own symbols away
            out.update(group[:room])
            break
        start = rotation % len(group)
        out.update((group + group)[start : start + room])
        break
    return out


class SymbolFeed:
    """Base for one provider WebSocket with a symbol cap."""

    name: ClassVar[str]
    label: ClassVar[str]
    venue: ClassVar[str | None] = None  # RT·<venue> tag (TRD, REF); None = plain RT
    stale_after_s: ClassVar[float] = 30.0
    memory_only: ClassVar[bool] = False
    note: ClassVar[str | None] = None  # provenance note on every tick (Meta.note)

    def __init__(self) -> None:
        self.cap = 0
        self.symbols: set[str] = set()
        self._state: FeedState = "idle"
        # Down and not connected since: its symbols go to the next feed (or the poller) until
        # it connects again. Retries ("connecting") do not clear it, so a flapping feed does
        # not pull its symbols back and forth.
        self.failing = False
        self.health_sink: Callable[[SymbolFeed], None] | None = None
        self.detail: str | None = None
        self.messages = 0
        self.errors = 0
        self.last_msg: datetime | None = None
        self.last_error: str | None = None
        self.last_error_at: datetime | None = None
        self.sink: TickSink | None = None
        self.quote_sink: QuoteSink | None = None
        self.trade_sink: TradeSink | None = None
        self._task: asyncio.Task[None] | None = None

    @property
    def state(self) -> FeedState:
        return self._state

    @state.setter
    def state(self, value: FeedState) -> None:
        self._state = value
        failing = self.failing
        if value == "down":
            failing = True
        elif value in ("connected", "idle"):
            failing = False
        if failing != self.failing:
            self.failing = failing
            if self.health_sink is not None:
                self.health_sink(self)

    # ----- subclass hooks -----

    def accepts(self, inst: Instrument) -> bool:
        return False

    def provider_symbol(self, symbol: str) -> str:
        """The provider's spelling of an internal symbol (shown in the value's provenance)."""
        return symbol

    def on_symbols(self, symbols: set[str]) -> None:
        """The subscription set changed (a connected feed sends (un)subscribe messages)."""

    async def run(self) -> None:  # pragma: no cover - concrete feeds connect here
        return None

    # ----- hub side -----

    def set_symbols(self, symbols: set[str]) -> None:
        if symbols == self.symbols:
            return
        self.symbols = set(symbols)
        self.on_symbols(self.symbols)
        if symbols and self._task is None and type(self).run is not SymbolFeed.run:
            self._task = asyncio.create_task(self.run(), name=f"feed-{self.name}")

    def tick(
        self,
        symbol: str,
        price: float,
        ts: datetime | None,
        size: float | None = None,
        book: dict[str, float | None] | None = None,
    ) -> None:
        """A trade/price update from the provider; `book` = bid/ask fields it states with it."""
        self.messages += 1
        self.last_msg = datetime.now(UTC)
        if self.sink is not None and symbol in self.symbols:
            self.sink(self, symbol, price, ts, size, book)

    def trade(self, symbol: str, price: float, ts: datetime, size: float | None) -> None:
        """One print, for the time & sales tape; only feeds of real trades call it (a
        reference price is not a print)."""
        if self.trade_sink is not None and symbol in self.symbols:
            self.trade_sink(self, symbol, price, ts, size)

    def emit_quote(
        self, symbol: str, quote: Quote, provider_symbol: str, note: str | None = None
    ) -> None:
        """A full quote from the provider (its own change and day stats, not merged into
        another source's snapshot)."""
        self.messages += 1
        self.last_msg = datetime.now(UTC)
        if self.quote_sink is not None and symbol in self.symbols:
            self.quote_sink(self, symbol, quote, provider_symbol, note)

    def record_error(self, exc: BaseException) -> None:
        self.errors += 1
        self.last_error = f"{type(exc).__name__}: {exc}"[:300]
        self.last_error_at = datetime.now(UTC)

    async def stop(self) -> None:
        if self._task is not None:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await self._task
            self._task = None

    def status(self) -> ProviderStatus:
        st = {
            "idle": ProviderState.IDLE,
            "connected": ProviderState.OK,
            "connecting": ProviderState.DEGRADED,
            "down": ProviderState.DOWN,
        }[self.state]
        return ProviderStatus(
            name=self.name,
            label=self.label,
            state=st,
            detail=self.detail or f"{len(self.symbols)}/{self.cap} symbols",
            requires_key=False,
            has_key=True,
            latency=Latency.REALTIME,
            tag=f"RT·{self.venue}" if self.venue else "RT",
            calls=self.messages,
            errors=self.errors,
            last_ok=self.last_msg,
            last_error=self.last_error,
            last_error_at=self.last_error_at,
            capabilities=["stream"],
            domains=["stream"],
            quota_limit=self.cap,
            quota_period="symbols",
            quota_used=len(self.symbols),
            quota_left=max(0, self.cap - len(self.symbols)),
        )
