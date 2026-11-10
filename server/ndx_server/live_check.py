"""`make live-check`: one tiny real request per configured provider (SPEC §11).

Prints provider, result (OK / SKIP / FAIL), round-trip time and the reason; never prints keys.
Providers without a key, and opt-in providers that are switched off (yfinance), are skipped:
set NDX_LIVE_YAHOO=1 to include the personal-use Yahoo probe. Exit code 1 if any probe failed.
"""

from __future__ import annotations

import asyncio
import os
import sys
import time
from collections.abc import Awaitable, Callable
from typing import Any

from .config import get_settings
from .logging_setup import redactor
from .models import AssetClass, Instrument
from .providers.base import DataProvider, TransientError
from .providers.registry import build_providers
from .secrets_store import secret_values

AAPL = Instrument(symbol="AAPL", asset_class=AssetClass.EQUITY, display="AAPL")
BTC = Instrument(symbol="BTCUSDT", asset_class=AssetClass.CRYPTO, display="BTCUSDT")

Probe = Callable[[Any], Awaitable[object]]


def _novo() -> Instrument:
    from .symbols import classify

    return classify("NOVOB DC EQUITY")


# One small request each: the cheapest call that proves the key and endpoint work.
PROBES: dict[str, Probe] = {
    "binance": lambda p: p.quote(BTC),
    "finnhub": lambda p: p.quote(AAPL),
    "coingecko": lambda p: p.markets(1),
    "rss": lambda p: p.news(None, 1),
    # one request (GDELT allows one every 5 s): a week of headlines naming Novo Nordisk
    "gdelt": lambda p: p.news(_novo(), 3),
    "sec": lambda p: p.cik("AAPL"),
    "treasury": lambda p: p.yield_curve(),
    "fred": lambda p: p.series("UNRATE"),
    # free: /api/user costs no call of the 20/day; it proves the key and syncs our counter
    "eodhd": lambda p: p.account(),
    "ecb": lambda p: p.table(),  # one request: every live currency's last two fixings
    "nbu": lambda p: p.table(),  # two requests: today's and yesterday's official rates
    "yahoo": lambda p: p.quote(AAPL),
    # one call of the 4/min: the last week of AAPL daily bars, up to the previous session
    "massive": lambda p: p.bars(AAPL, "1d", 7),
    # ECO calendars (keyless): the whole published calendar, one or two pages each
    "bea": lambda p: p.econ_calendar(),
    "fed": lambda p: p.econ_calendar(),
    "eurostat": lambda p: p.econ_calendar(),
    "ecbstat": lambda p: p.econ_calendar(),
    "dst": lambda p: p.econ_calendar(),
}


async def _probe_coinbase() -> str:
    """The Coinbase secondary feed itself: subscribe BTC, wait for the first quote."""
    from .providers.coinbase_ws import CoinbaseFeed

    feed = CoinbaseFeed()
    got: asyncio.Future[float] = asyncio.get_running_loop().create_future()

    def sink(_f: object, _s: str, q: Any, _p: str, _n: str | None) -> None:
        if not got.done():
            got.set_result(q.price)

    feed.quote_sink = sink
    feed.set_symbols({"BTCUSDT"})
    try:
        await asyncio.wait_for(got, timeout=15)
    finally:
        await feed.stop()
    return "  first BTC-USD ticker received"


class Skip(Exception):
    """A stream probe that cannot run (no key)."""


async def _probe_finnhub_ws() -> str:
    """The Finnhub trade stream: subscribe a few busy US names, wait for the first print.

    The free feed is sparse (docs/PROVIDERS.md §3.1), so the wait is long; outside US hours
    there are no prints and a `ping` is the proof the authenticated connection is up.
    """
    from .providers.finnhub_ws import FinnhubFeed

    key = get_settings().finnhub_api_key
    if not key:
        raise Skip("no key configured")
    feed = FinnhubFeed(key)
    loop = asyncio.get_running_loop()
    got: asyncio.Future[str] = loop.create_future()

    def sink(_f: object, s: str, _p: float, _ts: object, _v: object, _b: object) -> None:
        if not got.done():
            got.set_result(f"  first print received ({s})")

    feed.sink = sink
    feed.set_symbols({"AAPL", "MSFT", "SPY", "NVDA", "TSLA"})
    try:
        deadline = loop.time() + 60
        while not got.done() and loop.time() < deadline:
            if feed.state == "down":
                raise RuntimeError(feed.last_error or "finnhub ws down")
            if feed.pings and loop.time() > deadline - 30:
                return f"  connected, {feed.pings} ping(s), no print in 30 s (market closed?)"
            await asyncio.sleep(0.2)
        if not got.done():
            raise TimeoutError("no print or ping in 60 s")
        return got.result()
    finally:
        await feed.stop()


async def _probe_tiingo_ws() -> str:
    """The Tiingo 24x5 stream: one connection (one token of the hourly budget), first update.
    Outside Sunday 20:00 - Friday 20:00 ET the heartbeat alone proves the subscription."""
    from .providers.tiingo_ws import TiingoFeed

    key = get_settings().tiingo_api_key
    if not key:
        raise Skip("no key configured")
    feed = TiingoFeed(key)  # no data folder: the probe's symbols do not enter the ledger
    loop = asyncio.get_running_loop()
    got: asyncio.Future[str] = loop.create_future()

    def sink(_f: object, s: str, _p: float, _ts: object, _v: object, b: Any) -> None:
        if not got.done():
            est = "with est. bid/ask" if b and b.get("bid") else "no bid/ask"
            got.set_result(f"  first update received ({s}, {est})")

    feed.sink = sink
    feed.set_symbols({"SPY", "AAPL"})
    try:
        deadline = loop.time() + 30
        while not got.done() and loop.time() < deadline:
            if feed.state == "down":
                raise RuntimeError(feed.last_error or "tiingo ws down")
            if feed.heartbeats and loop.time() > deadline - 15:
                return "  subscribed (heartbeat), no update in 15 s (outside 24x5 hours?)"
            await asyncio.sleep(0.2)
        if not got.done():
            raise TimeoutError("no update or heartbeat in 30 s")
        return got.result()
    finally:
        await feed.stop()


# Backend-owned streams (stream domain) that are not DataProviders.
STREAM_PROBES: dict[str, Callable[[], Awaitable[str]]] = {
    "coinbase": _probe_coinbase,
    "finnhub-ws": _probe_finnhub_ws,
    "tiingo-ws": _probe_tiingo_ws,
}


def _detail(result: object) -> str:
    """Counters a probe reports (EODHD: calls spent today); never values or keys."""
    if isinstance(result, dict) and "used" in result:
        return f"  calls today {result['used']}/{result.get('daily_limit')} ({result.get('day')})"
    if isinstance(result, list) and result and hasattr(result[0], "day"):
        nxt = sorted(e.day for e in result)[-1]
        return f"  {len(result)} calendar entries, last {nxt.isoformat()}"
    if isinstance(result, list) and result and hasattr(result[0], "headline"):
        return f"  {len(result)} headlines, newest {result[0].published.isoformat()}"
    bars = getattr(result, "bars", None)
    if isinstance(bars, list) and bars:
        as_of = getattr(result, "as_of", None)
        return f"  {len(bars)} bars, newest closes {as_of.isoformat() if as_of else 'N.A.'}"
    return ""


def _skip_reason(p: DataProvider) -> str | None:
    if p.name not in PROBES:
        return "no probe defined"
    if not p.enabled:
        return p.disabled_reason or "no key configured"
    if p.opt_in and os.environ.get("NDX_LIVE_YAHOO") != "1":
        return "opt-in, off (NDX_LIVE_YAHOO=1 to include; personal use)"
    return None


async def _run() -> int:
    settings = get_settings()
    redactor.set_values(secret_values(settings))
    failed = 0
    for p in build_providers(settings):
        reason = _skip_reason(p)
        if reason:
            print(f"{p.name:<10} SKIP  {reason}")
            await p.aclose()
            continue
        t0 = time.perf_counter()
        retried = ""
        try:
            try:
                result = await asyncio.wait_for(PROBES[p.name](p), timeout=20)
            except TransientError as first:
                # The app's router retries a transient failure (5xx, timeout); so does this
                # check, once, and says so (ECB's gateway answers 504 now and then).
                retried = f"  (retried after {redactor(str(first))[:60]})"
                await asyncio.sleep(1.0)
                result = await asyncio.wait_for(PROBES[p.name](p), timeout=20)
        except Exception as exc:
            failed += 1
            ms = (time.perf_counter() - t0) * 1000
            msg = redactor(f"{type(exc).__name__}: {exc}")[:160]
            print(f"{p.name:<10} FAIL  {ms:6.0f} ms  {msg}")
        else:
            ms = (time.perf_counter() - t0) * 1000
            print(f"{p.name:<10} OK    {ms:6.0f} ms{_detail(result)}{retried}")
        finally:
            await p.aclose()
    for name, probe in STREAM_PROBES.items():
        t0 = time.perf_counter()
        try:
            detail = await probe()
        except Skip as why:
            print(f"{name:<10} SKIP  {why}")
            continue
        except Exception as exc:
            failed += 1
            ms = (time.perf_counter() - t0) * 1000
            msg = redactor(f"{type(exc).__name__}: {exc}")[:160]
            print(f"{name:<10} FAIL  {ms:6.0f} ms  {msg}")
        else:
            ms = (time.perf_counter() - t0) * 1000
            print(f"{name:<10} OK    {ms:6.0f} ms{detail}")
    return 1 if failed else 0


def main() -> None:
    sys.exit(asyncio.run(_run()))


if __name__ == "__main__":
    main()
