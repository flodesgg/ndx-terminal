"""GP event markers (SPEC §8 `E/D/S`): earnings releases from SEC EDGAR (8-K item 2.02),
dividends and splits from Massive (`/stocks/v1/dividends`, `/stocks/v1/splits`)."""

from __future__ import annotations

from typing import Any, ClassVar

import httpx
import pytest
import respx

from ndx_server.demo import DemoProvider
from ndx_server.market import MarketService
from ndx_server.models import AssetClass, ChartEvent, Instrument, Latency
from ndx_server.providers.base import (
    Capability,
    DataProvider,
    LocalRateLimited,
    NotSupported,
    TransientError,
)
from ndx_server.providers.cache import TTLCache
from ndx_server.providers.massive import BASE, MassiveProvider, parse_dividends, parse_splits
from ndx_server.providers.ratelimit import TokenBucket
from ndx_server.providers.router import ProviderRouter, RouterError
from ndx_server.providers.sec import parse_earnings_releases
from ndx_server.symbols import classify

from .helpers import fixture

KEY = "massive-test-key-0123456789abcdef"


def test_earnings_releases_are_8k_item_2_02_dated_in_new_york() -> None:
    rec = fixture("sec_submissions_aapl.json")
    events = parse_earnings_releases(rec)
    # The recorded 8-K "2.02,9.01" accepted 2026-11-02 21:30 UTC = 16:30 New York.
    assert [(e.date, e.kind) for e in events] == [("2026-11-02", "E")]
    assert events[0].title.endswith("after the close")
    assert events[0].url and events[0].url.startswith("https://www.sec.gov/Archives/edgar/data/")
    assert events[0].source == "SEC EDGAR"


def test_other_8k_items_and_forms_are_not_earnings() -> None:
    recent = {
        "form": ["8-K", "8-K", "8-K/A", "10-Q", "8-K"],
        "items": ["5.02", "2.02", "2.02", "", "1.01,2.02"],
        "acceptanceDateTime": [
            "2026-01-05T13:00:00.000Z",
            "2026-01-29T12:05:00.000Z",  # 07:05 ET
            "",  # missing: the filing date is used
            "2026-02-01T21:00:00.000Z",
            "2026-04-30T16:00:00.000Z",  # 12:00 ET
        ],
        "filingDate": ["2026-01-05", "2026-01-29", "2026-02-03", "2026-02-01", "2026-04-30"],
        "accessionNumber": ["a", "b", "c", "d", "e"],
        "primaryDocument": ["x.htm"] * 5,
    }
    events = parse_earnings_releases({"cik": 1, "filings": {"recent": recent}})
    assert [(e.date, e.title) for e in events] == [
        ("2026-01-29", "Earnings release, 8-K item 2.02, before the open"),
        ("2026-02-03", "Earnings release, 8-K item 2.02 (amended)"),
        ("2026-04-30", "Earnings release, 8-K item 2.02, during the session"),
    ]


def test_dividends_and_splits_from_massive_rows() -> None:
    divs = parse_dividends(
        [
            {"ex_dividend_date": "2026-08-11", "cash_amount": 0.26, "currency": "USD"},
            {"ex_dividend_date": "2025-12-01", "cash_amount": 1.0, "distribution_type": "special"},
            {"ex_dividend_date": "2026-02-09", "cash_amount": None},  # no amount: dropped
            {"cash_amount": 0.2},  # no date: dropped
        ]
    )
    assert [(d.date, d.value, d.title) for d in divs] == [
        ("2025-12-01", 1.0, "Dividend (special), ex-date"),
        ("2026-08-11", 0.26, "Dividend, ex-date"),
    ]
    splits = parse_splits(
        [
            {"execution_date": "2020-08-31", "split_from": 1, "split_to": 4},
            {"execution_date": "2024-06-10", "split_from": 10, "split_to": 1,
             "adjustment_type": "reverse_split"},
            {"execution_date": "2024-01-01", "split_from": 0, "split_to": 2},  # malformed
        ]
    )  # fmt: skip
    assert [(s.date, s.title, s.value) for s in splits] == [
        ("2020-08-31", "Split 4:1", 4.0),
        ("2024-06-10", "Reverse split 1:10", 0.1),
    ]


@respx.mock
async def test_massive_corporate_actions_requests() -> None:
    divs = respx.get(f"{BASE}/stocks/v1/dividends").mock(
        return_value=httpx.Response(
            200, json={"results": [{"ex_dividend_date": "2026-08-11", "cash_amount": 0.26}]}
        )
    )
    splits = respx.get(f"{BASE}/stocks/v1/splits").mock(
        return_value=httpx.Response(200, json={"results": []})
    )
    p = MassiveProvider(KEY)
    out = await p.corp_actions(classify("BRK-B"))
    assert [e.kind for e in out] == ["D"]
    req = divs.calls[0].request
    assert req.url.params["ticker"] == "BRK.B" and KEY not in str(req.url)
    assert req.headers["Authorization"] == f"Bearer {KEY}"
    assert splits.calls[0].request.url.params["ticker"] == "BRK.B"
    with pytest.raises(NotSupported):
        await p.corp_actions(classify("NOVOB DC EQUITY"))

    # No token left for the splits call: our own refusal, never a Massive failure (review 2
    # M4: it counted toward the breaker and blocked bars for 30 s).
    async def no_token(max_wait: float = 0.0) -> bool:
        return False

    p.rate.acquire = no_token  # type: ignore[method-assign]
    for _ in range(6):
        with pytest.raises(LocalRateLimited) as refused:
            await p.corp_actions(classify("BRK-B"))
        p.record_error(refused.value)
    assert p.breaker.state == "closed" and p.consecutive_errors == 0
    await p.aclose()


async def test_demo_events_carry_all_three_kinds_and_the_demo_tag() -> None:
    m = MarketService(ProviderRouter([DemoProvider()], cache=TTLCache(), retry_delays=()))
    r = await m.events("AAPL US EQUITY")
    assert {e.kind for e in r.data} == {"E", "D", "S"}
    assert r.meta.demo and r.meta.latency == Latency.STATIC
    assert [e.date for e in r.data] == sorted(e.date for e in r.data)
    assert not r.errors and not r.uncovered


class EarningsOnly(DataProvider):
    name: ClassVar[str] = "earn"
    label: ClassVar[str] = "Earnings source"
    capabilities: ClassVar[dict[Capability, frozenset[AssetClass]]] = {
        Capability.EARNINGS: frozenset({AssetClass.EQUITY})
    }

    def __init__(self, fail: bool = False) -> None:
        super().__init__(TokenBucket(100, 100))
        self.fail = fail

    def latency(self, asset: AssetClass) -> tuple[Latency, int | None]:
        return Latency.STATIC, None

    async def earnings_events(self, inst: Instrument) -> list[ChartEvent]:
        if self.fail:
            raise TransientError("down")
        return [ChartEvent(kind="E", date="2026-10-30", title="t", source="Earnings source")]


class ActionsDown(EarningsOnly):
    name: ClassVar[str] = "acts"
    label: ClassVar[str] = "Actions source"
    capabilities: ClassVar[dict[Capability, frozenset[AssetClass]]] = {
        Capability.ACTIONS: frozenset({AssetClass.EQUITY})
    }

    async def corp_actions(self, inst: Instrument) -> list[Any]:
        raise TransientError("down")


async def test_one_source_missing_or_failing_leaves_the_other() -> None:
    only = MarketService(ProviderRouter([EarningsOnly()], cache=TTLCache(), retry_delays=()))
    r = await only.events("AAPL")
    assert [e.kind for e in r.data] == ["E"] and r.uncovered == ["D", "S"]
    both = MarketService(
        ProviderRouter([EarningsOnly(), ActionsDown()], cache=TTLCache(), retry_delays=())
    )
    r = await both.events("AAPL")
    assert [e.kind for e in r.data] == ["E"] and r.errors and r.errors[0].startswith("D/S")
    none = MarketService(ProviderRouter([], cache=TTLCache(), retry_delays=()))
    with pytest.raises(RouterError) as exc:
        await none.events("AAPL")
    assert exc.value.code == "no_provider"
