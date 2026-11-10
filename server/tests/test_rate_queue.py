"""Tight-budget sources (Massive: 4 calls/min): a request over the budget takes a place in
the provider's queue and is repeated by the client, instead of failing; a window not in focus
does not spend the budget at all (defer)."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, ClassVar

import httpx
import pytest
import respx

from ndx_server.barstore import BarStore
from ndx_server.config import Settings
from ndx_server.market import MarketService
from ndx_server.models import AssetClass, Bar, Instrument, Interval, Latency
from ndx_server.providers.base import BarSeries, Capability, DataProvider
from ndx_server.providers.cache import TTLCache
from ndx_server.providers.massive import BASE, MassiveProvider
from ndx_server.providers.ratelimit import QUEUE_GRACE_S, TokenBucket
from ndx_server.providers.router import ProviderRouter, RouterError
from ndx_server.symbols import classify

from .conftest import make_client
from .helpers import fixture


class Clock:
    """Stands in for time.monotonic inside the token bucket."""

    def __init__(self) -> None:
        self.t = 1000.0

    def __call__(self) -> float:
        return self.t


@pytest.fixture
def clock(monkeypatch: pytest.MonkeyPatch) -> Clock:
    c = Clock()
    monkeypatch.setattr("ndx_server.providers.ratelimit.time.monotonic", c)
    return c


class Bars(DataProvider):
    """Daily bars for any equity; counts calls."""

    name = "scarcebars"
    label = "Scarce Bars"
    scarce = True
    capabilities: ClassVar[dict[Capability, frozenset[AssetClass]]] = {
        Capability.BARS: frozenset({AssetClass.EQUITY}),
    }

    def __init__(self, rate: TokenBucket | None = None) -> None:
        super().__init__(rate or TokenBucket.per_minute(4, 1))
        self.asked: list[str] = []

    async def bars(self, inst: Instrument, interval: Interval, lookback_days: int) -> BarSeries:
        self.asked.append(inst.symbol)
        bar = Bar(t=86400 * 20000, o=1, h=2, l=0.5, c=1.5, v=10)
        return BarSeries(
            bars=[bar], tz="America/New_York", utc_offset_s=-18000, as_of=datetime.now(UTC)
        )


class Plenty(Bars):
    name = "plentybars"
    label = "Plenty Bars"
    scarce = False


def router_with(*providers: DataProvider) -> ProviderRouter:
    order = [p.name for p in providers]
    prefs = {(Capability.BARS, AssetClass.EQUITY): order}
    return ProviderRouter(list(providers), cache=TTLCache(), preferences=prefs, retry_delays=())


async def fetch(router: ProviderRouter, symbol: str, defer: bool = False) -> Any:
    inst = classify(symbol)
    value, meta = await router.fetch(
        Capability.BARS,
        inst.asset_class,
        f"{symbol}:1d:30",
        60.0,
        lambda p: p.bars(inst, "1d", 30),
        inst=inst,
        defer=defer,
    )
    return value, meta


# ----- the bucket's queue -----


def test_turns_are_first_come_first_served(clock: Clock) -> None:
    b = TokenBucket.per_minute(4, 1)  # one token every 15 s
    assert b.reserve("a", 180) == 0.0  # a token was there: "a" may go now
    assert b.reserve("b", 180) == pytest.approx(15)
    assert b.reserve("c", 180) == pytest.approx(30)
    assert b.reserve("b", 180) == pytest.approx(15)  # asking again keeps the same place
    assert b.reserve("z", 40) is None  # 45 s away: over the cap, no place taken
    assert b.queued() == 3
    clock.t += 10
    assert b.claim("b") == pytest.approx(5)  # not yet
    assert b.claim("nobody") is None
    clock.t += 5
    assert b.claim("b") == 0.0 and b.queued() == 2
    assert b.quota().used == 1  # counted when the turn is used, not when queued


def test_a_turn_nobody_comes_back_for_lapses(clock: Clock) -> None:
    b = TokenBucket.per_minute(4, 1)
    b.reserve("gone", 180)
    clock.t += QUEUE_GRACE_S + 1
    assert b.claim("gone") is None and b.queued() == 0


async def test_queued_turns_hold_up_plain_acquires(clock: Clock) -> None:
    b = TokenBucket.per_minute(4, 1)
    assert b.reserve("a", 180) == 0.0
    assert b.reserve("b", 180) == pytest.approx(15)
    # "b" owes a token: a newcomer would have to wait 30 s, past its 3 s limit
    assert not await b.acquire(max_wait=3.0)


# ----- the router -----


async def test_over_the_budget_a_request_queues_instead_of_failing(clock: Clock) -> None:
    massive, fallback = Bars(), Plenty()
    router = router_with(massive, fallback)
    await fetch(router, "AAPL")
    with pytest.raises(RouterError) as e:
        await fetch(router, "MSFT")
    err = e.value
    assert err.code == "rate_limited" and err.provider == "Scarce Bars"
    assert err.retry_after_s == pytest.approx(15, abs=0.1)
    assert "queued" in str(err)
    # the turn is held: no other source's budget is spent meanwhile
    assert fallback.asked == [] and massive.asked == ["AAPL"]
    clock.t += 9
    with pytest.raises(RouterError) as early:
        await fetch(router, "MSFT")  # the client came back too soon: same place
    assert early.value.retry_after_s == pytest.approx(6, abs=0.1)
    clock.t += 6
    value, meta = await fetch(router, "MSFT")
    assert value.bars and meta.source == "Scarce Bars" and massive.asked == ["AAPL", "MSFT"]
    assert massive.errors == 0  # waiting in the queue is not a provider failure
    await router.aclose()


async def test_a_plain_budget_still_falls_through_to_the_next_source(clock: Clock) -> None:
    class Cheap(Plenty):
        name = "cheap"
        label = "Cheap"

    first = Cheap(TokenBucket.per_minute(4, 1))
    second = Plenty()
    router = router_with(first, second)
    await fetch(router, "AAPL")
    _, meta = await fetch(router, "MSFT")
    assert meta.source == "Plenty Bars"
    await router.aclose()


async def test_deferred_request_does_not_spend_a_scarce_budget(clock: Clock) -> None:
    massive = Bars()
    router = router_with(massive)
    with pytest.raises(RouterError) as e:
        await fetch(router, "AAPL", defer=True)
    assert e.value.code == "deferred" and e.value.provider == "Scarce Bars"
    assert "loads when the window is focused" in str(e.value)
    assert massive.asked == [] and massive.rate.quota().used == 0
    # once focused it loads; afterwards a deferred ask is answered from the cache
    await fetch(router, "AAPL")
    _, meta = await fetch(router, "AAPL", defer=True)
    assert meta.cached and massive.asked == ["AAPL"]
    await router.aclose()


async def test_deferred_request_is_served_by_a_source_without_a_tight_budget() -> None:
    massive, plenty = Bars(), Plenty()
    router = router_with(massive, plenty)
    _, meta = await fetch(router, "AAPL", defer=True)
    assert meta.source == "Plenty Bars" and massive.asked == []
    await router.aclose()


# ----- Massive: previous-session bars are not asked again within the day -----


@respx.mock
async def test_massive_intraday_bars_are_cached_until_the_next_day() -> None:
    route = respx.get(url__startswith=f"{BASE}/v2/aggs/ticker/AAPL/range/5/minute/").mock(
        return_value=httpx.Response(200, json=fixture("massive_aapl_5m.json")["body"])
    )
    recorded = datetime(2026, 11, 9, 19, 30, tzinfo=UTC)
    massive = MassiveProvider("k" * 32, clock=lambda: recorded)
    router = ProviderRouter([massive], cache=TTLCache(), retry_delays=())
    market = MarketService(router)
    await market.bars("AAPL", "5m", None)
    entry = next(e for k, e in router.cache._data.items() if k.startswith("bars:AAPL:5m"))
    # 2026-11-09 14:30 ET -> next data at 2026-11-10 00:05 ET: 9 h 35 min
    assert entry.ttl == pytest.approx(9 * 3600 + 35 * 60)
    await market.bars("AAPL", "5m", None)
    assert route.call_count == 1
    await router.aclose()


# ----- HTTP -----


def test_queued_and_deferred_answers_over_http(settings: Settings, clock: Clock) -> None:
    with make_client(settings, [Bars()]) as c:
        assert c.get("/bars/AAPL", params={"interval": "5m"}).status_code == 200
        r = c.get("/bars/MSFT", params={"interval": "5m"})
        assert r.status_code == 429 and r.headers["Retry-After"] == "15"
        body = r.json()
        assert body["code"] == "rate_limited" and body["provider"] == "Scarce Bars"
        assert body["retry_after_s"] == pytest.approx(15, abs=0.1)
        d = c.get("/bars/NVDA", params={"interval": "5m", "defer": "true"})
        assert d.status_code == 425
        assert d.json()["code"] == "deferred" and d.json()["provider"] == "Scarce Bars"
        assert d.json()["retry_after_s"] is None


async def test_window_not_in_focus_shows_the_stored_copy_until_focused(tmp_path: Path) -> None:
    massive = Bars()
    router = router_with(massive)
    store = BarStore(tmp_path / "bars.duckdb")
    market = MarketService(router, barstore=store)
    week_ago = datetime.now(UTC) - timedelta(days=7)
    stored = await massive.bars(classify("AAPL"), "1d", 30)
    store.put("AAPL", "1d", stored, "Scarce Bars", Latency.EOD, week_ago)
    massive.asked.clear()
    res = await market.bars("AAPL", "1d", None, defer=True)
    assert res.meta.stale and res.meta.fetched_at == week_ago and massive.asked == []
    with pytest.raises(RouterError, match="loads when the window is focused"):
        await market.bars("MSFT", "1d", None, defer=True)  # nothing stored: wait for focus
    res = await market.bars("AAPL", "1d", None)
    assert not res.meta.stale and massive.asked == ["AAPL"]
    store.close()
    await router.aclose()
