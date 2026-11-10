"""Token buckets from the PROVIDERS.md §6 budgets, backoff with jitter, circuit breaker,
in-flight coalescing and the PROV counters (SPEC §6.3)."""

from __future__ import annotations

import asyncio
import contextlib
from typing import ClassVar

from ndx_server.config import Settings
from ndx_server.models import AssetClass, Instrument, Quote
from ndx_server.providers.base import (
    Capability,
    DataProvider,
    NotFound,
    PartialBatch,
    TransientError,
)
from ndx_server.providers.breaker import CircuitBreaker
from ndx_server.providers.budgets import BUDGETS, budget
from ndx_server.providers.quota import DailyQuota
from ndx_server.providers.ratelimit import TokenBucket
from ndx_server.providers.registry import build_providers
from ndx_server.providers.router import ProviderRouter, RouterError, backoff_delay

# ---------- budgets & quota counters ----------


def test_budgets_match_providers_md_section_6() -> None:
    assert (BUDGETS["finnhub"].limit, BUDGETS["finnhub"].period_s, BUDGETS["finnhub"].burst) == (
        55,
        60,
        10,
    )
    assert (BUDGETS["massive"].limit, BUDGETS["massive"].period_s) == (4, 60)
    assert (BUDGETS["eodhd"].limit, BUDGETS["eodhd"].period_s) == (18, 86400)
    assert (BUDGETS["tiingo"].limit, BUDGETS["tiingo"].period_s) == (40, 3600)
    assert (BUDGETS["coingecko"].limit, BUDGETS["coingecko"].period_s) == (30, 60)
    assert (BUDGETS["fred"].limit, BUDGETS["sec"].limit, BUDGETS["sec"].period_s) == (100, 5, 1)
    assert BUDGETS["alphavantage"].limit == 20 and BUDGETS["alphavantage"].period_s == 86400


def test_every_registered_provider_uses_its_budget(settings: Settings) -> None:
    for p in build_providers(settings):
        b = budget(p.name)
        assert b is not None, p.name
        # The budget is enforced on what the provider really spends: the router's bucket, or
        # its own counter when one router call is not one request (EODHD's persisted daily
        # allowance; ECB/NBU, where one table request serves every pair).
        q = p.quota_source()
        if isinstance(q, DailyQuota):
            assert q.limit == b.limit and b.period_s == 86400.0, p.name
        else:
            assert q.limit == b.limit and q.period_s == b.period_s, p.name


async def test_quota_counts_real_acquisitions_per_window() -> None:
    bucket = TokenBucket.from_budget(limit=5, period_s=60, burst=5)
    for _ in range(3):
        assert await bucket.acquire(max_wait=0)
    q = bucket.quota()
    assert (q.limit, q.used, q.left, q.period) == (5, 3, 2, "min")
    # an empty bucket refuses rather than waiting past max_wait, and does not count
    for _ in range(2):
        assert await bucket.acquire(max_wait=0)
    assert not await bucket.acquire(max_wait=0)
    assert bucket.quota().used == 5 and bucket.quota().left == 0


def test_backoff_is_exponential_with_jitter() -> None:
    for attempt in range(5):
        nominal = min(8.0, 0.4 * 2**attempt)
        d = backoff_delay(attempt, base=0.4, cap=8.0)
        assert nominal / 2 <= d <= nominal
    assert len({backoff_delay(3, base=1.0, cap=60.0) for _ in range(20)}) > 1


# ---------- circuit breaker ----------


def test_breaker_opens_after_n_failures_and_probes_half_open() -> None:
    t = [0.0]
    br = CircuitBreaker(threshold=3, reset_after_s=10, clock=lambda: t[0])
    for _ in range(2):
        br.failure()
    assert br.state == "closed" and br.allow()
    br.failure()
    assert br.state == "open" and not br.allow()
    t[0] = 10.0
    assert br.allow() and br.state == "half_open"  # one probe
    assert not br.allow()  # nobody else while the probe runs
    br.failure()  # probe failed: open again, longer wait
    assert br.state == "open"
    t[0] = 25.0
    assert not br.allow()
    t[0] = 30.0
    assert br.allow()
    br.success()
    assert br.state == "closed" and br.allow()


class Flaky(DataProvider):
    capabilities: ClassVar[dict[Capability, frozenset[AssetClass]]] = {
        Capability.QUOTE: frozenset({AssetClass.EQUITY})
    }

    def __init__(self, name: str, fail: bool, delay: float = 0.0) -> None:
        super().__init__(TokenBucket(1000, 1000))
        self.name = name  # type: ignore[misc]
        self.label = name.title()  # type: ignore[misc]
        self.fail = fail
        self.delay = delay
        self.calls_made = 0
        self.batches: list[list[str]] = []

    async def quote(self, inst: Instrument) -> Quote:
        self.calls_made += 1
        await asyncio.sleep(self.delay)
        if self.fail:
            raise TransientError("boom")
        return Quote(symbol=inst.symbol, price=1.0)

    async def quotes(self, insts: list[Instrument]) -> dict[str, Quote]:
        self.batches.append([i.symbol for i in insts])
        await asyncio.sleep(self.delay)
        out = PartialBatch()
        for i in insts:
            out[i.symbol] = Quote(symbol=i.symbol, price=1.0)
        return out


def _inst(s: str) -> Instrument:
    return Instrument(symbol=s, asset_class=AssetClass.EQUITY, display=s)


async def test_router_skips_an_open_breaker_and_falls_back() -> None:
    bad, good = Flaky("bad", fail=True), Flaky("good", fail=False)
    bad.breaker = CircuitBreaker(threshold=2, reset_after_s=60)
    router = ProviderRouter([bad, good], retry_delays=())
    for i in range(3):
        _, meta = await router.fetch(
            Capability.QUOTE, AssetClass.EQUITY, f"K{i}", 5, lambda p: p.quote(_inst("AAPL"))
        )
        assert meta.source == "Good"
    assert bad.calls_made == 2  # third request did not touch the open provider
    st = bad.status()
    assert st.breaker == "open" and st.state == "down"


async def test_not_found_is_an_answer_not_a_breaker_failure() -> None:
    class Missing(Flaky):
        async def quote(self, inst: Instrument) -> Quote:
            raise NotFound(inst.symbol)

    p = Missing("m", fail=False)
    p.breaker = CircuitBreaker(threshold=1, reset_after_s=60)
    router = ProviderRouter([p], retry_delays=())
    for i in range(2):
        try:
            await router.fetch(
                Capability.QUOTE, AssetClass.EQUITY, f"K{i}", 5, lambda q: q.quote(_inst("X"))
            )
        except RouterError as e:
            assert e.code == "not_found"
    assert p.breaker.state == "closed"


# ---------- in-flight coalescing ----------


async def test_concurrent_batches_share_in_flight_keys() -> None:
    p = Flaky("p", fail=False, delay=0.05)
    router = ProviderRouter([p], retry_delays=())

    async def call(prov: DataProvider, insts: list[Instrument]) -> dict[str, Quote]:
        return await prov.quotes(insts)

    a = {"AAPL": _inst("AAPL"), "MSFT": _inst("MSFT")}
    b = {"MSFT": _inst("MSFT"), "NVDA": _inst("NVDA")}
    ra, rb = await asyncio.gather(
        router.fetch_batch(Capability.QUOTE, AssetClass.EQUITY, a, 5, call),
        router.fetch_batch(Capability.QUOTE, AssetClass.EQUITY, b, 5, call),
    )
    requested = sorted(s for batch in p.batches for s in batch)
    assert requested == ["AAPL", "MSFT", "NVDA"]  # MSFT fetched once
    assert not isinstance(ra["MSFT"], RouterError) and not isinstance(rb["MSFT"], RouterError)


async def test_concurrent_single_fetches_coalesce() -> None:
    p = Flaky("p", fail=False, delay=0.05)
    router = ProviderRouter([p], retry_delays=())
    await asyncio.gather(
        *(
            router.fetch(
                Capability.QUOTE, AssetClass.EQUITY, "AAPL", 5, lambda q: q.quote(_inst("AAPL"))
            )
            for _ in range(5)
        )
    )
    assert p.calls_made == 1


# ---------- PROV counters ----------


async def test_status_reports_latency_percentiles_error_rate_and_quota() -> None:
    p = Flaky("p", fail=False, delay=0.01)
    p.rate = TokenBucket.from_budget(limit=100, period_s=60, burst=100)
    router = ProviderRouter([p], retry_delays=())
    for i in range(10):
        await router.fetch(
            Capability.QUOTE, AssetClass.EQUITY, f"K{i}", 5, lambda q: q.quote(_inst("AAPL"))
        )
    p.fail = True
    with contextlib.suppress(RouterError):
        await router.fetch(
            Capability.QUOTE, AssetClass.EQUITY, "BAD", 5, lambda q: q.quote(_inst("AAPL"))
        )
    st = p.status()
    assert st.latency_p50_ms is not None and st.latency_p95_ms is not None
    assert 5 <= st.latency_p50_ms <= st.latency_p95_ms
    assert st.error_rate is not None and abs(st.error_rate - 1 / 11) < 1e-9
    assert st.quota_limit == 100 and st.quota_used == 11 and st.quota_left == 89
    assert st.quota_period == "min" and st.last_ok is not None


def test_idle_provider_has_no_invented_numbers() -> None:
    st = Flaky("p", fail=False).status()
    assert st.latency_p50_ms is None and st.latency_p95_ms is None and st.error_rate is None
