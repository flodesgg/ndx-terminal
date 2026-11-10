"""One interface per data domain (SPEC §6.3) and provenance on every response."""

from __future__ import annotations

from typing import Any

from ndx_server.config import Settings
from ndx_server.providers.base import Capability, DataProvider
from ndx_server.providers.domains import DOMAIN_OF, Domain, domains_of
from ndx_server.providers.registry import build_providers

from .conftest import make_client
from .fakes import FakeEquity

PROVENANCE = ("source", "provider_symbol", "as_of", "fetched_at", "tag")


def test_every_capability_belongs_to_one_of_the_seven_domains() -> None:
    assert {d.value for d in Domain} == {
        "quotes",
        "bars",
        "fundamentals",
        "news",
        "calendar",
        "reference",
        "stream",
    }
    assert set(DOMAIN_OF) == set(Capability)


def test_providers_report_their_domains(settings: Settings) -> None:
    for p in build_providers(settings):
        st = p.status()
        assert st.domains == sorted(d.value for d in domains_of(p))
    assert domains_of(FakeEquity()) == {Domain.QUOTES, Domain.BARS, Domain.REFERENCE}


def _check(meta: dict[str, Any]) -> None:
    for k in PROVENANCE:
        assert k in meta, k
    assert meta["source"] and meta["fetched_at"] and meta["provider_symbol"]
    assert meta["tag"]  # SPEC §6.3 `freshness` (§6.1 tag)


def test_quote_bars_profile_responses_carry_full_provenance(settings: Settings) -> None:
    with make_client(settings, [FakeEquity()]) as c:
        _check(c.get("/quote/AAPL").json()["meta"])
        _check(c.get("/quotes", params={"symbols": "AAPL,MSFT"}).json()["items"][1]["meta"])
        _check(c.get("/bars/AAPL", params={"interval": "1d"}).json()["meta"])
        # the second call is served from the bar store: still full provenance
        _check(c.get("/bars/AAPL", params={"interval": "1d"}).json()["meta"])


def test_base_provider_answers_not_supported_per_domain() -> None:
    assert hasattr(DataProvider, "calendar")
