"""Normalized field dictionary (SPEC §6.3) and the FLDS endpoint."""

from __future__ import annotations

from fastapi.testclient import TestClient

from ndx_server.config import Settings
from ndx_server.fields import FIELDS, FieldRegistry, normalize_profile, normalize_quote
from ndx_server.models import AssetClass, Profile, Quote

from .conftest import make_client
from .fakes import FakeEquity

SPEC_FIELDS = {
    "px_last",
    "px_open",
    "px_high",
    "px_low",
    "px_close_1d",
    "chg_net_1d",
    "chg_pct_1d",
    "volume",
    "vwap",
    "mkt_cap",
    "pe_ttm",
}


def test_dictionary_has_the_spec_fields_with_definitions() -> None:
    ids = {f.id for f in FIELDS}
    assert ids >= SPEC_FIELDS
    assert len(ids) == len(FIELDS)  # unique
    for f in FIELDS:
        assert f.definition and f.name and f.domain in {"quotes", "reference", "fundamentals"}


def test_normalize_quote_maps_values_and_keeps_missing_as_none() -> None:
    q = Quote(symbol="AAPL", price=200.0, prev_close=198.0, change=2.0, change_pct=1.01, vwap=None)
    n = normalize_quote(q)
    assert n["px_last"] == 200.0 and n["px_close_1d"] == 198.0 and n["chg_net_1d"] == 2.0
    assert n["vwap"] is None and n["px_open"] is None  # N.A., never 0
    p = Profile(symbol="AAPL", asset_class=AssetClass.EQUITY, pe_trailing=31.5, market_cap=3e12)
    m = normalize_profile(p)
    assert m["pe_ttm"] == 31.5 and m["mkt_cap"] == 3e12


def test_sources_are_only_the_providers_seen_delivering_a_value() -> None:
    reg = FieldRegistry()
    reg.observe_quote("Fake Equities", Quote(symbol="AAPL", price=1.0))
    reg.observe_quote("Other", Quote(symbol="AAPL", price=None, volume=5.0))
    rows = {r.id: r for r in reg.rows()}
    assert rows["px_last"].sources == ["Fake Equities"]
    assert rows["volume"].sources == ["Other"]
    assert rows["vwap"].sources == []  # nobody delivered it: UI shows N.A.


def test_fields_endpoint_lists_observed_sources(settings: Settings) -> None:
    with make_client(settings, [FakeEquity()]) as c:
        assert c.get("/quote/AAPL").status_code == 200
        r = c.get("/fields")
        assert r.status_code == 200
        rows = {x["id"]: x for x in r.json()["fields"]}
        assert rows["px_last"]["sources"] == ["Fake Equities"]
        assert rows["px_open"]["sources"] == []
        assert rows["pe_ttm"]["domain"] == "fundamentals"


def test_fields_endpoint_needs_the_token(settings: Settings) -> None:
    c: TestClient = make_client(settings, authed=False)
    assert c.get("/fields").status_code == 401
