from __future__ import annotations

from datetime import date
from typing import Any

import httpx
import pytest
import respx
from fastapi.testclient import TestClient

from ndx_server.alerts import AlertEngine, describe, is_triggered
from ndx_server.config import Settings
from ndx_server.db import Database
from ndx_server.live import Client, LiveHub
from ndx_server.market import MarketService
from ndx_server.models import Alert, Quote
from ndx_server.providers.base import NotFound, NotSupported
from ndx_server.providers.fred import parse_csv as parse_fred_csv
from ndx_server.providers.router import ProviderRouter
from ndx_server.providers.sec import SecEdgarProvider, parse_submissions, parse_ticker_map
from ndx_server.providers.treasury import curve_on_or_before, merge_tables
from ndx_server.providers.treasury import parse_csv as parse_treasury
from ndx_server.providers.yahoo_research import (
    parse_econ,
    parse_filings,
    parse_fundamentals,
    parse_insiders,
    parse_screen,
    screen_body,
)
from ndx_server.symbols import classify

from .conftest import make_client
from .fakes import FakeEquity
from .helpers import fixture, fixture_file


def test_fundamentals_and_ratios() -> None:
    periods, ccy, sts = parse_fundamentals(fixture("yahoo_fundamentals_aapl.json"), "annual")
    assert ccy == "USD" and periods == sorted(periods) and len(periods) >= 3
    by = {s.name: {line.key: line for line in s.lines} for s in sts}
    rev = by["income"]["TotalRevenue"].values
    gp = by["income"]["GrossProfit"].values
    gm = by["ratios"]["gross_margin"].values
    assert gm[-1] == pytest.approx(gp[-1] / rev[-1] * 100)  # type: ignore[operator]
    growth = by["ratios"]["revenue_growth"].values
    assert growth[0] is None  # nothing to compare the first year with
    assert growth[-1] == pytest.approx((rev[-1] / rev[-2] - 1) * 100)  # type: ignore[operator]
    q_periods, _, q_sts = parse_fundamentals(fixture("yahoo_fundamentals_aapl.json"), "quarterly")
    assert len(q_periods) >= 4
    assert "balance" in {s.name for s in q_sts}


def test_filings_and_insiders() -> None:
    payload = fixture("yahoo_filings_insiders_aapl.json")
    filings = parse_filings(payload)
    assert filings and {f.form for f in filings} & {"10-K", "10-Q", "8-K"}
    assert all(f.url.startswith("http") for f in filings)
    ins = parse_insiders(payload)
    assert ins and ins[0].insider and ins[0].date


def test_econ_calendar_parse() -> None:
    events = parse_econ(fixture("yahoo_econ_calendar.json"))
    assert len(events) == 25
    assert all(e.time.tzinfo is not None for e in events)
    assert not any(e.event.endswith("*") for e in events)


def test_screen_body_and_parse() -> None:
    body = screen_body(
        region="dk",
        sector="Healthcare",
        mcap_min=1e9,
        mcap_max=None,
        pe_max=20,
        chg_min=None,
        chg_max=None,
        vol_min=None,
        sort="mcap",
        desc=True,
        size=10,
    )
    ops = body["query"]["operands"]
    assert {"operator": "eq", "operands": ["region", "dk"]} in ops
    assert {"operator": "lt", "operands": ["peratio.lasttwelvemonths", 20]} in ops
    assert {"operator": "gt", "operands": ["peratio.lasttwelvemonths", 0]} in ops
    with pytest.raises(NotSupported):
        screen_body(
            region="zz",
            sector=None,
            mcap_min=None,
            mcap_max=None,
            pe_max=None,
            chg_min=None,
            chg_max=None,
            vol_min=None,
            sort="mcap",
            desc=True,
            size=10,
        )
    total, rows = parse_screen(fixture("yahoo_screener_dk.json"))
    assert total >= len(rows) > 0 and rows[0].symbol.endswith(".CO")


def test_sec_parsers() -> None:
    ciks = parse_ticker_map(fixture("sec_company_tickers.json"))
    assert ciks["AAPL"] == 320193 and ciks["BRK-B"] == 1067983
    payload = fixture("sec_submissions_aapl.json")
    recent = payload["filings"]["recent"]
    rows = parse_submissions(payload)
    assert len(rows) == len(recent["accessionNumber"])  # every recent filing, newest first
    tenk = next(r for r in rows if r.form == "10-K")
    i = recent["form"].index("10-K")
    folder = recent["accessionNumber"][i].replace("-", "")
    assert tenk.url == (
        f"https://www.sec.gov/Archives/edgar/data/320193/{folder}/{recent['primaryDocument'][i]}"
    )
    assert tenk.title == "Annual report" and tenk.date == recent["filingDate"][i]
    form4 = next(r for r in rows if r.form == "4")
    assert form4.title == "Insider transaction (Form 4)"
    assert rows == sorted(rows, key=lambda r: r.date, reverse=True)


@respx.mock
async def test_sec_provider_requires_user_agent() -> None:
    assert not SecEdgarProvider("").enabled
    respx.get("https://www.sec.gov/files/company_tickers.json").mock(
        return_value=httpx.Response(200, json=fixture("sec_company_tickers.json"))
    )
    respx.get("https://data.sec.gov/submissions/CIK0000320193.json").mock(
        return_value=httpx.Response(200, json=fixture("sec_submissions_aapl.json"))
    )
    sp = SecEdgarProvider("Jane Doe jane@example.com")
    rows = await sp.filings(classify("AAPL"))
    assert len(rows) == len(fixture("sec_submissions_aapl.json")["filings"]["recent"]["form"])
    assert respx.calls[0].request.headers["user-agent"] == "Jane Doe jane@example.com"
    with pytest.raises(NotFound):
        await sp.filings(classify("ZZZZ"))
    with pytest.raises(NotSupported):
        await sp.filings(classify("NOVO-B.CO"))
    await sp.aclose()


def test_treasury_curves() -> None:
    tenors, data = parse_treasury(fixture_file("treasury_2026.csv").read_text())
    assert tenors[0] == "1Mo" and tenors[-1] == "30Yr"
    old = (["1Mo", "30Yr"], {date(2025, 1, 2): [4.4, 4.8]})
    t2, merged = merge_tables([old, (tenors, data)])
    assert t2 == tenors  # tenor order preserved, union of columns
    assert merged[date(2025, 1, 2)][1] is None  # 1.5Mo did not exist in the old table
    latest = max(merged)
    c = curve_on_or_before(merged, latest)
    assert c is not None and c.date == latest.isoformat()
    assert curve_on_or_before(merged, date(2000, 1, 1)) is None


def test_fred_csv() -> None:
    text = fixture_file("fred_unrate.csv").read_text()
    s = parse_fred_csv("UNRATE", text)
    rows = text.strip().splitlines()[1:]
    # FRED leaves unpublished periods empty (or ".") — e.g. a month skipped by a shutdown
    missing = [r for r in rows if r.split(",")[1] in ("", ".")]
    assert s.title == "Unemployment rate" and len(s.data) == len(rows) - len(missing)
    assert s.data[-1].date == text.strip().splitlines()[-1].split(",")[0]
    assert (
        parse_fred_csv("X", "observation_date,X\n2020-01-01,.\n2020-02-01,1.5\n").data[0].value
        == 1.5
    )


def _alert(kind: str, threshold: float) -> Alert:
    return Alert(
        id=1,
        symbol="AAPL",
        kind=kind,
        threshold=threshold,
        active=True,  # type: ignore[arg-type]
        created_at="2026-01-01T00:00:00Z",
    )


def test_alert_rules() -> None:
    q = Quote(symbol="AAPL", price=201.0, change_pct=-3.5)
    assert is_triggered(_alert("above", 200), q)
    assert not is_triggered(_alert("below", 200), q)
    assert is_triggered(_alert("pct_below", -3), q)
    assert not is_triggered(_alert("pct_above", 1), q)
    assert not is_triggered(_alert("above", 1), Quote(symbol="AAPL"))  # no data, never fires
    assert describe(_alert("pct_above", 5)) == "AAPL day change ≥ +5%"


class _WS:
    async def send_text(self, _: str) -> None:  # pragma: no cover
        return None


async def test_alert_engine_fires_once_and_broadcasts(tmp_path: Any) -> None:
    db = Database(tmp_path / "u.db")
    market = MarketService(ProviderRouter([FakeEquity()]))
    hub = LiveHub(market)
    client = Client(_WS())  # type: ignore[arg-type]
    hub.clients.add(client)
    db.create_alert("AAPL", "above", 150.0, "breakout")
    db.create_alert("MSFT", "above", 10_000.0, "")
    engine = AlertEngine(db, market, hub)
    fired = await engine.check_once()
    assert [a.symbol for a in fired] == ["AAPL"] and fired[0].triggered_price == 200.0
    assert client.queue.qsize() == 1
    assert await engine.check_once() == []  # one-shot
    states = {a["symbol"]: a["active"] for a in db.list_alerts()}
    assert states == {"AAPL": False, "MSFT": True}


def test_alerts_api(client: TestClient) -> None:
    a = client.post("/alerts", json={"symbol": "aapl", "kind": "above", "threshold": 250}).json()
    assert a["symbol"] == "AAPL US EQUITY" and a["active"] is True
    assert (
        client.post(
            "/alerts", json={"symbol": "AAPL", "kind": "below", "threshold": -1}
        ).status_code
        == 400
    )
    assert (
        client.post("/alerts", json={"symbol": "$$", "kind": "above", "threshold": 1}).status_code
        == 400
    )
    assert client.post(f"/alerts/{a['id']}/rearm").json()["active"] is True
    assert client.delete(f"/alerts/{a['id']}").status_code == 204
    assert client.get("/alerts").json() == []


def test_research_endpoints_need_providers(settings: Settings) -> None:
    with make_client(settings, [FakeEquity()]) as c:
        assert c.get("/financials/AAPL").status_code == 503
        assert c.get("/financials/EURUSD").status_code == 400
        assert c.get("/macro/bad id!").status_code == 400
        assert c.get("/screen", params={"region": "usa"}).status_code == 422
