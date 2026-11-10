from __future__ import annotations

import json
import shutil
import textwrap
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from ndx_server.analytics import (
    TradeError,
    apply_trades,
    beta,
    correlation_matrix,
    max_drawdown,
    pearson,
)
from ndx_server.backtest import (
    last_json_line,
    list_scripts,
    parse_result,
    resolve_script,
    run_script,
)
from ndx_server.config import Settings
from ndx_server.portfolio import normalize_ccy

from .conftest import make_client
from .fakes import FakeEquity


def test_average_cost_and_realized_pnl() -> None:
    hs = apply_trades([("AAPL", 10, 100), ("AAPL", 10, 200), ("AAPL", -5, 300)])
    h = hs["AAPL"]
    assert h.qty == 15 and h.avg_cost == pytest.approx(150)
    assert h.realized == pytest.approx(750)  # 5 * (300 - 150)
    flat = apply_trades([("X", 2, 10), ("X", -2, 12)])["X"]
    assert flat.qty == 0 and flat.avg_cost == 0 and flat.realized == pytest.approx(4)
    with pytest.raises(TradeError):
        apply_trades([("AAPL", 1, 100), ("AAPL", -2, 100)])


def test_stats_helpers() -> None:
    a = [0.01, -0.02, 0.03, 0.0, 0.01]
    assert pearson(a, a) == pytest.approx(1)
    assert pearson(a, [-x for x in a]) == pytest.approx(-1)
    assert beta([2 * x for x in a], a) == pytest.approx(2)
    assert max_drawdown([100, 120, 90, 130, 65]) == pytest.approx(-0.5)
    m = correlation_matrix([a, [-x for x in a]])
    assert m[0][0] == 1.0 and m[0][1] == pytest.approx(-1)


def test_minor_currency_units() -> None:
    assert normalize_ccy("GBp") == ("GBP", 100.0)
    assert normalize_ccy("USD") == ("USD", 1.0)


def test_portfolio_flow(settings: Settings) -> None:
    with make_client(settings, [FakeEquity()]) as c:
        c.put("/settings/pdf.base_currency", json={"value": "USD"})
        t1 = c.post("/portfolio/trades", json={"symbol": "aapl", "qty": 10}).json()
        assert t1["price"] == 200.0 and "filled at Fake Equities D15 quote" in t1["note"]
        c.post("/portfolio/trades", json={"symbol": "MSFT", "qty": 5, "price": 380})
        r = c.post("/portfolio/trades", json={"symbol": "MSFT", "qty": -10, "price": 400})
        assert r.status_code == 400 and "only 5" in r.json()["detail"]
        p = c.get("/portfolio").json()
        pos = {x["symbol"]: x for x in p["positions"]}
        assert pos["AAPL US EQUITY"]["market_value"] == pytest.approx(2000)
        assert pos["MSFT US EQUITY"]["unrealized_pnl"] == pytest.approx(100)  # 5 * (400 - 380)
        assert p["total_value"] == pytest.approx(4000)
        assert sum(x["weight"] for x in p["positions"]) == pytest.approx(100)
        assert p["day_pnl"] == pytest.approx(2000 * 0.01 + 2000 * 0.01)  # prev close = 0.99 x last
        risk = p["risk"]
        assert risk["days"] > 30 and risk["beta_vs_spy"] is not None
        assert c.delete(f"/portfolio/trades/{t1['id']}").status_code == 204


def test_portfolio_default_base_dkk_without_rate_is_partial_not_assumed(
    settings: Settings,
) -> None:
    with make_client(settings, [FakeEquity()]) as c:
        c.post("/portfolio/trades", json={"symbol": "AAPL", "qty": 10, "price": 190})
        p = c.get("/portfolio").json()
        assert p["base_currency"] == "DKK"
        # No USDDKK source -> no assumed rate: position excluded, totals N.A., flagged partial.
        assert p["total_value"] is None and p["partial"] is True
        assert any("USD→DKK" in w for w in p["warnings"])


def test_correlation_endpoint(settings: Settings) -> None:
    with make_client(settings, [FakeEquity()]) as c:
        r = c.get("/correlation", params={"symbols": "AAPL,SPY,MSFT"}).json()
        assert r["symbols"] == ["AAPL", "SPY", "MSFT"]
        assert r["matrix"][0][1] == pytest.approx(1)
        assert r["days"] > 30 and r["sources"] == ["Fake Equities"]
        assert c.get("/correlation", params={"symbols": "AAPL"}).status_code == 400


def test_notes(client: TestClient) -> None:
    assert client.get("/notes/AAPL").json()["body"] == ""
    n = client.put("/notes/aapl", json={"body": "# Thesis\n- services growth"}).json()
    assert n["symbol"] == "AAPL US EQUITY" and n["updated_at"]
    assert client.get("/notes/AAPL US Equity").json()["body"].startswith("# Thesis")
    assert [x["symbol"] for x in client.get("/notes").json()] == ["AAPL US EQUITY"]
    client.put("/notes/AAPL", json={"body": "   "})  # empty body deletes
    assert client.get("/notes").json() == []


def test_bt_contract_parsing(tmp_path: Path) -> None:
    eq, bench, stats = parse_result(
        {"equity": [{"t": "2024-01-02", "v": 1}], "stats": {"CAGR": 0.1, "x": [1]}}
    )
    assert eq[0].v == 1 and bench == [] and stats == {"CAGR": 0.1, "x": "[1]"}
    with pytest.raises(ValueError):
        parse_result({"equity": []})
    assert last_json_line('log\n{"equity": [{"t": "a", "v": 1}]}\n') == {
        "equity": [{"t": "a", "v": 1}]
    }
    (tmp_path / "ok.py").write_text('"""Demo strategy."""\n')
    (tmp_path / "_private.py").write_text("")
    listed = list_scripts(str(tmp_path))
    assert listed.configured and [s.name for s in listed.scripts] == ["ok.py"]
    assert listed.scripts[0].description == "Demo strategy."
    assert not list_scripts("").configured
    for bad in ("../x.py", "_private.py", "nope.py", "ok.txt"):
        with pytest.raises(FileNotFoundError):
            resolve_script(str(tmp_path), bad)


@pytest.mark.skipif(shutil.which("uv") is None, reason="uv not installed")
async def test_bt_runs_a_script(tmp_path: Path) -> None:
    (tmp_path / "s.py").write_text(
        textwrap.dedent("""
        # /// script
        # dependencies = []
        # ///
        import json, os, sys
        out = {"equity": [{"t": "2024-01-0%d" % i, "v": 100 + i} for i in range(1, 4)],
               "stats": {"arg": sys.argv[1]}}
        json.dump(out, open(os.environ["NDX_BT_OUTPUT"], "w"))
    """)
    )
    (tmp_path / "boom.py").write_text("raise SystemExit(3)\n")
    r = await run_script(str(tmp_path), "s.py", ["SPY"], "http://x", "t")
    assert r.ok and [p.v for p in r.equity] == [101, 102, 103] and r.stats == {"arg": "SPY"}
    bad = await run_script(str(tmp_path), "boom.py", [], "http://x", "t")
    assert not bad.ok and bad.exit_code == 3
    assert json.loads(r.model_dump_json())["script"] == "s.py"
