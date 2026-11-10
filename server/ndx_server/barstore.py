"""Persistent store of historical bars in DuckDB (daily/weekly/monthly series).

Updates are incremental only (SPEC §6.3): a refetch upserts the bars it brought (the tail) and
never rewrites the rest; a series from a different source replaces the stored one, so a series
never mixes provenance. The caller decides freshness from `fetched_at` (daily bars are fresh
until the next session close) and may serve an old copy as STALE when offline.
Rows keep the original source and fetch time so the UI can show where data came from."""

from __future__ import annotations

import logging
import threading
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

import duckdb

from .models import Bar, Latency
from .providers.base import BarSeries

PERSISTED_INTERVALS = {"1d", "1wk", "1mo"}
log = logging.getLogger("ndx.barstore")


@dataclass
class StoredSeries:
    series: BarSeries
    source: str
    latency: Latency
    fetched_at: datetime


class BarStore:
    def __init__(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._con: duckdb.DuckDBPyConnection | None = None
        try:
            self._con = duckdb.connect(str(path))
        except duckdb.IOException as exc:
            # Another process (e.g. a dev server next to the packaged app) holds the file lock.
            # Run without the persistent cache rather than failing to start.
            log.warning("bar cache disabled, %s is locked: %s", path, exc)
            return
        self._con.execute(
            """
            CREATE TABLE IF NOT EXISTS series (
                symbol VARCHAR, interval VARCHAR, tz VARCHAR, utc_offset_s INTEGER,
                source VARCHAR, latency VARCHAR, fetched_at TIMESTAMPTZ, as_of TIMESTAMPTZ,
                PRIMARY KEY (symbol, interval)
            );
            CREATE TABLE IF NOT EXISTS bar_rows (
                symbol VARCHAR, interval VARCHAR, t BIGINT,
                o DOUBLE, h DOUBLE, l DOUBLE, c DOUBLE, v DOUBLE,
                PRIMARY KEY (symbol, interval, t)
            );
            -- v1 table had no key (whole-series rewrites); its rows are a cache: drop them
            DROP TABLE IF EXISTS bars;
            DELETE FROM series WHERE (symbol, interval) NOT IN
                (SELECT DISTINCT symbol, interval FROM bar_rows);
            """
        )

    @property
    def enabled(self) -> bool:
        return self._con is not None

    def get(self, symbol: str, interval: str) -> StoredSeries | None:
        if interval not in PERSISTED_INTERVALS or self._con is None:
            return None
        with self._lock:
            row = self._con.execute(
                "SELECT tz, utc_offset_s, source, latency, fetched_at, as_of FROM series "
                "WHERE symbol = ? AND interval = ?",
                [symbol, interval],
            ).fetchone()
            if row is None:
                return None
            fetched_at: datetime = row[4].astimezone(UTC)
            rows = self._con.execute(
                "SELECT t, o, h, l, c, v FROM bar_rows WHERE symbol = ? AND interval = ? "
                "ORDER BY t",
                [symbol, interval],
            ).fetchall()
        if not rows:
            return None
        bars = [Bar(t=r[0], o=r[1], h=r[2], l=r[3], c=r[4], v=r[5]) for r in rows]
        as_of = row[5].astimezone(UTC) if row[5] is not None else None
        return StoredSeries(
            series=BarSeries(bars=bars, tz=row[0], utc_offset_s=row[1], as_of=as_of),
            source=row[2],
            latency=Latency(row[3]),
            fetched_at=fetched_at,
        )

    def last_t(self, symbol: str, interval: str) -> int | None:
        if self._con is None:
            return None
        with self._lock:
            row = self._con.execute(
                "SELECT max(t) FROM bar_rows WHERE symbol = ? AND interval = ?", [symbol, interval]
            ).fetchone()
        return int(row[0]) if row and row[0] is not None else None

    def put(
        self,
        symbol: str,
        interval: str,
        series: BarSeries,
        source: str,
        latency: Latency,
        fetched_at: datetime,
    ) -> None:
        """Upsert the bars of `series`; bars outside it stay as stored (same source)."""
        if interval not in PERSISTED_INTERVALS or not series.bars or self._con is None:
            return
        with self._lock:
            self._con.execute("BEGIN")
            try:
                prev = self._con.execute(
                    "SELECT source FROM series WHERE symbol = ? AND interval = ?",
                    [symbol, interval],
                ).fetchone()
                if prev is not None and prev[0] != source:
                    self._con.execute(
                        "DELETE FROM bar_rows WHERE symbol = ? AND interval = ?",
                        [symbol, interval],
                    )
                self._con.executemany(
                    "INSERT OR REPLACE INTO bar_rows VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                    [(symbol, interval, b.t, b.o, b.h, b.l, b.c, b.v) for b in series.bars],
                )
                self._con.execute(
                    "INSERT OR REPLACE INTO series VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                    [
                        symbol,
                        interval,
                        series.tz,
                        series.utc_offset_s,
                        source,
                        latency.value,
                        fetched_at,
                        series.as_of,
                    ],
                )
                self._con.execute("COMMIT")
            except Exception:
                self._con.execute("ROLLBACK")
                raise

    def prune_source(self, source: str, keep_days: int, now_t: int) -> int:
        """Delete bars of `source` older than `keep_days` before `now_t` (a plan's history
        window, e.g. Massive Basic: 2 years). Returns the number of rows deleted."""
        if self._con is None:
            return 0
        cutoff = now_t - keep_days * 86400
        with self._lock:
            row = self._con.execute(
                "DELETE FROM bar_rows WHERE t < ? AND (symbol, interval) IN "
                "(SELECT symbol, interval FROM series WHERE source = ?) RETURNING 1",
                [cutoff, source],
            ).fetchall()
        return len(row)

    def close(self) -> None:
        with self._lock:
            if self._con is not None:
                self._con.close()
