from __future__ import annotations

from typing import Any, ClassVar

from ndx_server.config import Settings
from ndx_server.models import AssetClass, Instrument, Latency
from ndx_server.providers.base import Capability, DataProvider, NotFound
from ndx_server.providers.ratelimit import TokenBucket
from ndx_server.providers.registry import PREFERENCES
from ndx_server.providers.yahoo_research import assemble_statements

from .conftest import make_client


def _statements(source_value: float) -> tuple[list[str], str, list[Any]]:
    periods = ["2024-12-31", "2025-12-31"]
    series = {
        "TotalRevenue": {p: source_value for p in periods},
        "NetIncome": {p: source_value / 10 for p in periods},
    }
    return periods, "USD", assemble_statements(series, periods, "annual")


class FakeSec(DataProvider):
    name = "sec"
    label = "SEC EDGAR"
    requires_key = True
    capabilities: ClassVar[dict[Capability, frozenset[AssetClass]]] = {
        Capability.FUNDAMENTALS: frozenset({AssetClass.EQUITY}),
    }

    def __init__(self, ua: str = "Jane jane@example.com") -> None:
        super().__init__(TokenBucket(100, 100), api_key=ua)

    def result_meta(self, asset: AssetClass, value: Any) -> tuple[Latency, int | None, str | None]:
        return Latency.STATIC, None, "SEC XBRL as filed"

    async def fundamentals(self, inst: Instrument, period: str) -> Any:
        if inst.symbol == "NEWCO":
            raise NotFound("insufficient SEC XBRL annual history (0 periods)")
        return _statements(100.0)


class FakeYahoo(DataProvider):
    name = "yahoo"
    label = "Yahoo Finance"
    capabilities: ClassVar[dict[Capability, frozenset[AssetClass]]] = {
        Capability.FUNDAMENTALS: frozenset({AssetClass.EQUITY}),
    }

    def __init__(self) -> None:
        super().__init__(TokenBucket(100, 100))

    async def fundamentals(self, inst: Instrument, period: str) -> Any:
        return _statements(99.0)


def test_sec_is_preferred_for_fundamentals() -> None:
    assert PREFERENCES[(Capability.FUNDAMENTALS, AssetClass.EQUITY)][0] == "sec"


def test_financials_from_sec_then_yahoo_fallback(settings: Settings) -> None:
    with make_client(settings, [FakeYahoo(), FakeSec()]) as c:
        r = c.get("/financials/AAPL").json()
        assert r["meta"]["source"] == "SEC EDGAR" and r["meta"]["note"] == "SEC XBRL as filed"
        income = next(s for s in r["statements"] if s["name"] == "income")
        assert income["lines"][0]["values"] == [100.0, 100.0]
        fb = c.get("/financials/NEWCO").json()
        assert fb["meta"]["source"] == "Yahoo Finance"
        assert fb["meta"]["attempts"] == ["sec", "yahoo"]  # shown as FALLBACK in the UI


def test_sec_without_user_agent_is_skipped(settings: Settings) -> None:
    with make_client(settings, [FakeYahoo(), FakeSec(ua="")]) as c:
        r = c.get("/financials/AAPL").json()
        assert r["meta"]["source"] == "Yahoo Finance" and r["meta"]["attempts"] == ["yahoo"]
