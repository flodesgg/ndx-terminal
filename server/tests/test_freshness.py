"""Freshness tags (SPEC §6.1), opt-in yfinance (§6.2), no fake defaults (§1.2)."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import ClassVar

import pytest
from fastapi.testclient import TestClient

from ndx_server.config import Settings
from ndx_server.models import Latency, Meta, freshness_tag
from ndx_server.providers.base import Capability
from ndx_server.providers.registry import PREFERENCES, build_providers
from ndx_server.providers.sec_financials import _total_debt
from ndx_server.providers.yahoo import YahooProvider

from .conftest import make_client
from .fakes import FakeEquity

NOW = datetime(2026, 11, 9, 9, 0, tzinfo=UTC)


@pytest.mark.parametrize(
    ("lat", "delay", "venue", "expected"),
    [
        (Latency.REALTIME, None, None, "RT"),
        (Latency.REALTIME, None, "TRD", "RT·TRD"),
        (Latency.REALTIME, None, "REF", "RT·REF"),
        (Latency.REALTIME, None, "IEX", "RT·IEX"),
        (Latency.DELAYED, 15, None, "D15"),
        (Latency.DELAYED, 20, None, "D20"),
        (Latency.DELAYED, 0, None, "D0"),
        # unstated delay is never assumed -> timestamped snapshot
        (Latency.DELAYED, None, None, "CACHE"),
        (Latency.EOD, None, None, "EOD"),
        (Latency.STATIC, None, None, "CACHE"),
    ],
)
def test_tag_vocabulary(lat: Latency, delay: int | None, venue: str | None, expected: str) -> None:
    assert freshness_tag(lat, delay, venue) == expected


def test_stale_and_demo_override() -> None:
    assert freshness_tag(Latency.REALTIME, None, stale=True) == "STALE"
    # an offline (stale) copy says STALE even in DEMO (§13 step 9); otherwise DEMO wins
    assert freshness_tag(Latency.EOD, None, stale=True, demo=True) == "STALE"
    assert freshness_tag(Latency.EOD, None, cached=True, demo=True) == "DEMO"


def test_meta_serializes_tag() -> None:
    m = Meta(source="x", latency=Latency.DELAYED, delay_minutes=15, fetched_at=NOW)
    assert m.model_dump(mode="json")["tag"] == "D15"
    m2 = m.model_copy(update={"latency": Latency.STATIC})
    assert m2.tag == "CACHE"  # computed, never out of sync after model_copy


class OptInFake(FakeEquity):
    name = "optfake"
    label = "Opt-in Fake"
    opt_in = True
    personal_use = True


class RtFake(FakeEquity):
    name = "rtfake"
    label = "RT Fake"
    capabilities: ClassVar = {Capability.QUOTE: FakeEquity.capabilities[Capability.QUOTE]}

    def latency(self, asset):  # type: ignore[no-untyped-def]
        return Latency.REALTIME, None

    def venue(self, asset, value):  # type: ignore[no-untyped-def]
        return "TRD"


def test_opt_in_provider_off_by_default_and_toggle(settings: Settings) -> None:
    with make_client(settings, [OptInFake()]) as c:
        assert c.get("/providers/opt-in").json()["yfinance"] is False
        r = c.get("/quote/AAPL")
        assert r.status_code == 503 or r.json()["code"] == "no_provider"
        status = next(p for p in c.get("/providers").json() if p["name"] == "optfake")
        assert status["state"] == "disabled" and status["opt_in"] is True


def test_personal_use_marker_in_meta(settings: Settings) -> None:
    fake = OptInFake()
    with make_client(settings, [fake]) as c:
        c.app.state.ndx.router.set_opt_in("optfake", True)  # type: ignore[attr-defined]
        meta = c.get("/quote/AAPL").json()["meta"]
        assert meta["personal_use"] is True
        assert meta["tag"] == "D15" and meta["stale_after_s"] > 0


def test_rt_venue_tag_and_provider_symbol(settings: Settings) -> None:
    with make_client(settings, [RtFake()]) as c:
        meta = c.get("/quote/AAPL").json()["meta"]
        assert meta["tag"] == "RT·TRD" and meta["provider_symbol"] == "AAPL"


def test_yfinance_toggle_persists(settings: Settings) -> None:
    with make_client(settings, [YahooProvider()]) as c:
        on = {"yfinance": True, "yfinance_scope": "all"}
        assert c.put("/providers/opt-in", json={"yfinance": True}).json() == on
        assert "yahoo" in c.app.state.ndx.router.opt_in_enabled  # type: ignore[attr-defined]
    with make_client(settings, [YahooProvider()]) as c:  # restart: setting survives
        assert c.get("/providers/opt-in").json() == {"yfinance": True, "yfinance_scope": "all"}
        c.put("/providers/opt-in", json={"yfinance": False})
        assert "yahoo" not in c.app.state.ndx.router.opt_in_enabled  # type: ignore[attr-defined]


def test_registry_has_no_alpha_vantage_or_erapi_and_yahoo_is_opt_in(settings: Settings) -> None:
    names = [p.name for p in build_providers(settings)]
    assert "alphavantage" not in names and "erapi" not in names and "fredcsv" not in names
    for chain in PREFERENCES.values():
        assert "alphavantage" not in chain and "erapi" not in chain
    yahoo = next(p for p in build_providers(settings) if p.name == "yahoo")
    assert yahoo.opt_in and yahoo.personal_use


def test_total_debt_unknown_current_part_is_none() -> None:
    vals = {"LongTermDebt": 100.0}
    assert _total_debt(lambda k: vals.get(k)) is None
    vals["_ShortTermDebt"] = 5.0
    assert _total_debt(lambda k: vals.get(k)) == 105.0


def test_market_state_unknown_when_calendar_missing(settings: Settings) -> None:
    with make_client(settings) as c:
        clock = c.app.state.ndx.markets  # type: ignore[attr-defined]
        clock._ensure(datetime.now(UTC))
        clock._cals.pop("CPH", None)
        clock._loaded_for = datetime.now(UTC)
        cph = next(m for m in c.get("/markets").json() if m["code"] == "CPH")
        assert cph["is_open"] is None


def test_demo_mode_uses_fixtures_only(settings: Settings) -> None:
    settings.demo = True
    from ndx_server.main import create_app

    from .conftest import TEST_TOKEN

    app = create_app(settings, start_background=False)
    names = [p.name for p in app.state.ndx.router.providers]
    assert names == ["demo"]
    from fastapi.testclient import TestClient

    with TestClient(app, base_url="http://127.0.0.1", headers={"x-ndx-token": TEST_TOKEN}) as c:
        assert c.get("/health").json()["demo"] is True
        q = c.get("/quote/AAPL").json()
        assert q["meta"]["tag"] == "DEMO" and q["meta"]["demo"] is True
        again = c.get("/quote/AAPL").json()
        assert again["data"]["price"] == q["data"]["price"]  # deterministic
        bars = c.get("/bars/NOVO-B.CO", params={"interval": "1d"}).json()
        assert bars["meta"]["tag"] == "DEMO" and len(bars["data"]) >= 30
        last_bar = c.get("/bars/AAPL", params={"interval": "1d"}).json()["data"][-1]
        assert last_bar["c"] == pytest.approx(q["data"]["price"])  # chart agrees with quote
        # No network feed is started in DEMO mode: the real providers are listed (1b step 2,
        # status bar health) but only as disabled and never called.
        rows = c.get("/providers").json()
        assert rows[0]["name"] == "demo"
        assert all(p["state"] == "disabled" and p["calls"] == 0 for p in rows[1:])


def test_normal_mode_is_not_demo(client: TestClient) -> None:
    assert client.get("/health").json()["demo"] is False


def test_cached_copy_is_tagged_cache_not_rt() -> None:
    # Review 1a #22: bar-store / router-cache copies of an RT source kept "RT".
    now = datetime.now(UTC)
    assert Meta(source="binance", latency=Latency.REALTIME, fetched_at=now, cached=True).tag == (
        "CACHE"
    )
    assert Meta(source="binance", latency=Latency.REALTIME, fetched_at=now).tag == "RT"
    assert freshness_tag(Latency.REALTIME, None, demo=True, cached=True) == "DEMO"


def test_yfinance_scope_reaches_the_provider(settings: Settings) -> None:
    yp = YahooProvider()
    with make_client(settings, [yp]) as c:
        body = {"yfinance": True, "yfinance_scope": "dk_indices"}
        assert c.put("/providers/opt-in", json=body).json() == body
        assert yp.scope is not None and yp.scope.key == "dk_indices"
        assert c.get("/quote/AAPL").json().get("code") == "no_provider"  # outside the scope
        c.put("/providers/opt-in", json={"yfinance": True, "yfinance_scope": "all"})
        assert yp.scope is None
