"""Phase 2 review findings A and B: a spent budget is a LIMIT, not an outage, and refusals
known without a request never queue on another provider's per-minute budget."""

from __future__ import annotations

import asyncio
import time
from datetime import UTC, datetime, timedelta
from typing import ClassVar

import httpx
import pytest

from ndx_server.market import MarketService
from ndx_server.models import ProviderState
from ndx_server.providers.base import RateLimited, TransientError
from ndx_server.providers.eodhd import EodhdProvider
from ndx_server.providers.finnhub import FinnhubProvider
from ndx_server.providers.ratelimit import TokenBucket
from ndx_server.providers.registry import PREFERENCES
from ndx_server.providers.router import ProviderRouter

C25 = [
    "MAERSK-A.CO", "MAERSK-B.CO", "ALSYDB.CO", "AMBU-B.CO", "CARL-B.CO", "COLO-B.CO",
    "DANSKE.CO", "DEMANT.CO", "DSV.CO", "FLS.CO", "GMAB.CO", "GN.CO", "ISS.CO", "JYSK.CO",
    "NKT.CO", "NDA-DK.CO", "NOVO-B.CO", "NSIS-B.CO", "ORSTED.CO", "PNDORA.CO", "ROCK-B.CO",
    "RBREW.CO", "TRYG.CO", "VWS.CO", "ZEAL.CO",
]  # fmt: skip


def _no_call(req: httpx.Request) -> httpx.Response:
    raise AssertionError(f"no request expected: {req.url.path}")


def _spent_eodhd(clock: object = None) -> EodhdProvider:
    kw = {"clock": clock} if clock is not None else {}
    eo = EodhdProvider(
        "test", None, client=httpx.AsyncClient(transport=httpx.MockTransport(_no_call)), **kw
    )
    eo._synced = eo.daily.today()
    while eo.daily.try_take():
        pass
    return eo


def _finnhub() -> FinnhubProvider:
    def handler(req: httpx.Request) -> httpx.Response:
        if "company-news" in req.url.path:
            return httpx.Response(200, json=[])
        raise AssertionError(f"unexpected Finnhub call {req.url.path}")

    return FinnhubProvider("test", client=httpx.AsyncClient(transport=httpx.MockTransport(handler)))


async def test_spent_daily_budget_is_limit_not_down() -> None:
    eo = _spent_eodhd()
    svc = MarketService(ProviderRouter([eo], preferences=PREFERENCES), None)
    for sym in C25[:5]:
        await svc.quotes([sym])  # five refusals, one at a time
    await svc.quotes(C25)  # and the batch path
    st = eo.status()
    assert st.state is ProviderState.LIMIT
    assert st.detail is not None and "18/18" in st.detail and "00:00 UTC" in st.detail
    assert st.breaker == "closed" and eo.calls == 0 and eo.errors == 0


async def test_limit_ends_at_the_utc_day_roll() -> None:
    now = [datetime(2026, 11, 10, 23, 0, tzinfo=UTC)]
    eo = _spent_eodhd(lambda: now[0])
    assert eo.status().state is ProviderState.LIMIT
    now[0] += timedelta(hours=2)
    assert eo.status().state is not ProviderState.LIMIT


def test_provider_429_is_limit_until_an_answer() -> None:
    fh = _finnhub()
    for _ in range(6):
        fh.record_error(RateLimited("Finnhub HTTP 429 rate limited"))
    st = fh.status()
    assert st.state is ProviderState.LIMIT and "429" in (st.detail or "")
    fh.record_ok(5.0)
    assert fh.status().state is ProviderState.OK


def test_a_real_outage_still_goes_down() -> None:
    fh = _finnhub()
    fh.record_error(TransientError("Finnhub HTTP 503"))
    assert fh.status().state is ProviderState.DEGRADED
    for _ in range(4):
        fh.record_error(TransientError("Finnhub HTTP 503"))
    assert fh.status().state is ProviderState.DOWN


@pytest.mark.parametrize("one_by_one", [True, False])
async def test_c25_refusals_do_not_hold_up_headlines(one_by_one: bool) -> None:
    # The real run: MON DENMARK C25 with EODHD's day spent, then Q AAPL. Finnhub cannot quote
    # .CO listings; it used to take a 55/min token for each before saying so, and the news
    # request queued behind 25 of them (~17-27 s).
    fh, eo = _finnhub(), _spent_eodhd()
    svc = MarketService(ProviderRouter([fh, eo], preferences=PREFERENCES), None)
    if one_by_one:  # one live snapshot per MON row
        tasks = [asyncio.create_task(svc.quotes([s])) for s in C25]
    else:
        tasks = [asyncio.create_task(svc.quotes(C25))]
    await asyncio.sleep(0)
    t0 = time.perf_counter()
    news = await svc.news("AAPL US EQUITY", 5)
    assert time.perf_counter() - t0 < 1.0 and "Finnhub" in news.meta.source
    await asyncio.gather(*tasks)
    assert fh.rate.quota().used == 1  # the news call only
    assert eo.status().state is ProviderState.LIMIT


async def test_token_wait_is_bounded_by_the_queue_ahead() -> None:
    bucket = TokenBucket.per_minute(55, 1)
    assert await bucket.acquire(max_wait=3.0)  # the burst
    waiters = [asyncio.create_task(bucket.acquire(max_wait=60.0)) for _ in range(25)]
    await asyncio.sleep(0)
    t0 = time.perf_counter()
    assert await bucket.acquire(max_wait=3.0) is False  # 25 turns ahead: refused at once
    assert time.perf_counter() - t0 < 0.1
    for w in waiters:
        w.cancel()


async def test_a_burst_waits_its_turn_unless_a_plain_source_can_take_it(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Real run 2026-11-10 (yfinance DK): WEI asked Yahoo for 48 index bar series at once; with
    # every waiter bounded at 3 s only 13 got a token and YTD/sparklines read N.A. A source
    # with no plain fallback now serves the burst in turn; with one, the overflow moves on.
    from ndx_server.providers import ratelimit

    from .fakes import FakeEquity

    monkeypatch.setattr(ratelimit, "FALL_THROUGH_S", 0.05)

    syms = [f"T{i}" for i in range(30)]

    class Fast(FakeEquity):
        name, label = "fast", "Fast"
        prices: ClassVar[dict[str, float]] = dict.fromkeys(syms, 1.0)

        def __init__(self) -> None:
            super().__init__()
            self.rate = TokenBucket(100.0, 1)  # 30 turns = 0.3 s > the 0.05 s fall-through

    class Other(Fast):
        name, label = "other", "Other"

        def __init__(self) -> None:
            super().__init__()
            self.rate = TokenBucket(1000.0, 1000)

    async def burst(router: ProviderRouter) -> list[str]:
        svc = MarketService(router, None)
        res = await asyncio.gather(*(svc.quote(s) for s in syms))
        return [r.meta.source for r in res]

    assert set(await burst(ProviderRouter([Fast()]))) == {"Fast"}
    sources = await burst(ProviderRouter([Fast(), Other()]))
    assert "Other" in sources and "Fast" in sources
