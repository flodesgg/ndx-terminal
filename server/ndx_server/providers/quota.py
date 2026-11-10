"""Daily call budgets that survive a restart (docs/PROVIDERS.md §6: EODHD Free 18/day).

The in-memory token buckets (`ratelimit.TokenBucket`) reset when the backend restarts; a plan
with a small daily allowance must not. `DailyQuota` counts the calls spent in the current UTC
day (EODHD resets "at midnight GMT") in a small JSON file in the data folder, and can be raised
to what the provider itself reports (calls spent outside the app count too).
"""

from __future__ import annotations

import json
import logging
import os
import threading
from collections.abc import Callable
from datetime import UTC, date, datetime
from pathlib import Path

from .ratelimit import Quota

log = logging.getLogger("ndx.quota")

FILE_NAME = "quota.json"


def utc_now() -> datetime:
    return datetime.now(UTC)


class DailyQuota:
    """`limit` calls per UTC day for provider `name`, persisted in `<data_dir>/quota.json`.

    Without a data folder (tests, live-check without one) the count lives in memory only."""

    def __init__(
        self,
        name: str,
        limit: int,
        data_dir: Path | None,
        clock: Callable[[], datetime] = utc_now,
    ) -> None:
        self.name = name
        self.limit = limit
        self.clock = clock
        self.path = data_dir / FILE_NAME if data_dir is not None else None
        self._lock = threading.Lock()
        self._day, self._used = self._load()

    # ----- persistence -----

    def _read_all(self) -> dict[str, dict[str, object]]:
        if self.path is None or not self.path.exists():
            return {}
        try:
            raw = json.loads(self.path.read_text())
        except (OSError, ValueError) as exc:
            log.warning("quota file unreadable, starting from the provider's count: %s", exc)
            return {}
        return raw if isinstance(raw, dict) else {}

    def _load(self) -> tuple[date, int]:
        rec = self._read_all().get(self.name) or {}
        try:
            day = date.fromisoformat(str(rec.get("day")))
            used = int(rec.get("used", 0))  # type: ignore[call-overload]
        except (TypeError, ValueError):
            return self.today(), 0
        return day, max(0, used)

    def _save(self) -> None:
        if self.path is None:
            return
        data = self._read_all()
        data[self.name] = {"day": self._day.isoformat(), "used": self._used}
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.path.with_suffix(".tmp")
            tmp.write_text(json.dumps(data, indent=1, sort_keys=True))
            os.replace(tmp, self.path)
        except OSError as exc:  # a full disk must not stop the request; the count stays in RAM
            log.warning("quota file write failed: %s", exc)

    def today(self) -> date:
        return self.clock().astimezone(UTC).date()

    def _roll(self) -> None:
        today = self.today()
        if self._day != today:
            self._day, self._used = today, 0

    # ----- counting -----

    @property
    def used(self) -> int:
        with self._lock:
            self._roll()
            return self._used

    @property
    def left(self) -> int:
        return max(0, self.limit - self.used)

    def try_take(self) -> bool:
        """Count one call if the day's budget allows it; False (nothing counted) otherwise."""
        with self._lock:
            self._roll()
            if self._used >= self.limit:
                return False
            self._used += 1
            self._save()
            return True

    def give_back(self) -> None:
        """Undo one `try_take` whose request never reached the provider (no connection)."""
        with self._lock:
            self._roll()
            if self._used > 0:
                self._used -= 1
                self._save()

    def sync(self, used: int, day: date | None) -> None:
        """Raise today's count to what the provider reports for `day` (never lower it: calls
        we counted may not have reached its counter yet)."""
        with self._lock:
            self._roll()
            if day == self._day and used > self._used:
                self._used = used
                self._save()

    def quota(self) -> Quota:
        used = self.used
        return Quota(limit=self.limit, period="day", used=used, left=max(0, self.limit - used))


SYMBOLS_FILE = "symbols_month.json"


class MonthlySymbols:
    """A plan that counts *unique symbols per month* (Tiingo Starter: 500). Remembers which
    symbols `name` has used this UTC calendar month in `<data_dir>/symbols_month.json` (symbol
    names only, never values) and admits a new one only while the month has room."""

    def __init__(
        self,
        name: str,
        limit: int,
        data_dir: Path | None,
        clock: Callable[[], datetime] = utc_now,
    ) -> None:
        self.name = name
        self.limit = limit
        self.clock = clock
        self.path = data_dir / SYMBOLS_FILE if data_dir is not None else None
        self._lock = threading.Lock()
        self._month, self._seen = self._load()

    def month(self) -> str:
        return self.clock().astimezone(UTC).strftime("%Y-%m")

    def _read_all(self) -> dict[str, dict[str, object]]:
        if self.path is None or not self.path.exists():
            return {}
        try:
            raw = json.loads(self.path.read_text())
        except (OSError, ValueError) as exc:
            log.warning("symbol ledger unreadable, starting empty: %s", exc)
            return {}
        return raw if isinstance(raw, dict) else {}

    def _load(self) -> tuple[str, set[str]]:
        rec = self._read_all().get(self.name) or {}
        month, seen = rec.get("month"), rec.get("symbols")
        if not isinstance(month, str) or not isinstance(seen, list):
            return self.month(), set()
        return month, {str(s) for s in seen}

    def _save(self) -> None:
        if self.path is None:
            return
        data = self._read_all()
        data[self.name] = {"month": self._month, "symbols": sorted(self._seen)}
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.path.with_suffix(".tmp")
            tmp.write_text(json.dumps(data, indent=1, sort_keys=True))
            os.replace(tmp, self.path)
        except OSError as exc:
            log.warning("symbol ledger write failed: %s", exc)

    def _roll(self) -> None:
        month = self.month()
        if month != self._month:
            self._month, self._seen = month, set()

    @property
    def used(self) -> int:
        with self._lock:
            self._roll()
            return len(self._seen)

    def admit(self, symbols: set[str]) -> set[str]:
        """The subset of `symbols` that may be used: already used this month, or new while
        the month has room (those are recorded). Sorted order decides who gets the last room."""
        with self._lock:
            self._roll()
            out = symbols & self._seen
            added = False
            for s in sorted(symbols - self._seen):
                if len(self._seen) >= self.limit:
                    break
                self._seen.add(s)
                out.add(s)
                added = True
            if added:
                self._save()
            return out

    def quota(self) -> Quota:
        used = self.used
        return Quota(limit=self.limit, period="month", used=used, left=max(0, self.limit - used))


BYTES_FILE = "bytes_month.json"
SAVE_EVERY_S = 60.0


class MonthlyBytes:
    """Received payload bytes per UTC calendar month for `name` (Tiingo Starter: 1 GB/month),
    persisted in `<data_dir>/bytes_month.json` at most once a minute and on `flush()`."""

    def __init__(
        self,
        name: str,
        limit: int,
        data_dir: Path | None,
        clock: Callable[[], datetime] = utc_now,
    ) -> None:
        self.name = name
        self.limit = limit
        self.clock = clock
        self.path = data_dir / BYTES_FILE if data_dir is not None else None
        self._lock = threading.Lock()
        self._month, self._used = self._load()
        self._saved_at = self.clock()

    def month(self) -> str:
        return self.clock().astimezone(UTC).strftime("%Y-%m")

    def _load(self) -> tuple[str, int]:
        if self.path is None or not self.path.exists():
            return self.month(), 0
        try:
            rec = json.loads(self.path.read_text()).get(self.name) or {}
            return str(rec["month"]), max(0, int(rec["bytes"]))
        except (OSError, ValueError, KeyError, TypeError, AttributeError):
            return self.month(), 0

    def flush(self) -> None:
        if self.path is None:
            return
        with self._lock:
            try:
                data = json.loads(self.path.read_text()) if self.path.exists() else {}
                if not isinstance(data, dict):
                    data = {}
            except (OSError, ValueError):
                data = {}
            data[self.name] = {"month": self._month, "bytes": self._used}
            try:
                self.path.parent.mkdir(parents=True, exist_ok=True)
                tmp = self.path.with_suffix(".tmp")
                tmp.write_text(json.dumps(data, indent=1, sort_keys=True))
                os.replace(tmp, self.path)
            except OSError as exc:
                log.warning("byte ledger write failed: %s", exc)
            self._saved_at = self.clock()

    def _roll(self) -> None:
        month = self.month()
        if month != self._month:
            self._month, self._used = month, 0

    def add(self, n: int) -> None:
        with self._lock:
            self._roll()
            self._used += n
            due = (self.clock() - self._saved_at).total_seconds() >= SAVE_EVERY_S
        if due:
            self.flush()

    @property
    def used(self) -> int:
        with self._lock:
            self._roll()
            return self._used

    @property
    def left(self) -> int:
        return max(0, self.limit - self.used)
