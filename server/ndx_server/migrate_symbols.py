"""One-time migration of stored symbols to canonical IDs (SPEC §5, §14 phase 1a).

Order: (1) back up ``user.db`` with SQLite's online backup API into ``backups/``; (2) rewrite
symbols in one transaction (watchlists, alerts, notes, trades, layout panel tickers); (3) write a
report (Markdown + JSON) into ``migrations/`` listing every change and everything left unresolved.
A symbol that cannot be mapped is left exactly as stored. Typed command history is not touched.
Runs once (marker setting); a failure rolls back and leaves the backup and an error report.
"""

from __future__ import annotations

import json
import logging
import sqlite3
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from .db import Database
from .secmaster import Symbology

log = logging.getLogger("ndx.migrate")

MARKER = "secmaster.migration_v1"


@dataclass
class Change:
    table: str
    where: str
    old: str
    new: str


@dataclass
class Unresolved:
    table: str
    where: str
    symbol: str
    reason: str


@dataclass
class Report:
    started_at: str
    backup: str
    changes: list[Change] = field(default_factory=list)
    unresolved: list[Unresolved] = field(default_factory=list)
    merged: list[str] = field(default_factory=list)
    learned: dict[str, str] = field(default_factory=dict)
    error: str | None = None
    finished_at: str | None = None

    def markdown(self) -> str:
        lines = [
            "# Symbol migration report (canonical IDs, SPEC §5)",
            "",
            f"- Started: {self.started_at}",
            f"- Finished: {self.finished_at or 'N.A.'}",
            f"- Backup of user.db before any change: `{self.backup}`",
            f"- Changed: {len(self.changes)} · Unresolved (left as stored): "
            f"{len(self.unresolved)} · Merged duplicates: {len(self.merged)}",
        ]
        if self.error:
            lines += ["", f"**FAILED, rolled back:** {self.error}"]
        lines += ["", "## Unresolved", ""]
        if self.unresolved:
            lines += ["| table | where | stored symbol | reason |", "|---|---|---|---|"]
            lines += [
                f"| {u.table} | {u.where} | `{u.symbol}` | {u.reason} |" for u in self.unresolved
            ]
        else:
            lines.append("None.")
        lines += ["", "## Changes", ""]
        if self.changes:
            lines += ["| table | where | old | new |", "|---|---|---|---|"]
            lines += [f"| {c.table} | {c.where} | `{c.old}` | `{c.new}` |" for c in self.changes]
        else:
            lines.append("None.")
        if self.merged:
            lines += ["", "## Merged", ""] + [f"- {m}" for m in self.merged]
        if self.learned:
            lines += ["", "## Learned share-class mappings", ""]
            lines += [f"- `{k}` ↔ `{v}`" for k, v in sorted(self.learned.items())]
        return "\n".join(lines) + "\n"


def _target(sm: Symbology, symbol: str) -> tuple[str | None, str]:
    cid = sm.canonical(symbol)
    if cid is None:
        return None, "no canonical mapping (exchange or future not in data/symbology)"
    return cid, ""


def _walk_panels(node: Any, path: str = "") -> list[tuple[str, dict[str, Any]]]:
    out: list[tuple[str, dict[str, Any]]] = []
    if isinstance(node, dict):
        panel = node.get("panel")
        if isinstance(panel, dict) and isinstance(panel.get("ticker"), str):
            out.append((f"{path}/{node.get('id', '?')}", panel))
        for k, v in node.items():
            if k != "panel":
                out += _walk_panels(v, f"{path}/{k}")
    elif isinstance(node, list):
        for i, v in enumerate(node):
            out += _walk_panels(v, f"{path}[{i}]")
    return out


def _migrate(c: sqlite3.Connection, sm: Symbology, rep: Report) -> None:
    def resolve(table: str, where: str, symbol: str) -> str | None:
        new, reason = _target(sm, symbol)
        if new is None:
            rep.unresolved.append(Unresolved(table, where, symbol, reason))
            return None
        learned = sm.learn(symbol)
        rep.learned |= learned
        return new if new != symbol else None

    # watchlist items: (list_id, symbol) is the primary key -> merge duplicates
    lists = {r["id"]: r["name"] for r in c.execute("SELECT id, name FROM watchlists")}
    rows = c.execute(
        "SELECT list_id, symbol, position FROM watchlist_items WHERE symbol NOT LIKE '#%' "
        "ORDER BY list_id, position"
    ).fetchall()
    for r in rows:
        where = f"watchlist {lists.get(r['list_id'], r['list_id'])}"
        new = resolve("watchlist_items", where, r["symbol"])
        if new is None:
            continue
        exists = c.execute(
            "SELECT 1 FROM watchlist_items WHERE list_id = ? AND symbol = ?", (r["list_id"], new)
        ).fetchone()
        if exists:
            c.execute(
                "DELETE FROM watchlist_items WHERE list_id = ? AND symbol = ?",
                (r["list_id"], r["symbol"]),
            )
            rep.merged.append(f"{where}: `{r['symbol']}` merged into existing `{new}`")
        else:
            c.execute(
                "UPDATE watchlist_items SET symbol = ? WHERE list_id = ? AND symbol = ?",
                (new, r["list_id"], r["symbol"]),
            )
        rep.changes.append(Change("watchlist_items", where, r["symbol"], new))

    for table in ("alerts", "trades"):
        for r in c.execute(f"SELECT id, symbol FROM {table}").fetchall():
            where = f"{table[:-1]} #{r['id']}"
            new = resolve(table, where, r["symbol"])
            if new:
                c.execute(f"UPDATE {table} SET symbol = ? WHERE id = ?", (new, r["id"]))
                rep.changes.append(Change(table, where, r["symbol"], new))

    # notes: symbol is the primary key -> append to an existing note instead of overwriting
    for r in c.execute("SELECT symbol, body FROM notes").fetchall():
        new = resolve("notes", f"note {r['symbol']}", r["symbol"])
        if new is None:
            continue
        other = c.execute("SELECT body FROM notes WHERE symbol = ?", (new,)).fetchone()
        if other:
            body = f"{other['body']}\n\n---\n(merged from {r['symbol']})\n\n{r['body']}"
            c.execute("UPDATE notes SET body = ? WHERE symbol = ?", (body, new))
            c.execute("DELETE FROM notes WHERE symbol = ?", (r["symbol"],))
            rep.merged.append(f"note `{r['symbol']}` appended to existing note `{new}`")
        else:
            c.execute("UPDATE notes SET symbol = ? WHERE symbol = ?", (new, r["symbol"]))
        rep.changes.append(Change("notes", f"note {r['symbol']}", r["symbol"], new))

    # layouts: panel tickers inside the stored tree JSON
    for r in c.execute("SELECT name, tree FROM layouts").fetchall():
        try:
            tree = json.loads(r["tree"])
        except ValueError:
            rep.unresolved.append(Unresolved("layouts", r["name"], "", "layout JSON unreadable"))
            continue
        dirty = False
        for path, panel in _walk_panels(tree):
            sym = panel["ticker"]
            if not sym:
                continue
            new = resolve("layouts", f"layout {r['name']}{path}", sym)
            if new:
                panel["ticker"] = new
                dirty = True
                rep.changes.append(Change("layouts", f"layout {r['name']}{path}", sym, new))
        if dirty:
            c.execute("UPDATE layouts SET tree = ? WHERE name = ?", (json.dumps(tree), r["name"]))

    if rep.learned:
        c.executemany(
            "INSERT OR REPLACE INTO symbol_map(canonical, provider_symbol) VALUES (?, ?)",
            list(rep.learned.items()),
        )


def backup(db: Database, dest_dir: Path, stamp: str) -> Path:
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / f"user-{stamp}.db"
    with db.conn() as src, sqlite3.connect(dest) as out:
        src.backup(out)
    return dest


def migrate_user_db(
    db: Database, data_dir: Path, sm: Symbology, force: bool = False
) -> Report | None:
    """Run the one-time migration. Returns the report, or None if it already ran."""
    if db.get_setting(MARKER) and not force:
        return None
    now = datetime.now(UTC)
    stamp = now.strftime("%Y%m%dT%H%M%SZ")
    bpath = backup(db, data_dir / "backups", stamp)  # before any change
    rep = Report(started_at=now.isoformat(timespec="seconds"), backup=str(bpath))
    try:
        with db.conn() as c:
            _migrate(c, sm, rep)
    except Exception as exc:  # rolled back by Database.conn
        rep.error = f"{type(exc).__name__}: {exc}"
        log.exception("symbol migration failed; user.db unchanged, backup at %s", bpath)
    rep.finished_at = datetime.now(UTC).isoformat(timespec="seconds")
    out = data_dir / "migrations"
    out.mkdir(parents=True, exist_ok=True)
    md = out / f"symbols-{stamp}.md"
    md.write_text(rep.markdown(), encoding="utf-8")
    (out / f"symbols-{stamp}.json").write_text(json.dumps(asdict(rep), indent=1), encoding="utf-8")
    if rep.error is None:
        db.set_setting(
            MARKER,
            {
                "at": rep.finished_at,
                "report": str(md),
                "backup": str(bpath),
                "changed": len(rep.changes),
                "unresolved": len(rep.unresolved),
            },
        )
    log.info(
        "symbol migration: %d changed, %d unresolved; report %s",
        len(rep.changes),
        len(rep.unresolved),
        md,
    )
    return rep
