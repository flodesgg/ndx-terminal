"""Live data hub (SPEC §6.3 streaming hub): one WebSocket per UI client, multiplexing the
backend-owned provider streams and the quote poll.

Topics:
  quote:<SYMBOL>             live quote (crypto: Binance stream; symbol feeds such as Finnhub
                             trades within their caps; everything else: batched polling)
  bar:<SYMBOL>:<INTERVAL>    live kline updates (crypto only; equity charts update from quotes)
  trades:<SYMBOL>            time & sales: the newest prints of a real trade feed (Finnhub for
                             US equities, Binance aggTrade for crypto); passive: the quote
                             subscription decides whether a feed carries the symbol

Client messages: {"op": "sub"|"unsub", "topics": [...], "prio": "focus"|"watch"|"other"}.
The UI subscribes only to rows on screen; `prio` says whether they belong to the focused window
or a watchlist, which decides who gets a feed's limited symbol slots (`stream.allocate`).
Quote/bar messages are coalesced per topic: the first goes at once, then at most one (the
latest) every FLUSH_S.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import time
from collections import defaultdict, deque
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Literal

from fastapi import WebSocket, WebSocketDisconnect

from .market import MarketService
from .models import (
    AssetClass,
    Latency,
    LiveBar,
    LiveError,
    LiveFeedStatus,
    LiveQuote,
    LiveTrades,
    Meta,
    ProviderState,
    ProviderStatus,
    Quote,
    TapePrint,
)
from .providers.binance import INTERVALS as BINANCE_INTERVALS
from .providers.binance import parse_ws_kline, parse_ws_ticker
from .providers.coinbase_ws import CoinbaseFeed
from .stream import OTHER, PRIORITIES, SymbolFeed, allocate
from .symbols import SymbolError, classify, echo_key

log = logging.getLogger("ndx.live")

BINANCE_WS = (
    "wss://stream.binance.com:9443/stream",
    "wss://data-stream.binance.vision/stream",
)
MAX_TOPICS_PER_CLIENT = 400
STREAM_STALE_S = 10.0  # Binance pushes @ticker every 1 s; 10 s silence = STALE
TAPE_KEEP = 50  # prints per trades message: the window resent on each print
FLUSH_S = 0.25  # per-topic message cap: 4/s (SPEC §2 live cell repaints)
SNAPSHOT_GATHER_S = 0.05  # a burst of `sub` messages (a MON list, row by row) -> one snapshot
ROTATE_S = 30.0  # symbols beyond a feed's cap take turns this often
# Self-imposed: how often the REST snapshot under a streamed symbol (previous close, name, day
# fields) is refreshed; a stream carries prices only, and a new session moves the prev close.
BASE_REFRESH_S = 300.0
FeedState = Literal["connected", "connecting", "down"]


@dataclass(eq=False)
class Client:
    ws: WebSocket
    clock: Callable[[], float] = time.monotonic
    queue: asyncio.Queue[str] = field(default_factory=lambda: asyncio.Queue(maxsize=2000))
    topics: set[str] = field(default_factory=set)
    # hub topic (internal symbol) -> the spellings this client subscribed with, e.g.
    # "quote:AAPL" -> {"AAPL US EQUITY"}: messages answer in the client's style (SPEC §5).
    aliases: dict[str, set[str]] = field(default_factory=dict)
    # hub topic -> priority this client gave it (stream.FOCUS / WATCH / OTHER)
    prios: dict[str, int] = field(default_factory=dict)
    dropped: int = 0
    # quote symbols waiting for their first snapshot (one batch per burst of `sub` messages)
    snap_wanted: dict[str, None] = field(default_factory=dict)
    snap_task: asyncio.Task[None] | None = None
    # coalescing: key -> latest message not sent yet; key -> monotonic time of the last send
    pending: dict[str, str] = field(default_factory=dict)
    last_push: dict[str, float] = field(default_factory=dict)

    def send(self, msg: str) -> None:
        try:
            self.queue.put_nowait(msg)
        except asyncio.QueueFull:
            self.dropped += 1

    def push(self, key: str, msg: str) -> None:
        """Coalesced send: at once if `key` was quiet for FLUSH_S, else keep only the latest
        until its window ends (`due`)."""
        now = self.clock()
        if key not in self.pending and now - self.last_push.get(key, -FLUSH_S) >= FLUSH_S:
            self.last_push[key] = now
            self.send(msg)
            return
        if not self.pending:
            self.send("")  # wake the sender so it starts timing the flush
        self.pending[key] = msg

    def due(self) -> list[str]:
        now = self.clock()
        out = [m for k, m in self.pending.items() if now - self.last_push.get(k, 0) >= FLUSH_S]
        for k in [k for k in self.pending if now - self.last_push.get(k, 0) >= FLUSH_S]:
            del self.pending[k]
            self.last_push[k] = now
        return out

    def next_flush_in(self) -> float | None:
        if not self.pending:
            return None
        now = self.clock()
        return max(0.0, min(self.last_push.get(k, 0) + FLUSH_S - now for k in self.pending))

    def deliver(self, topic: str, msg: str, key: str | None = None) -> None:
        """Send a quote/bar message once per spelling the client used for this topic."""
        internal = topic.split(":")[1]
        names = self.aliases.get(topic)
        base = key or topic
        if not names or names == {internal}:
            self.push(base, msg)
            return
        for name in sorted(names):
            if name == internal:
                self.push(f"{base}|{name}", msg)
            else:
                d = json.loads(msg)
                d["symbol"] = name
                self.push(f"{base}|{name}", json.dumps(d))


def parse_topic(topic: str) -> tuple[str, str, str | None]:
    """'quote:AAPL' -> ('quote','AAPL',None); 'bar:BTCUSDT:1m' -> ('bar','BTCUSDT','1m')."""
    parts = topic.split(":")
    if len(parts) == 2 and parts[0] == "quote":
        return "quote", classify(parts[1]).symbol, None
    if len(parts) == 3 and parts[0] == "bar" and parts[2] in BINANCE_INTERVALS:
        return "bar", classify(parts[1]).symbol, parts[2]
    if len(parts) == 2 and parts[0] == "trades":
        return "trades", classify(parts[1]).symbol, None
    raise SymbolError(f"bad topic {topic!r}")


def canonical_topic(kind: str, sym: str, interval: str | None) -> str:
    return f"bar:{sym}:{interval}" if kind == "bar" else f"{kind}:{sym}"


class BinanceFeed:
    """Single combined-stream connection with dynamic SUBSCRIBE/UNSUBSCRIBE."""

    def __init__(self, hub: LiveHub) -> None:
        self.hub = hub
        self.wanted: set[str] = set()
        self._ws: Any = None
        self._task: asyncio.Task[None] | None = None
        self._changed = asyncio.Event()
        self._msg_id = 0
        self.state: str = "idle"
        self.detail: str | None = None
        self.messages = 0
        self.errors = 0
        self.last_msg: datetime | None = None
        self.last_error: str | None = None
        self.last_error_at: datetime | None = None
        self._url_idx = 0
        # True from a failed connection until the next successful one: while it is set the
        # hub gives crypto subscriptions to the secondary feed (Coinbase) instead.
        self.failing = False

    def _set_failing(self, failing: bool) -> None:
        if failing != self.failing:
            self.failing = failing
            self.hub.on_binance_health()

    def status(self) -> ProviderStatus:
        st = {
            "idle": ProviderState.IDLE,
            "connected": ProviderState.OK,
            "connecting": ProviderState.DEGRADED,
            "down": ProviderState.DOWN,
        }[self.state]
        return ProviderStatus(
            name="binance-ws",
            label="Binance WebSocket",
            state=st,
            detail=self.detail,
            requires_key=False,
            has_key=True,
            latency=Latency.REALTIME,
            calls=self.messages,
            errors=self.errors,
            rate_limited=0,
            last_ok=self.last_msg,
            last_error=self.last_error,
            last_error_at=self.last_error_at,
            capabilities=["stream"],
            domains=["stream"],
        )

    def set_wanted(self, streams: set[str]) -> None:
        if streams != self.wanted:
            self.wanted = streams
            self._changed.set()
            if streams and self._task is None:
                self._task = asyncio.create_task(self._run(), name="binance-ws")

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await self._task
            self._task = None

    async def _send(self, method: str, params: list[str]) -> None:
        if not params or self._ws is None:
            return
        for i in range(0, len(params), 100):
            self._msg_id += 1
            await self._ws.send(
                json.dumps({"method": method, "params": params[i : i + 100], "id": self._msg_id})
            )
            await asyncio.sleep(0.25)  # Binance allows 5 control messages per second

    async def _run(self) -> None:
        from websockets.asyncio.client import connect

        backoff = 1.0
        while True:
            if not self.wanted:
                self.state = "idle"
                self._changed.clear()
                await self._changed.wait()
                continue
            url = BINANCE_WS[self._url_idx % len(BINANCE_WS)]
            self.state = "connecting"
            self.hub.broadcast_status("binance", "connecting", None)
            try:
                async with connect(url, max_size=2**22, open_timeout=10, ping_interval=20) as ws:
                    self._ws = ws
                    subscribed: set[str] = set(self.wanted)
                    await self._send("SUBSCRIBE", sorted(subscribed))
                    self.state, self.detail = "connected", url
                    self.hub.broadcast_status("binance", "connected", None)
                    self._set_failing(False)
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
                            add = self.wanted - subscribed
                            rem = subscribed - self.wanted
                            await self._send("UNSUBSCRIBE", sorted(rem))
                            await self._send("SUBSCRIBE", sorted(add))
                            subscribed = set(self.wanted)
                            if not subscribed:
                                break
                    finally:
                        reader.cancel()
                        with contextlib.suppress(asyncio.CancelledError, Exception):
                            await reader
                    if reader.done() and not reader.cancelled() and reader.exception():
                        raise reader.exception()  # type: ignore[misc]
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self.errors += 1
                self.last_error = f"{type(exc).__name__}: {exc}"[:300]
                self.last_error_at = datetime.now(UTC)
                self.state, self.detail = "down", self.last_error
                self.hub.broadcast_status("binance", "down", self.last_error)
                self._set_failing(True)
                log.warning("binance ws error: %s (retry in %.0fs)", exc, backoff)
                self._url_idx += 1  # alternate between the main and the mirror endpoint
                await asyncio.sleep(backoff)
                backoff = min(30.0, backoff * 2)
            finally:
                self._ws = None

    async def _read(self, ws: Any) -> None:
        async for raw in ws:
            msg = json.loads(raw)
            stream = msg.get("stream")
            data = msg.get("data")
            if not stream or not isinstance(data, dict):
                continue  # subscription acks
            self.messages += 1
            self.last_msg = datetime.now(UTC)
            try:
                self.hub.on_binance(stream, data)
            except Exception as exc:  # malformed message must not kill the feed
                log.warning("binance message error: %s", exc)


class LiveHub:
    def __init__(
        self, market: MarketService, poll_interval: float = 10.0, stream_crypto: bool = True
    ) -> None:
        self.market = market
        # DEMO mode: no exchange WebSocket; every symbol is served by the (fixture) poll.
        self.stream_crypto = stream_crypto
        self.poll_interval = poll_interval
        self.clients: set[Client] = set()
        self.subs: dict[str, set[Client]] = defaultdict(set)
        self.binance = BinanceFeed(self)
        self._poll_task: asyncio.Task[None] | None = None
        # topic -> (values sent, fetched_at sent): skip only a repeat of the very same fetch
        self._last_sent: dict[str, tuple[tuple[Any, ...], Any]] = {}
        self._tasks: set[asyncio.Task[None]] = set()
        # backend-owned provider streams with symbol caps (stream.SymbolFeed)
        self.feeds: list[SymbolFeed] = []
        self._rotation = 0
        self._rotate_task: asyncio.Task[None] | None = None
        # last quote shown per symbol
        self._last_quote: dict[str, Quote] = {}
        # REST snapshot per symbol (prev close, name, day fields) and when it was fetched
        self._rest_base: dict[str, Quote] = {}
        self._base_at: dict[str, float] = {}
        # newest tick per streamed symbol: the feed and the fields it stated
        self._last_tick: dict[str, tuple[SymbolFeed, dict[str, Any]]] = {}
        # time & sales: the newest prints per symbol and the per-symbol sequence
        self._tape: dict[str, deque[TapePrint]] = {}
        self._tape_seq: dict[str, int] = {}
        if stream_crypto:  # crypto secondary while the Binance stream is failing (§6.2)
            self.add_feed(CoinbaseFeed())

    def add_feed(self, feed: SymbolFeed) -> None:
        feed.sink = self._on_feed_tick
        feed.quote_sink = self._on_feed_quote
        feed.trade_sink = self._on_feed_trade
        feed.health_sink = self._on_feed_health
        self.feeds.append(feed)

    def _on_feed_health(self, feed: SymbolFeed) -> None:
        """A feed failed or recovered: its symbols move to the next feed / the poller and
        back (Finnhub down -> Tiingo carries US equities, §6.2)."""
        log.info("feed %s %s", feed.name, "failing" if feed.failing else "recovered")
        self._sync_feeds()

    # ----- lifecycle -----

    async def start(self) -> None:
        self._poll_task = asyncio.create_task(self._poll_loop(), name="quote-poll")
        self._rotate_task = asyncio.create_task(self._rotate_loop(), name="feed-rotate")

    async def stop(self) -> None:
        for task in (self._poll_task, self._rotate_task):
            if task:
                task.cancel()
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await task
        await self.binance.stop()
        for feed in self.feeds:
            await feed.stop()

    # ----- client handling -----

    async def handle(self, ws: WebSocket, subprotocol: str | None = None) -> None:
        await ws.accept(subprotocol=subprotocol)
        client = Client(ws)
        self.clients.add(client)
        sender = asyncio.create_task(self._sender(client))
        if self.binance.state in ("connected", "connecting", "down"):
            client.send(
                LiveFeedStatus(
                    type="status",
                    feed="binance",
                    state=self.binance.state,
                    detail=self.binance.detail if self.binance.state == "down" else None,
                ).model_dump_json()
            )
        try:
            while True:
                msg = json.loads(await ws.receive_text())
                op = msg.get("op")
                topics = [str(t) for t in msg.get("topics", [])][:MAX_TOPICS_PER_CLIENT]
                if op == "sub":
                    await self._subscribe(client, topics, str(msg.get("prio") or "other"))
                elif op == "unsub":
                    self._unsubscribe(client, topics)
        except (WebSocketDisconnect, RuntimeError):
            pass
        except Exception as exc:
            log.warning("ws client error: %s", exc)
        finally:
            sender.cancel()
            self._drop_client(client)

    async def _sender(self, client: Client) -> None:
        with contextlib.suppress(Exception):
            while True:
                try:
                    msg = await asyncio.wait_for(client.queue.get(), client.next_flush_in())
                    if msg:
                        await client.ws.send_text(msg)
                except TimeoutError:
                    pass
                for m in client.due():
                    await client.ws.send_text(m)

    async def _subscribe(self, client: Client, topics: list[str], prio: str = "other") -> None:
        level = PRIORITIES.get(prio, OTHER)
        fresh_quotes: list[str] = []
        for t in topics:
            try:
                kind, sym, interval = parse_topic(t)
            except SymbolError as exc:
                client.send(LiveError(type="error", symbol=t, error=str(exc)).model_dump_json())
                continue
            canonical = canonical_topic(kind, sym, interval)
            if len(client.topics) >= MAX_TOPICS_PER_CLIENT:
                break
            requested = t.split(":")[1]
            spelling = echo_key(requested, classify(requested))
            names = client.aliases.setdefault(canonical, set())
            # A second spelling of a topic already held (FXC's USDJPY, then WFX's USDJPY CURNCY)
            # needs its own snapshot: until the next poll it would have nothing.
            new_spelling = spelling not in names
            names.add(spelling)
            client.prios[canonical] = level
            is_new = canonical not in client.topics
            client.topics.add(canonical)
            self.subs[canonical].add(client)
            if kind == "quote" and (is_new or new_spelling) and sym not in fresh_quotes:
                fresh_quotes.append(sym)
        self._sync_binance()
        self._sync_feeds()
        # Send an initial snapshot so the UI shows data immediately.
        non_crypto = [s for s in fresh_quotes if not self._streamed(s)]
        if non_crypto:
            # The UI subscribes a MON list one row per message: gather a burst into one batch
            # instead of one snapshot task per row (review 2 M2).
            client.snap_wanted.update(dict.fromkeys(non_crypto))
            if client.snap_task is None:
                task = asyncio.create_task(self._snapshot_soon(client))
                client.snap_task = task
                self._tasks.add(task)
                task.add_done_callback(self._tasks.discard)

    async def _snapshot_soon(self, client: Client) -> None:
        await asyncio.sleep(SNAPSHOT_GATHER_S)
        client.snap_task = None  # later subscriptions start their own batch
        # Rows unsubscribed meanwhile (a closed window) are not fetched.
        symbols = [s for s in client.snap_wanted if f"quote:{s}" in client.topics]
        client.snap_wanted.clear()
        if symbols:
            await self._snapshot(client, symbols)

    def _drop_client(self, client: Client) -> None:
        """A closed connection: every topic it held, under any spelling, and its pending
        snapshot go (review 2 H1: `_unsubscribe` with internal names left the canonical
        spellings in `aliases`, so the topics stayed polled for the life of the backend)."""
        if client.snap_task is not None:
            client.snap_task.cancel()
            client.snap_task = None
        client.snap_wanted.clear()
        for t in list(client.topics):
            subs = self.subs.get(t)
            if subs is not None:
                subs.discard(client)
                if not subs:
                    del self.subs[t]
                    self._last_sent.pop(t, None)
                    kind, _, rest = t.partition(":")
                    if kind == "trades":
                        self._tape.pop(rest, None)
        client.topics.clear()
        client.aliases.clear()
        client.prios.clear()
        self.clients.discard(client)
        self._sync_binance()
        self._sync_feeds()

    def _unsubscribe(self, client: Client, topics: list[str]) -> None:
        for raw in topics:
            try:
                kind, sym, interval = parse_topic(raw)
            except SymbolError:
                continue
            t = canonical_topic(kind, sym, interval)
            requested = raw.split(":")[1]
            names = client.aliases.get(t)
            if names is not None:
                names.discard(echo_key(requested, classify(requested)))
                if names:
                    continue  # still subscribed under another spelling
                del client.aliases[t]
            client.topics.discard(t)
            client.prios.pop(t, None)
            subs = self.subs.get(t)
            if subs is not None:
                subs.discard(client)
                if not subs:
                    del self.subs[t]
                    self._last_sent.pop(t, None)
                    if kind == "trades":
                        self._tape.pop(sym, None)
        self._sync_binance()
        self._sync_feeds()

    def _streamed(self, sym: str) -> bool:
        """Carried by the Binance stream (crypto, while that stream is not failing)."""
        return (
            self.stream_crypto
            and not self.binance.failing
            and classify(sym).asset_class is AssetClass.CRYPTO
        )

    def on_binance_health(self) -> None:
        """Binance stream failed or recovered: crypto moves to / back from the secondary."""
        self._sync_feeds()

    # ----- symbol feeds: caps, priority, rotation -----

    def _wanted(self) -> dict[str, int]:
        """Subscribed quote symbols -> best (lowest) priority any client gave them."""
        out: dict[str, int] = {}
        for topic, clients in self.subs.items():
            kind, sym, _ = parse_topic(topic)
            if kind != "quote" or self._streamed(sym):
                continue
            out[sym] = min((c.prios.get(topic, OTHER) for c in clients), default=OTHER)
        return out

    def _sync_feeds(self) -> None:
        if not self.feeds:
            return
        left = self._wanted()
        for feed in self.feeds:
            mine = {s: p for s, p in left.items() if feed.accepts(classify(s))}
            chosen = allocate(mine, feed.cap, self._rotation)
            feed.set_symbols(chosen)  # a failing feed keeps them, to reconnect with them
            if feed.failing:
                continue  # ... and the next feed carries them meanwhile
            for s in chosen:
                left.pop(s, None)

    def rotate(self) -> None:
        """Give the next symbols beyond a feed's cap their turn."""
        self._rotation += 1
        self._sync_feeds()

    async def _rotate_loop(self) -> None:
        while True:
            await asyncio.sleep(ROTATE_S)
            wanted = self._wanted()
            if any(sum(1 for s in wanted if f.accepts(classify(s))) > f.cap for f in self.feeds):
                self.rotate()

    def _fed(self, sym: str) -> bool:
        """Carried by a working feed (a failing feed's symbols are polled meanwhile)."""
        return any(sym in f.symbols and not f.failing for f in self.feeds)

    def _poll_symbols(self) -> list[str]:
        out = []
        for topic in list(self.subs):
            kind, sym, _ = parse_topic(topic)
            if kind == "quote" and not self._streamed(sym) and not self._fed(sym):
                out.append(sym)
        return out

    def _on_feed_tick(
        self,
        feed: SymbolFeed,
        sym: str,
        price: float,
        ts: datetime | None,
        size: float | None,
        book: dict[str, float | None] | None = None,
    ) -> None:
        self._last_tick[sym] = (feed, {"price": price, "ts": ts, **(book or {})})
        q = self._merged(sym)
        self._last_quote[sym] = q
        self._publish_fed(feed, sym, q, ts)

    def _on_feed_trade(
        self, feed: SymbolFeed, sym: str, price: float, ts: datetime, size: float | None
    ) -> None:
        meta = Meta(
            source=feed.label,
            latency=Latency.REALTIME,
            venue=feed.venue,
            provider_symbol=feed.provider_symbol(sym),
            note=feed.note,
            as_of=ts,
            fetched_at=datetime.now(UTC),
            stale_after_s=feed.stale_after_s,
        )
        self._print(sym, price, ts, size, meta)

    def _print(self, sym: str, price: float, ts: datetime, size: float | None, meta: Meta) -> None:
        """Add a print to the symbol's tape and send the recent window to its subscribers."""
        topic = f"trades:{sym}"
        if topic not in self.subs:
            return
        seq = self._tape_seq.get(sym, 0) + 1
        self._tape_seq[sym] = seq
        tape = self._tape.setdefault(sym, deque(maxlen=TAPE_KEEP))
        tape.append(TapePrint(seq=seq, t=ts, price=price, size=size))
        msg = LiveTrades(type="trades", symbol=sym, prints=list(tape), meta=meta)
        self.publish(topic, msg.model_dump_json())

    def _merged(self, sym: str) -> Quote:
        """The REST snapshot with the newest tick's price (and the book fields that feed
        states, e.g. Tiingo's estimates) on top; change vs the snapshot's previous close."""
        base = self._rest_base.get(sym) or Quote(symbol=sym)
        tick = self._last_tick.get(sym)
        if tick is None:
            return base
        upd = dict(tick[1])
        ts = upd.get("ts")
        if base.ts is not None and ts is not None and ts < base.ts:
            return base  # the snapshot is newer than the last streamed print
        price = upd["price"]
        if base.prev_close:
            upd["change"] = price - base.prev_close
            upd["change_pct"] = (price / base.prev_close - 1) * 100
        return base.model_copy(update=upd)

    def _publish_fed(self, feed: SymbolFeed, sym: str, q: Quote, ts: datetime | None) -> None:
        meta = Meta(
            source=feed.label,
            latency=Latency.REALTIME,
            venue=feed.venue,
            provider_symbol=feed.provider_symbol(sym),
            note=feed.note,
            as_of=ts,
            fetched_at=datetime.now(UTC),
            stale_after_s=feed.stale_after_s,
        )
        self.publish(
            f"quote:{sym}",
            LiveQuote(type="quote", symbol=sym, data=q, meta=meta).model_dump_json(),
        )

    def _on_feed_quote(
        self, feed: SymbolFeed, sym: str, q: Quote, provider_symbol: str, note: str | None
    ) -> None:
        """A whole quote from a feed's own venue: published as is, never merged into another
        source's snapshot (its change is that venue's)."""
        meta = Meta(
            source=feed.label,
            latency=Latency.REALTIME,
            venue=feed.venue,
            provider_symbol=provider_symbol,
            as_of=q.ts,
            fetched_at=datetime.now(UTC),
            stale_after_s=feed.stale_after_s,
            note=note,
        )
        self.publish(
            f"quote:{sym}",
            LiveQuote(type="quote", symbol=sym, data=q, meta=meta).model_dump_json(),
        )

    def _sync_binance(self) -> None:
        streams: set[str] = set()
        if not self.stream_crypto:
            self.binance.set_wanted(streams)
            return
        for topic in self.subs:
            kind, sym, interval = parse_topic(topic)
            if not self._streamed(sym):
                continue
            if kind == "quote":
                streams.add(f"{sym.lower()}@ticker")
            elif kind == "trades":
                streams.add(f"{sym.lower()}@aggTrade")
            elif interval:
                streams.add(f"{sym.lower()}@kline_{BINANCE_INTERVALS[interval]}")
        self.binance.set_wanted(streams)

    # ----- publishing -----

    def publish(self, topic: str, msg: str, key: str | None = None) -> None:
        for c in self.subs.get(topic, ()):
            c.deliver(topic, msg, key)

    def broadcast_raw(self, msg: str) -> None:
        for c in self.clients:
            c.send(msg)

    def broadcast_status(self, feed: str, state: FeedState, detail: str | None) -> None:
        msg = LiveFeedStatus(type="status", feed=feed, state=state, detail=detail).model_dump_json()
        for c in self.clients:
            c.send(msg)

    def on_binance(self, stream: str, data: dict[str, Any]) -> None:
        now = datetime.now(UTC)
        if stream.endswith("@ticker"):
            q = parse_ws_ticker(data)
            meta = Meta(
                source="Binance (stream)",
                latency=Latency.REALTIME,
                provider_symbol=q.symbol,
                as_of=q.ts,
                fetched_at=now,
                stale_after_s=STREAM_STALE_S,
            )
            self.publish(
                f"quote:{q.symbol}",
                LiveQuote(type="quote", symbol=q.symbol, data=q, meta=meta).model_dump_json(),
            )
        elif stream.endswith("@aggTrade"):
            sym = str(data.get("s"))
            try:
                price, size = float(data["p"]), float(data["q"])
                ts = datetime.fromtimestamp(int(data["T"]) / 1000, UTC)
            except (KeyError, TypeError, ValueError):
                return
            meta = Meta(
                source="Binance (stream)",
                latency=Latency.REALTIME,
                provider_symbol=sym,
                note="aggregate trade: fills at one price and time from one taker order",
                as_of=ts,
                fetched_at=now,
                stale_after_s=STREAM_STALE_S,
            )
            self._print(sym, price, ts, size, meta)
        elif "@kline_" in stream:
            k = data.get("k") or {}
            sym = str(k.get("s"))
            interval = next((i for i, b in BINANCE_INTERVALS.items() if b == k.get("i")), None)
            if interval is None:
                return
            bar = parse_ws_kline(k)
            event_ms = data.get("E")
            meta = Meta(
                source="Binance (stream)",
                latency=Latency.REALTIME,
                provider_symbol=sym,
                # Missing event time -> unknown as_of, never the 1970 epoch.
                as_of=datetime.fromtimestamp(int(event_ms) / 1000, UTC) if event_ms else None,
                fetched_at=now,
                stale_after_s=STREAM_STALE_S,
            )
            self.publish(
                f"bar:{sym}:{interval}",
                key=f"bar:{sym}:{interval}:{bar.t}",
                msg=LiveBar(
                    type="bar",
                    symbol=sym,
                    interval=interval,
                    bar=bar,
                    closed=bool(k.get("x")),
                    meta=meta,
                ).model_dump_json(),
            )

    async def _snapshot(self, client: Client, symbols: list[str]) -> None:
        try:
            res = await self.market.quotes(symbols)
        except Exception as exc:
            client.send(LiveError(type="error", error=f"snapshot failed: {exc}").model_dump_json())
            return
        for item in res.items:
            topic = f"quote:{item.symbol}"
            if item.data is not None and item.meta is not None:
                self._rest_base[item.symbol] = item.data
                self._base_at[item.symbol] = time.monotonic()
                self._last_quote.setdefault(item.symbol, item.data)
                client.deliver(
                    topic,
                    LiveQuote(
                        type="quote", symbol=item.symbol, data=item.data, meta=item.meta
                    ).model_dump_json(),
                )
            elif item.error:
                client.deliver(
                    topic,
                    LiveError(type="error", symbol=item.symbol, error=item.error).model_dump_json(),
                )

    def _should_send(self, topic: str, sig: tuple[Any, ...], fetched: Any) -> bool:
        """Every new fetch is sent, unchanged values included, so the UI's fetched_at stays
        honest and STALE means "older than 2x the refresh" (§6.1). Only a repeat of the very
        same fetch (a cache hit) is skipped; a failed poll sends nothing, so the UI ages the
        value into STALE."""
        if self._last_sent.get(topic) == (sig, fetched):
            return False
        self._last_sent[topic] = (sig, fetched)
        return True

    async def poll_once(self) -> None:
        """One batch poll of the quote subscriptions no stream carries; pushes new fetches
        (and a copy turning STALE when the network drops)."""
        symbols = self._poll_symbols()
        if not symbols:
            return
        res = await self.market.quotes(symbols)
        for item in res.items:
            topic = f"quote:{item.symbol}"
            if item.data is None or item.meta is None:
                if item.error:
                    self.publish(
                        topic,
                        LiveError(
                            type="error", symbol=item.symbol, error=item.error
                        ).model_dump_json(),
                    )
                continue
            q = item.data
            self._last_quote[item.symbol] = q
            self._rest_base[item.symbol] = q
            self._base_at[item.symbol] = time.monotonic()
            sig = (
                q.price,
                q.volume,
                q.bid,
                q.ask,
                q.ts,
                q.ext_price,
                q.market_state,
                item.meta.stale,
            )
            if not self._should_send(topic, sig, item.meta.fetched_at):
                continue
            self.publish(
                topic,
                LiveQuote(
                    type="quote", symbol=item.symbol, data=q, meta=item.meta
                ).model_dump_json(),
            )

    async def refresh_fed_bases(self) -> None:
        """Refresh the REST snapshot under streamed symbols every BASE_REFRESH_S; when the
        previous close moved (a new session), re-send the streamed price against it."""
        now = time.monotonic()
        fed = {
            sym
            for topic in self.subs
            if (p := parse_topic(topic))[0] == "quote" and self._fed(sym := p[1])
        }
        due = sorted(
            s for s in fed if s not in self._base_at or now - self._base_at[s] >= BASE_REFRESH_S
        )
        if not due:
            return
        res = await self.market.quotes(due)
        for item in res.items:
            self._base_at[item.symbol] = now  # a failure waits for the next round too
            if item.data is None:
                continue
            old = self._rest_base.get(item.symbol)
            self._rest_base[item.symbol] = item.data
            tick = self._last_tick.get(item.symbol)
            if tick is None or old is None or old.prev_close == item.data.prev_close:
                continue
            q = self._merged(item.symbol)
            self._last_quote[item.symbol] = q
            if q.ts == tick[1].get("ts"):
                self._publish_fed(tick[0], item.symbol, q, q.ts)

    async def _poll_loop(self) -> None:
        """Batch-poll non-crypto quote subscriptions; push only changes."""
        while True:
            started = time.monotonic()
            try:
                await self.poll_once()
            except Exception as exc:
                log.warning("quote poll failed: %s", exc)
            try:
                await self.refresh_fed_bases()
            except Exception as exc:
                log.warning("streamed-symbol snapshot refresh failed: %s", exc)
            elapsed = time.monotonic() - started
            await asyncio.sleep(max(1.0, self.poll_interval - elapsed))
