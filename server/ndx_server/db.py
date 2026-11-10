"""SQLite storage for user data (layouts, history, watchlists, alerts, notes, portfolio)."""

from __future__ import annotations

import json
import sqlite3
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

SCHEMA = """
CREATE TABLE IF NOT EXISTS layouts (
    name TEXT PRIMARY KEY,
    tree TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE TABLE IF NOT EXISTS history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    command TEXT NOT NULL,
    ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS watchlists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    position INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS watchlist_items (
    list_id INTEGER NOT NULL REFERENCES watchlists(id) ON DELETE CASCADE,
    symbol TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (list_id, symbol)
);
CREATE TABLE IF NOT EXISTS alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT NOT NULL,
    kind TEXT NOT NULL,
    threshold REAL NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    triggered_at TEXT,
    triggered_price REAL,
    ref_price REAL
);
CREATE TABLE IF NOT EXISTS notes (
    symbol TEXT PRIMARY KEY,
    body TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE TABLE IF NOT EXISTS symbol_map (
    canonical TEXT PRIMARY KEY,
    provider_symbol TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT NOT NULL,
    qty REAL NOT NULL,
    price REAL NOT NULL,
    ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    note TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS journal (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT NOT NULL,
    side TEXT NOT NULL,
    qty REAL NOT NULL,
    entry REAL NOT NULL,
    exit REAL,
    opened TEXT NOT NULL,
    closed TEXT,
    setup TEXT NOT NULL DEFAULT '',
    mistakes TEXT NOT NULL DEFAULT '',
    thesis TEXT NOT NULL DEFAULT '',
    review TEXT NOT NULL DEFAULT ''
);
"""

JOURNAL_COLS = (
    "symbol",
    "side",
    "qty",
    "entry",
    "exit",
    "opened",
    "closed",
    "setup",
    "mistakes",
    "thesis",
    "review",
)

# Group headers live in a list's item order as "#<name>" entries (SPEC §8 MON); they are never
# symbols, so `symbols` leaves them out and `rows` keeps them.
HEADER = "#"

# Seed lists (SPEC §8 MON), canonical IDs (SPEC §5); test_watchlists checks each one resolves.
SEED_WATCHLISTS: dict[str, list[str]] = {
    "US CORE": [
        f"{t} US EQUITY"
        for t in (
            "SPY",
            "QQQ",
            "TLT",
            "GLD",
            "AAPL",
            "MSFT",
            "NVDA",
            "AMZN",
            "GOOGL",
            "META",
            "TSLA",
        )
    ],
    "DENMARK C25": [],  # data/symbology/omxc25.csv, read at seeding time
    "CRYPTO": [f"{c}USD CURNCY" for c in ("BTC", "ETH", "SOL", "XRP", "BNB", "ADA", "DOGE")],
    "FX": [f"{p} CURNCY" for p in ("EURUSD", "USDJPY", "GBPUSD", "EURDKK", "USDDKK", "EURUAH")],
}
# Names of the seed lists already created once, so a list the user deleted stays deleted.
SEEDED_KEY = "seeded-watchlists"


def seed_symbols(name: str) -> list[str]:
    if name == "DENMARK C25":
        from .secmaster import read_list

        return read_list("omxc25")[0]
    return SEED_WATCHLISTS[name]


class Database:
    def __init__(self, path: Path) -> None:
        self.path = path
        path.parent.mkdir(parents=True, exist_ok=True)
        self._local = threading.local()
        with self.conn() as c:
            c.executescript(SCHEMA)
            self._seed(c)

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.path, timeout=10)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute("PRAGMA journal_mode = WAL")
        return conn

    @contextmanager
    def conn(self) -> Iterator[sqlite3.Connection]:
        conn: sqlite3.Connection | None = getattr(self._local, "conn", None)
        if conn is None:
            conn = self._connect()
            self._local.conn = conn
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise

    def _seed(self, c: sqlite3.Connection) -> None:
        """Create each seed list once: a new user.db gets all of them; an older one gets the
        ones it never had, after its own lists (names it already uses count as seeded)."""
        r = c.execute("SELECT value FROM settings WHERE key = ?", (SEEDED_KEY,)).fetchone()
        done: set[str] = set(json.loads(r["value"])) if r else set()
        names = {row["name"] for row in c.execute("SELECT name FROM watchlists")}
        for name in SEED_WATCHLISTS:
            if name in done or name in names:
                done.add(name)
                continue
            pos = c.execute("SELECT COALESCE(MAX(position), -1) + 1 FROM watchlists").fetchone()[0]
            cur = c.execute("INSERT INTO watchlists(name, position) VALUES (?, ?)", (name, pos))
            c.executemany(
                "INSERT INTO watchlist_items(list_id, symbol, position) VALUES (?, ?, ?)",
                [(cur.lastrowid, s, i) for i, s in enumerate(seed_symbols(name))],
            )
            done.add(name)
        c.execute(
            "INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE "
            "SET value = excluded.value",
            (SEEDED_KEY, json.dumps(sorted(done))),
        )

    # ----- layouts -----

    def list_layouts(self) -> list[dict[str, Any]]:
        with self.conn() as c:
            rows = c.execute("SELECT name, tree, updated_at FROM layouts ORDER BY name").fetchall()
        return [
            {"name": r["name"], "tree": json.loads(r["tree"]), "updated_at": r["updated_at"]}
            for r in rows
        ]

    def get_layout(self, name: str) -> dict[str, Any] | None:
        with self.conn() as c:
            r = c.execute(
                "SELECT name, tree, updated_at FROM layouts WHERE name = ?", (name,)
            ).fetchone()
        if r is None:
            return None
        return {"name": r["name"], "tree": json.loads(r["tree"]), "updated_at": r["updated_at"]}

    def save_layout(self, name: str, tree: dict[str, Any]) -> None:
        with self.conn() as c:
            c.execute(
                "INSERT INTO layouts(name, tree) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET "
                "tree = excluded.tree, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')",
                (name, json.dumps(tree)),
            )

    def delete_layout(self, name: str) -> bool:
        with self.conn() as c:
            return c.execute("DELETE FROM layouts WHERE name = ?", (name,)).rowcount > 0

    # ----- watchlists -----

    def _watchlist(self, c: sqlite3.Connection, list_id: int) -> dict[str, Any] | None:
        row = c.execute("SELECT id, name FROM watchlists WHERE id = ?", (list_id,)).fetchone()
        if row is None:
            return None
        items = c.execute(
            "SELECT symbol FROM watchlist_items WHERE list_id = ? ORDER BY position", (list_id,)
        ).fetchall()
        rows = [r["symbol"] for r in items]
        return {
            "id": row["id"],
            "name": row["name"],
            "symbols": [x for x in rows if not x.startswith(HEADER)],
            "rows": rows,
        }

    def list_watchlists(self) -> list[dict[str, Any]]:
        with self.conn() as c:
            ids = [r["id"] for r in c.execute("SELECT id FROM watchlists ORDER BY position, id")]
            return [w for i in ids if (w := self._watchlist(c, i)) is not None]

    def find_watchlist(self, name: str) -> dict[str, Any] | None:
        with self.conn() as c:
            row = c.execute("SELECT id FROM watchlists WHERE name = ?", (name,)).fetchone()
            return None if row is None else self._watchlist(c, row["id"])

    def create_watchlist(self, name: str) -> dict[str, Any]:
        with self.conn() as c:
            pos = c.execute("SELECT COALESCE(MAX(position), -1) + 1 FROM watchlists").fetchone()[0]
            cur = c.execute("INSERT INTO watchlists(name, position) VALUES (?, ?)", (name, pos))
            w = self._watchlist(c, int(cur.lastrowid or 0))
        assert w is not None
        return w

    def delete_watchlist(self, list_id: int) -> bool:
        with self.conn() as c:
            return c.execute("DELETE FROM watchlists WHERE id = ?", (list_id,)).rowcount > 0

    def set_watchlist_items(self, list_id: int, rows: list[str]) -> dict[str, Any] | None:
        """Replace the list's rows: symbols and "#name" group headers, in display order."""
        with self.conn() as c:
            if c.execute("SELECT 1 FROM watchlists WHERE id = ?", (list_id,)).fetchone() is None:
                return None
            c.execute("DELETE FROM watchlist_items WHERE list_id = ?", (list_id,))
            c.executemany(
                "INSERT INTO watchlist_items(list_id, symbol, position) VALUES (?, ?, ?)",
                [(list_id, s, i) for i, s in enumerate(rows)],
            )
            return self._watchlist(c, list_id)

    # ----- alerts -----

    @staticmethod
    def _alert(r: sqlite3.Row) -> dict[str, Any]:
        d = dict(r)
        d["active"] = bool(d["active"])
        d.pop("ref_price", None)
        return d

    def list_alerts(self) -> list[dict[str, Any]]:
        with self.conn() as c:
            rows = c.execute("SELECT * FROM alerts ORDER BY active DESC, id DESC").fetchall()
        return [self._alert(r) for r in rows]

    def create_alert(self, symbol: str, kind: str, threshold: float, note: str) -> dict[str, Any]:
        with self.conn() as c:
            cur = c.execute(
                "INSERT INTO alerts(symbol, kind, threshold, note) VALUES (?, ?, ?, ?)",
                (symbol, kind, threshold, note),
            )
            row = c.execute("SELECT * FROM alerts WHERE id = ?", (cur.lastrowid,)).fetchone()
        return self._alert(row)

    def delete_alert(self, alert_id: int) -> bool:
        with self.conn() as c:
            return c.execute("DELETE FROM alerts WHERE id = ?", (alert_id,)).rowcount > 0

    def trigger_alert(self, alert_id: int, price: float | None) -> dict[str, Any] | None:
        """Mark an active alert as fired (one-shot). Returns None if it was not active."""
        with self.conn() as c:
            n = c.execute(
                "UPDATE alerts SET active = 0, triggered_price = ?, "
                "triggered_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ? AND active = 1",
                (price, alert_id),
            ).rowcount
            if not n:
                return None
            row = c.execute("SELECT * FROM alerts WHERE id = ?", (alert_id,)).fetchone()
        return self._alert(row)

    def rearm_alert(self, alert_id: int) -> dict[str, Any] | None:
        with self.conn() as c:
            c.execute(
                "UPDATE alerts SET active = 1, triggered_at = NULL, triggered_price = NULL "
                "WHERE id = ?",
                (alert_id,),
            )
            row = c.execute("SELECT * FROM alerts WHERE id = ?", (alert_id,)).fetchone()
        return None if row is None else self._alert(row)

    # ----- paper trades -----

    def list_trades(self) -> list[dict[str, Any]]:
        with self.conn() as c:
            rows = c.execute(
                "SELECT id, symbol, qty, price, ts, note FROM trades ORDER BY ts, id"
            ).fetchall()
        return [dict(r) for r in rows]

    def add_trade(
        self, symbol: str, qty: float, price: float, note: str, ts: str | None = None
    ) -> dict[str, Any]:
        with self.conn() as c:
            if ts is None:
                cur = c.execute(
                    "INSERT INTO trades(symbol, qty, price, note) VALUES (?, ?, ?, ?)",
                    (symbol, qty, price, note),
                )
            else:
                cur = c.execute(
                    "INSERT INTO trades(symbol, qty, price, note, ts) VALUES (?, ?, ?, ?, ?)",
                    (symbol, qty, price, note, ts),
                )
            row = c.execute(
                "SELECT id, symbol, qty, price, ts, note FROM trades WHERE id = ?", (cur.lastrowid,)
            ).fetchone()
        return dict(row)

    def add_trades(self, rows: list[tuple[str, float, float, str, str]]) -> None:
        """(symbol, qty, price, note, ts) rows in one transaction: all stored or none."""
        with self.conn() as c:
            c.executemany(
                "INSERT INTO trades(symbol, qty, price, note, ts) VALUES (?, ?, ?, ?, ?)", rows
            )

    def delete_trade(self, trade_id: int) -> bool:
        with self.conn() as c:
            return c.execute("DELETE FROM trades WHERE id = ?", (trade_id,)).rowcount > 0

    # ----- trade journal (JRNL) -----

    def list_journal(self) -> list[dict[str, Any]]:
        with self.conn() as c:
            rows = c.execute(
                f"SELECT id, {', '.join(JOURNAL_COLS)} FROM journal ORDER BY opened DESC, id DESC"
            ).fetchall()
        return [dict(r) for r in rows]

    def save_journal(self, values: dict[str, Any], entry_id: int | None = None) -> int | None:
        cols = [k for k in JOURNAL_COLS if k in values]
        with self.conn() as c:
            if entry_id is None:
                cur = c.execute(
                    f"INSERT INTO journal({', '.join(cols)}) VALUES ({', '.join('?' * len(cols))})",
                    [values[k] for k in cols],
                )
                return cur.lastrowid
            n = c.execute(
                f"UPDATE journal SET {', '.join(f'{k} = ?' for k in cols)} WHERE id = ?",
                [*(values[k] for k in cols), entry_id],
            ).rowcount
            return entry_id if n else None

    def delete_journal(self, entry_id: int) -> bool:
        with self.conn() as c:
            return c.execute("DELETE FROM journal WHERE id = ?", (entry_id,)).rowcount > 0

    # ----- notes -----

    def list_notes(self) -> list[dict[str, Any]]:
        with self.conn() as c:
            rows = c.execute(
                "SELECT symbol, body, updated_at FROM notes ORDER BY updated_at DESC"
            ).fetchall()
        return [dict(r) for r in rows]

    def get_note(self, symbol: str) -> dict[str, Any] | None:
        with self.conn() as c:
            r = c.execute(
                "SELECT symbol, body, updated_at FROM notes WHERE symbol = ?", (symbol,)
            ).fetchone()
        return None if r is None else dict(r)

    def save_note(self, symbol: str, body: str) -> dict[str, Any]:
        with self.conn() as c:
            if body.strip():
                c.execute(
                    "INSERT INTO notes(symbol, body) VALUES (?, ?) ON CONFLICT(symbol) DO UPDATE "
                    "SET body = excluded.body, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')",
                    (symbol, body),
                )
            else:
                c.execute("DELETE FROM notes WHERE symbol = ?", (symbol,))
        return self.get_note(symbol) or {"symbol": symbol, "body": "", "updated_at": None}

    # ----- command history -----

    def add_history(self, command: str) -> None:
        with self.conn() as c:
            last = c.execute("SELECT command FROM history ORDER BY id DESC LIMIT 1").fetchone()
            if last is not None and last["command"] == command:
                return
            c.execute("INSERT INTO history(command) VALUES (?)", (command,))
            c.execute(
                "DELETE FROM history WHERE id NOT IN "
                "(SELECT id FROM history ORDER BY id DESC LIMIT 500)"
            )

    def history(self, limit: int = 200) -> list[dict[str, Any]]:
        with self.conn() as c:
            rows = c.execute(
                "SELECT command, ts FROM history ORDER BY id DESC LIMIT ?", (limit,)
            ).fetchall()
        return [dict(r) for r in rows]

    # ----- settings -----

    # ----- security master: learned share-class mappings (SPEC §5) -----

    def symbol_map(self) -> dict[str, str]:
        with self.conn() as c:
            rows = c.execute("SELECT canonical, provider_symbol FROM symbol_map").fetchall()
        return {r["canonical"]: r["provider_symbol"] for r in rows}

    def delete_symbol_map(self, keys: list[str]) -> None:
        with self.conn() as c:
            c.executemany("DELETE FROM symbol_map WHERE canonical = ?", [(k,) for k in keys])

    def save_symbol_map(self, mapping: dict[str, str]) -> None:
        with self.conn() as c:
            c.executemany(
                "INSERT OR REPLACE INTO symbol_map(canonical, provider_symbol) VALUES (?, ?)",
                list(mapping.items()),
            )

    # ----- session (SPEC §4.9: the last session restores on launch) -----

    def get_session(self) -> dict[str, Any] | None:
        v = self.get_setting("session")
        return v if isinstance(v, dict) else None

    def set_session(self, state: dict[str, Any]) -> None:
        self.set_setting("session", state)

    def delete_session(self) -> None:
        with self.conn() as c:
            c.execute("DELETE FROM settings WHERE key = 'session'")

    def get_setting(self, key: str) -> Any:
        with self.conn() as c:
            r = c.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
        return None if r is None else json.loads(r["value"])

    def set_setting(self, key: str, value: Any) -> None:
        with self.conn() as c:
            c.execute(
                "INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE "
                "SET value = excluded.value",
                (key, json.dumps(value)),
            )
