"""user.db backup + migration of stored symbols to canonical IDs; runtime seeds (SPEC §5)."""

from __future__ import annotations

import asyncio
import json
import sqlite3
from datetime import UTC, datetime, timedelta
from pathlib import Path

import httpx
import pytest

from ndx_server.db import Database
from ndx_server.migrate_symbols import MARKER, migrate_user_db
from ndx_server.secmaster import Symbology
from ndx_server.seeds import SEEDS, SeedStore


def legacy_db(path: Path) -> Database:
    """A v1-style user.db: provider symbols everywhere."""
    db = Database(path)
    with db.conn() as c:
        c.execute("DELETE FROM watchlist_items")
        c.execute("DELETE FROM watchlists")
        c.execute("INSERT INTO watchlists(id, name, position) VALUES (1, 'CORE', 0)")
        for i, s in enumerate(
            ["AAPL", "AAPL US EQUITY", "NOVO-B.CO", "ENI.MI", "XYZ-B.ST", "#Banks"]
        ):
            c.execute("INSERT INTO watchlist_items VALUES (1, ?, ?)", (s, i))
        c.execute("INSERT INTO alerts(symbol, kind, threshold) VALUES ('^GSPC', 'above', 7000)")
        c.execute("INSERT INTO alerts(symbol, kind, threshold) VALUES ('XX=F', 'below', 1)")
        c.execute("INSERT INTO trades(symbol, qty, price) VALUES ('BTCUSDT', 0.1, 60000)")
        c.execute("INSERT INTO notes(symbol, body) VALUES ('EURUSD', 'legacy note')")
        c.execute("INSERT INTO notes(symbol, body) VALUES ('EURUSD CURNCY', 'new note')")
        c.execute("INSERT INTO notes(symbol, body) VALUES ('MY IDEAS', 'free text key')")
        tree = {
            "type": "split",
            "id": "s1",
            "a": {"type": "leaf", "id": "p1", "panel": {"fn": "GP", "ticker": "SPY", "args": []}},
            "b": {"type": "leaf", "id": "p2", "panel": {"fn": "WEI", "args": []}},
        }
        c.execute("INSERT INTO layouts(name, tree) VALUES ('main', ?)", (json.dumps(tree),))
    return db


def dump(path: Path) -> list[tuple[object, ...]]:
    with sqlite3.connect(path) as c:
        return sorted(c.execute("SELECT symbol, position FROM watchlist_items").fetchall())


def test_backup_first_then_migrate_with_report(tmp_path: Path) -> None:
    db = legacy_db(tmp_path / "user.db")
    before = dump(tmp_path / "user.db")
    rep = migrate_user_db(db, tmp_path, Symbology.load())
    assert rep is not None and rep.error is None

    # (1) The backup holds the pre-migration data.
    assert Path(rep.backup).exists() and dump(Path(rep.backup)) == before

    # (2) Stored symbols are canonical; duplicates merged; unmappable left as stored.
    with db.conn() as c:
        items = [r[0] for r in c.execute("SELECT symbol FROM watchlist_items ORDER BY position")]
        alerts = [r[0] for r in c.execute("SELECT symbol FROM alerts ORDER BY id")]
        trades = [r[0] for r in c.execute("SELECT symbol FROM trades")]
        notes = {r[0]: r[1] for r in c.execute("SELECT symbol, body FROM notes")}
        tree = json.loads(c.execute("SELECT tree FROM layouts").fetchone()[0])
    # A group header (MON) is not a symbol: kept as is, never reported.
    assert items == ["AAPL US EQUITY", "NOVOB DC EQUITY", "ENI.MI", "XYZB SS EQUITY", "#Banks"]
    assert not any(u.symbol == "#Banks" for u in rep.unresolved)
    assert alerts == ["SPX INDEX", "XX=F"]
    assert trades == ["BTCUSD CURNCY"]
    assert set(notes) == {"EURUSD CURNCY", "MY IDEAS"}
    assert "new note" in notes["EURUSD CURNCY"] and "legacy note" in notes["EURUSD CURNCY"]
    assert tree["a"]["panel"]["ticker"] == "SPY US EQUITY"
    assert "ticker" not in tree["b"]["panel"]

    # (3) Share classes the rules cannot reverse are learned and persisted.
    assert db.symbol_map() == {"XYZB SS": "XYZ-B.ST"}

    # (4) The report lists every change and everything unresolved.
    unresolved = {(u.table, u.symbol) for u in rep.unresolved}
    assert unresolved == {
        ("watchlist_items", "ENI.MI"),
        ("alerts", "XX=F"),
        ("notes", "MY IDEAS"),
    }
    assert any("merged" in m for m in rep.merged)
    md = sorted((tmp_path / "migrations").glob("symbols-*.md"))
    assert len(md) == 1
    text = md[0].read_text()
    assert "Backup of user.db before any change" in text and "`ENI.MI`" in text
    assert json.loads(md[0].with_suffix(".json").read_text())["backup"] == rep.backup

    # (5) Runs once.
    marker = db.get_setting(MARKER)
    assert marker["changed"] == len(rep.changes) and marker["unresolved"] == 3
    assert migrate_user_db(db, tmp_path, Symbology.load()) is None


def test_failure_rolls_back_and_keeps_backup(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    db = legacy_db(tmp_path / "user.db")
    before = dump(tmp_path / "user.db")

    def boom(*_a: object, **_k: object) -> dict[str, str]:
        raise RuntimeError("disk full")

    sm = Symbology.load()
    monkeypatch.setattr(sm, "learn", boom)
    rep = migrate_user_db(db, tmp_path, sm)
    assert rep is not None and rep.error == "RuntimeError: disk full"
    assert dump(tmp_path / "user.db") == before  # rolled back
    assert Path(rep.backup).exists()
    assert db.get_setting(MARKER) is None  # will retry next start
    assert "FAILED, rolled back" in next((tmp_path / "migrations").glob("*.md")).read_text()


def test_fresh_database_needs_no_changes(tmp_path: Path) -> None:
    db = Database(tmp_path / "user.db")
    rep = migrate_user_db(db, tmp_path, Symbology.load())
    assert rep is not None and rep.changes == [] and rep.unresolved == []


# ---------- seeds ----------


def transport(status: int = 200) -> httpx.MockTransport:
    seen: list[httpx.Request] = []

    def handler(req: httpx.Request) -> httpx.Response:
        seen.append(req)
        return httpx.Response(status, content=b'{"ok": true}' if status == 200 else b"down")

    t = httpx.MockTransport(handler)
    t.seen = seen  # type: ignore[attr-defined]
    return t


async def test_seeds_download_into_data_dir_with_meta(tmp_path: Path) -> None:
    store = SeedStore(tmp_path, sec_user_agent="Test Owner test@example.com")
    t = transport()
    async with httpx.AsyncClient(transport=t) as client:
        await store.refresh_due(client)
    assert len(t.seen) == len(SEEDS)  # type: ignore[attr-defined]
    sec = next(r for r in t.seen if "sec.gov" in str(r.url))  # type: ignore[attr-defined]
    assert sec.headers["User-Agent"] == "Test Owner test@example.com"
    for spec in SEEDS:
        assert store.path(spec).is_relative_to(tmp_path / "seeds")
        meta = store.meta(spec)
        assert meta is not None and meta["bytes"] == 12 and len(meta["sha256"]) == 64
    status = {s.name: s for s in store.seed_status()}
    assert all(s.present and s.error is None for s in status.values())

    # Fresh files are not fetched again before their TTL.
    t2 = transport()
    async with httpx.AsyncClient(transport=t2) as client:
        await store.refresh_due(client)
    assert t2.seen == []  # type: ignore[attr-defined]


async def test_seed_refresh_keeps_running_while_the_app_is_open(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store = SeedStore(tmp_path, sec_user_agent="")
    rounds = 0

    async def refresh_due(client: httpx.AsyncClient | None = None) -> None:
        nonlocal rounds
        rounds += 1
        if rounds == 1:
            raise OSError("network down")  # one failed round does not stop the loop
        if rounds == 3:
            raise asyncio.CancelledError

    monkeypatch.setattr(store, "refresh_due", refresh_due)
    with pytest.raises(asyncio.CancelledError):
        await store._loop(every_s=0)
    assert rounds == 3


async def test_seed_failure_keeps_previous_copy_and_reports(tmp_path: Path) -> None:
    store = SeedStore(tmp_path, sec_user_agent="")
    async with httpx.AsyncClient(transport=transport()) as client:
        await store.refresh_due(client)
    spec = next(s for s in SEEDS if s.name == "nasdaq_listed")
    meta = json.loads((tmp_path / "seeds" / f"{spec.filename}.meta.json").read_text())
    old = datetime.now(UTC) - spec.ttl - timedelta(minutes=1)
    meta["fetched_at"] = old.isoformat()
    (tmp_path / "seeds" / f"{spec.filename}.meta.json").write_text(json.dumps(meta))
    async with httpx.AsyncClient(transport=transport(503)) as client:
        await store.refresh_due(client)
    status = {s.name: s for s in store.seed_status()}
    assert status["nasdaq_listed"].present and "503" in (status["nasdaq_listed"].error or "")
    assert store.path(spec).read_bytes() == b'{"ok": true}'  # previous copy kept
    # SEC needs a descriptive User-Agent: skipped, never sent anonymously.
    assert status["sec_company_tickers"].error == "skipped: EDGAR_USER_AGENT not set"


def test_seed_files_are_never_in_git() -> None:
    root = Path(__file__).resolve().parents[2]
    ignored = (root / ".gitignore").read_text()
    names = {s.filename for s in SEEDS}
    # tests/fixtures holds a tiny excerpt of SEC's public file (PROVIDERS P9: SEC may be committed).
    skip = {".venv", "fixtures", "node_modules"}
    tracked = {p.name for p in root.rglob("*") if p.name in names and not skip & set(p.parts)}
    assert tracked == set(), f"seed files found in the repo: {tracked}"
    assert "data/symbology" not in ignored  # our own CSVs ARE committed
