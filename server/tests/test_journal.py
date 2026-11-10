"""PORT CSV import and JRNL (simple versions, scope cut of 2026-11-10)."""

from __future__ import annotations

import pytest

from ndx_server.config import Settings
from ndx_server.demo import DemoProvider
from ndx_server.journal import parse_trades_csv, summarize

from .conftest import make_client

CSV = """date,security,side,qty,price,fees,note
2026-10-02,AAPL US EQUITY,BUY,10,200,5,first
2026-10-20,AAPL US EQUITY,SELL,4,230,0,
"""


def test_csv_rows_fees_in_price_and_errors() -> None:
    rows, errors = parse_trades_csv(CSV)
    assert errors == []
    assert [r["qty"] for r in rows] == [10, -4]
    assert rows[0]["price"] == 200.5 and "fees 5 included" in rows[0]["note"]
    assert rows[0]["ts"] == "2026-10-02T00:00:00Z"
    _, errs = parse_trades_csv("date,security,side,qty\n")
    assert "missing column(s): price" in errs[0]
    _, errs = parse_trades_csv("date,security,side,qty,price\n2026-13-01,X,HOLD,1,1\n")
    assert errs and errs[0].startswith("line 2:")


def test_journal_stats_use_return_pct_by_tag() -> None:
    base = {"qty": 10.0, "opened": "2026-10-01", "closed": None, "thesis": "", "review": ""}
    rows = [
        {
            **base,
            "id": 1,
            "symbol": "A",
            "side": "LONG",
            "entry": 100.0,
            "exit": 110.0,
            "setup": "breakout",
            "mistakes": "",
        },
        {
            **base,
            "id": 2,
            "symbol": "B",
            "side": "SHORT",
            "entry": 50.0,
            "exit": 55.0,
            "setup": "Breakout, fade",
            "mistakes": "late entry",
        },
        {
            **base,
            "id": 3,
            "symbol": "C",
            "side": "LONG",
            "entry": 20.0,
            "exit": None,
            "setup": "breakout",
            "mistakes": "",
        },
    ]
    r = summarize(rows)
    assert (r.closed, r.open) == (2, 1)
    assert r.entries[0].pnl == 100.0 and r.entries[1].pnl == -50.0
    assert r.entries[1].ret_pct == pytest.approx(-10.0)
    assert r.win_rate == 50.0 and r.avg_ret_pct == pytest.approx(0.0)
    tag = {(t.kind, t.tag): t for t in r.by_tag}
    assert tag[("setup", "breakout")].trades == 2 and tag[("setup", "breakout")].win_rate == 50.0
    assert tag[("mistake", "late entry")].avg_ret_pct == pytest.approx(-10.0)


def test_api_import_is_all_or_nothing_and_journal_crud(settings: Settings) -> None:
    s = settings.model_copy(update={"demo": True})
    with make_client(s, [DemoProvider()]) as c:
        bad = c.post(
            "/portfolio/import", json={"csv": CSV + "2026-10-21,AAPL US EQUITY,SELL,99,1\n"}
        )
        assert bad.json()["imported"] == 0 and bad.json()["errors"]
        assert c.get("/portfolio/trades").json() == []
        ok = c.post("/portfolio/import", json={"csv": CSV}).json()
        assert ok == {"imported": 2, "errors": []}
        trades = c.get("/portfolio/trades").json()
        assert [t["qty"] for t in trades] == [10, -4]
        j = c.post(
            "/journal",
            json={
                "symbol": "AAPL US EQUITY",
                "side": "LONG",
                "qty": 5,
                "entry": 200,
                "setup": "pullback",
            },
        ).json()
        assert j["open"] == 1 and j["entries"][0]["opened"]
        eid = j["entries"][0]["id"]
        body = {"symbol": "AAPL", "side": "LONG", "qty": 5, "entry": 200, "exit": 210}
        j = c.put(f"/journal/{eid}", json=body).json()
        assert j["closed"] == 1 and j["entries"][0]["ret_pct"] == pytest.approx(5.0)
        assert j["entries"][0]["closed"]
        assert c.delete(f"/journal/{eid}").json()["entries"] == []
        assert c.delete(f"/journal/{eid}").status_code == 404


def test_csv_rejects_non_finite_numbers() -> None:
    rows, errors = parse_trades_csv(
        "date,security,side,qty,price,fees\n2026-03-02,MSFT,BUY,5,NaN,0\n2026-03-02,MSFT,BUY,5,1,inf\n"
    )
    assert rows == [] and len(errors) == 2 and all("finite" in e for e in errors)


def test_api_import_checks_the_replay_order(settings: Settings) -> None:
    """A sell dated today at 00:00Z replays before a buy entered later today: refused."""
    s = settings.model_copy(update={"demo": True})
    with make_client(s, [DemoProvider()]) as c:
        assert c.post(
            "/portfolio/trades", json={"symbol": "AAPL", "qty": 10, "price": 150}
        ).is_success
        day = c.get("/portfolio/trades").json()[0]["ts"][:10]
        res = c.post(
            "/portfolio/import",
            json={"csv": f"date,security,side,qty,price\n{day},AAPL,SELL,10,150\n"},
        ).json()
        assert res["imported"] == 0 and res["errors"]
        assert len(c.get("/portfolio/trades").json()) == 1
        assert c.get("/portfolio").status_code == 200
