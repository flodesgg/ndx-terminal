"""Offline (SPEC §6.3, §13 step 9, §14 exit criterion): the network is cut inside the test.

Providers make real HTTP calls through httpx; the transport refuses to connect while `cut` is
set, exactly what a dead network looks like to the backend (httpx.ConnectError).
"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, ClassVar

import httpx
import pytest

from ndx_server.barstore import BarStore
from ndx_server.config import Settings
from ndx_server.live import Client, LiveHub
from ndx_server.market import MarketService
from ndx_server.models import AssetClass, Bar, Instrument, Interval, Latency, Quote
from ndx_server.providers.base import BarSeries, Capability, DataProvider, NetworkError
from ndx_server.providers.http import get_json
from ndx_server.providers.network import NetworkMonitor
from ndx_server.providers.ratelimit import TokenBucket
from ndx_server.providers.router import ProviderRouter, RouterError

from .conftest import make_client

DAY = 86400


class Net:
    """The machine's network: `cut` makes every connection fail."""

    def __init__(self) -> None:
        self.cut = False
        self.requests = 0

    def handler(self, request: httpx.Request) -> httpx.Response:
        if self.cut:
            raise httpx.ConnectError("[Errno 8] nodename nor servname provided", request=request)
        self.requests += 1
        sym = request.url.params.get("s", "X")
        if request.url.path == "/bars":
            today = int(datetime.now(UTC).timestamp()) // DAY
            return httpx.Response(
                200, json=[[d * DAY, 1, 2, 0.5, 1.5, 10] for d in range(today - 5, today)]
            )
        return httpx.Response(200, json={"s": sym, "p": 100.0 + self.requests})


class HttpProvider(DataProvider):
    capabilities: ClassVar[dict[Capability, frozenset[AssetClass]]] = {
        Capability.QUOTE: frozenset({AssetClass.EQUITY}),
        Capability.BARS: frozenset({AssetClass.EQUITY}),
    }

    def __init__(self, net: Net, name: str = "httpfake") -> None:
        super().__init__(TokenBucket(1000, 1000))
        self.name = name  # type: ignore[misc]
        self.label = name.upper()  # type: ignore[misc]
        self.client = httpx.AsyncClient(transport=httpx.MockTransport(net.handler))

    def latency(self, asset: AssetClass) -> tuple[Latency, int | None]:
        return Latency.DELAYED, 15

    async def quote(self, inst: Instrument) -> Quote:
        d = await get_json(self.client, "https://x.test/q", self.name, params={"s": inst.symbol})
        return Quote(symbol=inst.symbol, price=d["p"])

    async def bars(self, inst: Instrument, interval: Interval, lookback_days: int) -> BarSeries:
        rows = await get_json(self.client, "https://x.test/bars", self.name)
        bars = [Bar(t=r[0], o=r[1], h=r[2], l=r[3], c=r[4], v=r[5]) for r in rows]
        return BarSeries(bars=bars, tz="UTC", utc_offset_s=0)


def _router(net: Net, *providers: DataProvider) -> ProviderRouter:
    monitor = NetworkMonitor(probe=lambda: _probe(net), base_s=0.01, cap_s=0.05)
    chain = list(providers) or [HttpProvider(net)]
    # one retry, as in the app: two connection failures in a row = offline
    return ProviderRouter(chain, retry_delays=(0.0,), network=monitor)


async def _probe(net: Net) -> bool:
    return not net.cut


def _inst(s: str = "AAPL") -> Instrument:
    return Instrument(symbol=s, asset_class=AssetClass.EQUITY, display=s)


async def _quote(router: ProviderRouter, key: str = "AAPL", ttl: float = 0.01) -> Any:
    return await router.fetch(
        Capability.QUOTE,
        AssetClass.EQUITY,
        key,
        ttl,
        lambda p: p.quote(_inst(key)),
        inst=_inst(key),
    )


async def test_connect_failure_is_a_network_error() -> None:
    net = Net()
    net.cut = True
    with pytest.raises(NetworkError):
        await HttpProvider(net).quote(_inst())


async def test_offline_serves_cache_as_stale_and_recovers() -> None:
    net = Net()
    router = _router(net)
    q, meta = await _quote(router)
    assert not meta.stale and not router.network.offline
    await asyncio.sleep(0.02)  # the cached quote expires
    net.cut = True
    q2, meta2 = await _quote(router)
    assert router.network.offline
    assert q2.price == q.price and meta2.stale and meta2.cached and meta2.tag == "STALE"
    assert meta2.fetched_at == meta.fetched_at  # the age of the copy, not "now"
    # offline: no new requests are attempted until the probe says the network is back
    calls = router.providers[0].calls
    await _quote(router)
    assert router.providers[0].calls == calls
    # an open breaker is not the provider's fault: network errors never trip it
    assert router.providers[0].breaker.state == "closed"
    # network back -> the probe (exponential backoff with jitter) brings us online
    net.cut = False
    for _ in range(100):
        if not router.network.offline:
            break
        await asyncio.sleep(0.01)
    assert not router.network.offline
    q3, meta3 = await _quote(router)
    assert not meta3.stale and q3.price != q.price
    await router.aclose()


async def test_nothing_cached_offline_is_an_error_not_a_value() -> None:
    net = Net()
    net.cut = True
    router = _router(net)
    with pytest.raises(RouterError):
        await _quote(router, "MSFT")
    await router.aclose()


@pytest.mark.parametrize("name", ["fred", "tiingo"])
async def test_memory_only_values_are_never_served_offline(name: str) -> None:
    net = Net()
    router = _router(net, HttpProvider(net, name))
    await _quote(router)
    await asyncio.sleep(0.02)
    net.cut = True
    with pytest.raises(RouterError):
        await _quote(router)
    await router.aclose()


async def test_coingecko_copy_older_than_24h_is_not_served() -> None:
    net = Net()
    router = _router(net, HttpProvider(net, "coingecko"))
    await _quote(router)
    entry = router.cache.peek("quote:AAPL")
    assert entry is not None
    value, meta = entry.value
    old = meta.model_copy(update={"fetched_at": datetime.now(UTC) - timedelta(hours=25)})
    router.cache.set("quote:AAPL", (value, old), 0.001)
    await asyncio.sleep(0.01)
    net.cut = True
    with pytest.raises(RouterError):
        await _quote(router)
    await router.aclose()


async def test_batch_quotes_offline_are_stale_copies() -> None:
    net = Net()
    router = _router(net)
    svc = MarketService(router)
    await svc.quotes(["AAPL", "MSFT"])
    for k in ("quote:AAPL", "quote:MSFT"):
        e = router.cache.peek(k)
        assert e is not None
        router.cache.set(k, e.value, 0.001)
    await asyncio.sleep(0.01)
    net.cut = True
    res = await svc.quotes(["AAPL", "MSFT", "NVDA"])
    by = {i.symbol: i for i in res.items}
    assert by["AAPL"].meta is not None and by["AAPL"].meta.stale
    assert by["MSFT"].meta is not None and by["MSFT"].meta.tag == "STALE"
    assert by["NVDA"].data is None and by["NVDA"].error  # never fetched: N.A.
    assert router.network.offline
    await router.aclose()


async def test_daily_bars_offline_come_from_the_bar_store_as_stale(tmp_path: Path) -> None:
    net = Net()
    store = BarStore(tmp_path / "b.duckdb")
    # a previous session stored bars, fetched days ago (expired)
    today = int(datetime.now(UTC).timestamp()) // DAY
    store.put(
        "AAPL",
        "1d",
        BarSeries(
            bars=[Bar(t=d * DAY, o=1, h=1, l=1, c=1, v=1) for d in range(today - 30, today - 3)],
            tz="UTC",
            utc_offset_s=0,
        ),
        "HTTPFAKE",
        Latency.EOD,
        datetime.now(UTC) - timedelta(days=4),
    )
    net.cut = True
    svc = MarketService(_router(net), store)
    res = await svc.bars("AAPL", "1d", None)
    assert res.meta.stale and res.meta.cached and res.meta.tag == "STALE"
    assert len(res.data) == 27
    await svc.router.aclose()


async def test_hub_pushes_stale_tags_when_the_network_drops() -> None:
    net = Net()
    router = _router(net)
    hub = LiveHub(MarketService(router), stream_crypto=False)

    class WS:
        async def send_text(self, _: str) -> None:  # pragma: no cover
            return None

    c = Client(WS())  # type: ignore[arg-type]
    await hub._subscribe(c, ["quote:AAPL"])
    await hub.poll_once()
    e = router.cache.peek("quote:AAPL")
    assert e is not None
    router.cache.set("quote:AAPL", e.value, 0.001)
    await asyncio.sleep(0.01)
    net.cut = True
    await hub.poll_once()
    msgs = [m for m in (c.queue.get_nowait() for _ in range(c.queue.qsize())) if m]
    msgs += c.pending.values()
    assert any('"tag":"STALE"' in m for m in msgs)
    await hub.stop()
    await router.aclose()


def test_health_reports_offline(settings: Settings) -> None:
    with make_client(settings) as c:
        h = c.get("/health").json()
        assert h["network"] == "online" and h["offline_since"] is None
        state = c.app.state.ndx  # type: ignore[attr-defined]
        state.router.network.failure(NetworkError("down"))
        state.router.network.failure(NetworkError("down"))
        h = c.get("/health").json()
        assert h["network"] == "offline" and h["offline_since"] is not None


def test_demo_network_switch_is_demo_only(settings: Settings) -> None:
    with make_client(settings) as c:
        assert c.put("/demo/network", json={"up": False}).status_code == 404


async def test_demo_network_cut_goes_offline_and_back(settings: Settings) -> None:
    from ndx_server.demo import DemoProvider
    from ndx_server.main import create_app

    settings.demo = True
    app = create_app(settings, providers=[DemoProvider()], start_background=False)
    state = app.state.ndx
    market: MarketService = state.services["market"]
    first = await market.quote("AAPL")
    assert first.meta.tag == "DEMO"
    demo = state.router.providers[0]
    demo.network_up = False
    state.router.cache.set("quote:AAPL", (first.data, first.meta), 0.001)
    await asyncio.sleep(0.01)
    cut = await market.quote("AAPL")
    assert state.router.network.offline and cut.meta.tag == "STALE"
    demo.network_up = True
    for _ in range(60):
        if not state.router.network.offline:
            break
        await asyncio.sleep(0.1)
    assert not state.router.network.offline
    await state.router.aclose()
