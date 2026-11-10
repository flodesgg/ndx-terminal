"""MON lists (SPEC §8): seed lists, group headers, the curated C25 file."""

from __future__ import annotations

import json
import sqlite3
from datetime import date
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from ndx_server.db import SEED_WATCHLISTS, SEEDED_KEY, Database, seed_symbols
from ndx_server.secmaster import Symbology, read_list
from ndx_server.symbols import classify


def test_every_seed_symbol_is_a_canonical_id_that_resolves() -> None:
    sm = Symbology.load()
    for name in SEED_WATCHLISTS:
        syms = seed_symbols(name)
        assert syms, name
        for s in syms:
            inst = classify(s)
            assert inst.id == s, f"{name}: {s} is not canonical"
            assert sm.canonical(sm.internal(s)) == s, f"{name}: {s} does not round-trip"


def test_c25_file_is_reviewed_and_has_25_lines() -> None:
    ids, reviewed = read_list("omxc25")
    assert len(ids) == len(set(ids)) == 25
    assert all(i.endswith(" DC EQUITY") for i in ids)
    assert reviewed is not None and (date.today() - reviewed).days < 200
    # Share classes and the Copenhagen line of a foreign issuer map to the right Yahoo symbol.
    assert classify("AMBUB DC EQUITY").symbol == "AMBU-B.CO"
    assert classify("NDADK DC EQUITY").symbol == "NDA-DK.CO"


def test_new_db_gets_the_seed_lists(tmp_path: Path) -> None:
    db = Database(tmp_path / "u.db")
    lists = db.list_watchlists()
    assert [w["name"] for w in lists] == list(SEED_WATCHLISTS)
    assert lists[0]["symbols"][:4] == [f"{t} US EQUITY" for t in ("SPY", "QQQ", "TLT", "GLD")]
    assert len(lists[1]["symbols"]) == 25


def test_older_db_keeps_its_lists_and_gets_missing_seeds_once(tmp_path: Path) -> None:
    path = tmp_path / "u.db"
    with sqlite3.connect(path) as c:  # a phase-1 user.db: its own lists, no seed marker
        c.executescript(
            "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);"
            "CREATE TABLE watchlists (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL "
            "UNIQUE, position INTEGER NOT NULL DEFAULT 0);"
            "INSERT INTO watchlists(name, position) VALUES ('CORE', 0), ('FX', 1);"
        )
    db = Database(path)
    names = [w["name"] for w in db.list_watchlists()]
    assert names == ["CORE", "FX", "US CORE", "DENMARK C25", "CRYPTO"]
    assert set(db.get_setting(SEEDED_KEY)) == set(SEED_WATCHLISTS)
    crypto = next(w for w in db.list_watchlists() if w["name"] == "CRYPTO")
    db.delete_watchlist(crypto["id"])
    db2 = Database(path)  # next launch: a deleted seed list stays deleted
    assert "CRYPTO" not in [w["name"] for w in db2.list_watchlists()]
    assert json.loads(json.dumps(db2.get_setting(SEEDED_KEY)))


def test_group_headers_are_rows_not_symbols(client: TestClient) -> None:
    new = client.post("/watchlists", json={"name": "grp"}).json()
    r = client.put(
        f"/watchlists/{new['id']}/items",
        json={"symbols": ["#  Banks ", "jpm", "#Tech", "aapl", "#Banks", "msft"]},
    )
    w = r.json()
    assert w["rows"] == ["#Banks", "JPM US EQUITY", "#Tech", "AAPL US EQUITY", "MSFT US EQUITY"]
    assert w["symbols"] == ["JPM US EQUITY", "AAPL US EQUITY", "MSFT US EQUITY"]
    bad = client.put(f"/watchlists/{new['id']}/items", json={"symbols": ["#"]})
    assert bad.status_code == 400
    too_long = client.put(f"/watchlists/{new['id']}/items", json={"symbols": ["#" + "x" * 33]})
    assert too_long.status_code == 400


@pytest.mark.parametrize("n", [301])
def test_symbol_cap_ignores_headers(client: TestClient, n: int) -> None:
    new = client.post("/watchlists", json={"name": "big"}).json()
    syms = ["#Top"] + [f"T{i:03d}" for i in range(n)]
    w = client.put(f"/watchlists/{new['id']}/items", json={"symbols": syms}).json()
    assert w["rows"][0] == "#Top" and len(w["symbols"]) == 300
