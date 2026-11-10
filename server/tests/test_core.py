from __future__ import annotations

import asyncio
import time
from datetime import UTC, datetime

import pytest

from ndx_server.config import Settings
from ndx_server.markets import MarketClock
from ndx_server.models import AssetClass, Instrument, Quote
from ndx_server.providers.base import (
    Capability,
    DataProvider,
    NotFound,
    TransientError,
)
from ndx_server.providers.cache import TTLCache
from ndx_server.providers.ratelimit import TokenBucket
from ndx_server.providers.router import ProviderRouter, RouterError
from ndx_server.symbols import SymbolError, classify, to_yahoo


class FakeProvider(DataProvider):
    name = "fake"
    label = "Fake"
    capabilities = {Capability.QUOTE: frozenset({AssetClass.EQUITY})}

    def __init__(
        self, name: str, behaviour: list[object], key_required: bool = False, key: str = ""
    ) -> None:
        super().__init__(TokenBucket(100, 100), api_key=key)
        self.name = name  # type: ignore[misc]
        self.label = name.upper()  # type: ignore[misc]
        self.requires_key = key_required  # type: ignore[misc]
        self.behaviour = behaviour
        self.n = 0

    async def quote(self, inst: Instrument) -> Quote:
        b = self.behaviour[min(self.n, len(self.behaviour) - 1)]
        self.n += 1
        if isinstance(b, Exception):
            raise b
        return Quote(symbol=inst.symbol, price=float(b))  # type: ignore[arg-type]


AAPL = Instrument(symbol="AAPL", asset_class=AssetClass.EQUITY, display="AAPL")


async def _q(router: ProviderRouter, key: str = "AAPL") -> tuple[Quote, object]:
    return await router.fetch(Capability.QUOTE, AssetClass.EQUITY, key, 10, lambda p: p.quote(AAPL))


async def test_router_fallback_to_second_provider() -> None:
    a = FakeProvider("a", [NotFound("nope")])
    b = FakeProvider("b", [42])
    router = ProviderRouter([a, b], retry_delays=())
    q, meta = await _q(router)
    assert q.price == 42
    assert meta.source == "B"  # type: ignore[attr-defined]
    assert meta.attempts == ["a", "b"]  # type: ignore[attr-defined]
    assert a.status().state == "degraded"


async def test_router_retries_transient_then_succeeds() -> None:
    a = FakeProvider("a", [TransientError("503"), 7])
    router = ProviderRouter([a], retry_delays=(0.0,))
    q, _ = await _q(router)
    assert q.price == 7 and a.n == 2


async def test_router_all_not_found() -> None:
    router = ProviderRouter([FakeProvider("a", [NotFound("x")])], retry_delays=())
    with pytest.raises(RouterError) as ei:
        await _q(router)
    assert ei.value.code == "not_found"


async def test_router_skips_provider_without_key() -> None:
    a = FakeProvider("a", [1], key_required=True)
    router = ProviderRouter([a], retry_delays=())
    with pytest.raises(RouterError) as ei:
        await _q(router)
    assert ei.value.code == "no_provider"
    assert a.status().state == "disabled"


async def test_router_caches_success_not_errors() -> None:
    a = FakeProvider("a", [TransientError("x"), 5])
    router = ProviderRouter([a], retry_delays=())
    with pytest.raises(RouterError):
        await _q(router)
    q, meta = await _q(router)
    assert q.price == 5 and not meta.cached  # type: ignore[attr-defined]
    _, meta2 = await _q(router)
    assert meta2.cached and a.n == 2  # type: ignore[attr-defined]


async def test_cache_single_flight() -> None:
    cache = TTLCache()
    calls = 0

    async def fetch() -> int:
        nonlocal calls
        calls += 1
        await asyncio.sleep(0.05)
        return 1

    results = await asyncio.gather(*(cache.get_or_fetch("k", 10, fetch) for _ in range(5)))
    assert calls == 1 and all(r[0] == 1 for r in results)


async def test_token_bucket_limits() -> None:
    b = TokenBucket(rate=10, capacity=2)
    assert await b.acquire(0) and await b.acquire(0)
    assert not await b.acquire(0)
    t = time.monotonic()
    assert await b.acquire(1)
    assert time.monotonic() - t >= 0.05


@pytest.mark.parametrize(
    ("raw", "ac", "sym", "yahoo"),
    [
        ("aapl", AssetClass.EQUITY, "AAPL", "AAPL"),
        ("NOVO-B.CO", AssetClass.EQUITY, "NOVO-B.CO", "NOVO-B.CO"),
        ("^GSPC", AssetClass.INDEX, "^GSPC", "^GSPC"),
        ("EURUSD", AssetClass.FX, "EURUSD", "EURUSD=X"),
        ("eur/dkk", AssetClass.FX, "EURDKK", "EURDKK=X"),
        ("USDJPY", AssetClass.FX, "USDJPY", "JPY=X"),
        ("BTCUSDT", AssetClass.CRYPTO, "BTCUSDT", "BTC-USD"),
        ("CL=F", AssetClass.INDEX, "CL=F", "CL=F"),
    ],
)
def test_classify(raw: str, ac: AssetClass, sym: str, yahoo: str) -> None:
    inst = classify(raw)
    assert (inst.asset_class, inst.symbol, to_yahoo(inst)) == (ac, sym, yahoo)


@pytest.mark.parametrize("raw", ["", "AA PL", "$$$"])
def test_classify_rejects(raw: str) -> None:
    with pytest.raises(SymbolError):
        classify(raw)


def test_market_clock_known_times() -> None:
    clock = MarketClock()
    # Wednesday 2026-11-04 15:00 UTC = 10:00 New York: NYSE open, Tokyo closed.
    st = {s.code: s for s in clock.status(datetime(2026, 11, 4, 15, 0, tzinfo=UTC))}
    assert st["NYSE"].is_open and not st["TSE"].is_open
    # Thanksgiving 2026-11-26: NYSE holiday.
    st = {s.code: s for s in clock.status(datetime(2026, 11, 26, 16, 0, tzinfo=UTC))}
    assert not st["NYSE"].is_open and st["NYSE"].holiday
    # Nordic, Euronext and Swiss calendars (1b step 2): Wednesday 2026-11-04 10:00 UTC all open.
    st = {s.code: s for s in clock.status(datetime(2026, 11, 4, 10, 0, tzinfo=UTC))}
    for code in ("STO", "OSL", "HEL", "PAR", "AMS", "SIX"):
        assert st[code].is_open, code
    # Christmas Eve 2026 (Thursday): Nordic and Swiss closed for the day, Euronext open (half day).
    st = {s.code: s for s in clock.status(datetime(2026, 12, 24, 10, 0, tzinfo=UTC))}
    for code in ("STO", "OSL", "HEL", "SIX"):
        assert not st[code].is_open and st[code].holiday, code
    assert st["PAR"].is_open and st["AMS"].is_open


def test_market_clock_next_change_honours_lunch_breaks() -> None:
    """Review 1b #1: TSE breaks 11:30-12:30 JST, HKEX 12:00-13:00 HKT (Tuesday 2026-11-10)."""
    clock = MarketClock()

    def at(h: int, m: int) -> dict[str, tuple[bool | None, datetime | None]]:
        st = clock.status(datetime(2026, 11, 10, h, m, tzinfo=UTC))
        return {s.code: (s.is_open, s.next_change) for s in st}

    day = datetime(2026, 11, 10, tzinfo=UTC)
    # Morning session: the next change is the lunch close, not the day's close.
    assert at(1, 0)["TSE"] == (True, day.replace(hour=2, minute=30))
    # Lunch break: it reopens the same day.
    assert at(3, 0)["TSE"] == (False, day.replace(hour=3, minute=30))
    assert at(4, 30)["HKEX"] == (False, day.replace(hour=5, minute=0))
    # Afternoon session and after the close are as before.
    assert at(5, 0)["TSE"] == (True, day.replace(hour=6, minute=30))
    assert at(9, 0)["TSE"] == (False, datetime(2026, 11, 11, 0, 0, tzinfo=UTC))


def test_provider_status_carries_its_section_6_1_tag() -> None:
    """Review 1b #14: the status bar shows §6.1 tags (RT·TRD, DEMO), not latency classes."""
    from ndx_server.demo import DemoProvider
    from ndx_server.providers.binance import BinanceProvider
    from ndx_server.providers.finnhub import FinnhubProvider
    from ndx_server.providers.sec import SecEdgarProvider
    from ndx_server.providers.yahoo import YahooProvider

    assert FinnhubProvider(api_key="k").status().tag == "RT·TRD"
    assert BinanceProvider().status().tag == "RT"
    assert DemoProvider().status().tag == "DEMO"
    # No stated delay (Yahoo) and timestamped records (SEC) are CACHE, never DLY or STATIC.
    assert YahooProvider().status().tag == "CACHE"
    assert SecEdgarProvider(user_agent="test").status().tag == "CACHE"


def test_barstore_survives_a_locked_file(tmp_path: object) -> None:
    import subprocess
    import sys
    from pathlib import Path

    from ndx_server.barstore import BarStore
    from ndx_server.models import Bar, Latency
    from ndx_server.providers.base import BarSeries

    db = Path(str(tmp_path)) / "bars.duckdb"
    holder = subprocess.Popen(  # another process keeps the DuckDB file open (and locked)
        [
            sys.executable,
            "-c",
            f"import duckdb, time; c = duckdb.connect({str(db)!r}); print('ok', flush=True); "
            "time.sleep(30)",
        ],
        stdout=subprocess.PIPE,
        text=True,
    )
    try:
        assert holder.stdout is not None and holder.stdout.readline().strip() == "ok"
        store = BarStore(db)
        assert not store.enabled
        series = BarSeries(bars=[Bar(t=0, o=1, h=1, l=1, c=1, v=1)], tz="UTC", utc_offset_s=0)
        store.put("X", "1d", series, "src", Latency.EOD, datetime.now(UTC))  # no-op
        assert store.get("X", "1d") is None
        store.close()
    finally:
        holder.kill()


def test_demo_lists_opt_in_providers_as_off_for_demo(settings: Settings) -> None:
    """Review 1b #10: in DEMO nothing is fetched, whatever the opt-in says; the reason shown for
    Yahoo is DEMO, not 'opt-in' (which stayed even after yfinance was enabled in PDF)."""
    from ndx_server.providers.registry import DEMO_OFFLINE, demo_offline_statuses

    st = {s.name: s for s in demo_offline_statuses(settings)}
    assert st["yahoo"].state == "disabled" and st["yahoo"].detail == DEMO_OFFLINE
    assert st["finnhub"].detail == "no API key"  # a real reason the user can act on stays
