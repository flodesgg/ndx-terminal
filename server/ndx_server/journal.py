"""JRNL — trade journal (SPEC §8 "Smaller ones", simple version).

Entries are the user's own records (no market data): P&L in the trade's currency and return %
on entry, signed by side. Stats count closed trades only and use return % so trades in
different currencies are never summed.
"""

from __future__ import annotations

import csv
import io
import math
from datetime import UTC, date, datetime
from typing import Any

from .models import JournalEntry, JournalResponse, JournalTagStats


def tags(raw: str) -> list[str]:
    return [t.strip().lower() for t in raw.split(",") if t.strip()]


def entry_of(row: dict[str, Any]) -> JournalEntry:
    sign = 1.0 if row["side"] == "LONG" else -1.0
    pnl = ret = None
    if row.get("exit") is not None:
        pnl = (row["exit"] - row["entry"]) * row["qty"] * sign
        ret = (row["exit"] / row["entry"] - 1) * 100 * sign
    return JournalEntry(**row, pnl=pnl, ret_pct=ret)


def _rate(rets: list[float]) -> tuple[float | None, float | None]:
    if not rets:
        return None, None
    return sum(r > 0 for r in rets) / len(rets) * 100, sum(rets) / len(rets)


def summarize(rows: list[dict[str, Any]]) -> JournalResponse:
    entries = [entry_of(r) for r in rows]
    closed = [e for e in entries if e.ret_pct is not None]
    win, avg = _rate([e.ret_pct for e in closed if e.ret_pct is not None])
    stats: dict[tuple[str, str], list[float]] = {}
    for e in closed:
        assert e.ret_pct is not None
        for kind, raw in (("setup", e.setup), ("mistake", e.mistakes)):
            for t in tags(raw):
                stats.setdefault((kind, t), []).append(e.ret_pct)
    by_tag = []
    for (kind, t), rets in sorted(stats.items()):
        w, a = _rate(rets)
        by_tag.append(
            JournalTagStats(tag=t, kind=kind, trades=len(rets), win_rate=w, avg_ret_pct=a)
        )
    return JournalResponse(
        entries=entries,
        closed=len(closed),
        open=len(entries) - len(closed),
        win_rate=win,
        avg_ret_pct=avg,
        by_tag=by_tag,
    )


def today() -> str:
    return datetime.now(UTC).date().isoformat()


# ---------------------------------------------------------------------------- PORT CSV import

REQUIRED = ("date", "security", "side", "qty", "price")


def parse_trades_csv(text: str) -> tuple[list[dict[str, Any]], list[str]]:
    """`date,security,side,qty,price[,fees][,note]` -> rows (oldest first) or errors.
    Fees go into the price (buys pay more, sells receive less), so P&L includes them."""
    reader = csv.DictReader(io.StringIO(text.lstrip("﻿")))
    head = [h.strip().lower() for h in reader.fieldnames or []]
    missing = [c for c in REQUIRED if c not in head]
    if missing:
        return [], [f"missing column(s): {', '.join(missing)} (need {', '.join(REQUIRED)})"]
    rows: list[dict[str, Any]] = []
    errors: list[str] = []
    for n, raw in enumerate(reader, start=2):
        r = {(k or "").strip().lower(): (v or "").strip() for k, v in raw.items()}
        if not any(r.values()):
            continue
        try:
            day = date.fromisoformat(r["date"])
            side = r["side"].upper()
            if side not in ("BUY", "SELL"):
                raise ValueError(f"side must be BUY or SELL, not {r['side']!r}")
            qty, price = float(r["qty"]), float(r["price"])
            fees = float(r.get("fees") or 0)
            if not all(math.isfinite(x) for x in (qty, price, fees)):
                raise ValueError("qty, price and fees must be finite numbers")
            if qty <= 0 or price <= 0 or fees < 0:
                raise ValueError("qty and price must be positive, fees not negative")
            if not r["security"]:
                raise ValueError("security is empty")
        except (ValueError, KeyError) as exc:
            errors.append(f"line {n}: {exc}")
            continue
        eff = price + fees / qty if side == "BUY" else price - fees / qty
        note = r.get("note", "")
        if fees:
            note = f"{note} [CSV import; fees {fees:g} included in price]".strip()
        else:
            note = f"{note} [CSV import]".strip()
        rows.append(
            {
                "security": r["security"],
                "qty": qty if side == "BUY" else -qty,
                "price": eff,
                "ts": f"{day.isoformat()}T00:00:00Z",
                "note": note[:200],
            }
        )
    rows.sort(key=lambda x: x["ts"])
    return rows, errors
