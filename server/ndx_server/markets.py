"""Exchange open/closed state using `exchange_calendars` (sessions, holidays, lunch breaks)."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from typing import Any

import exchange_calendars as xcals
import pandas as pd

from .models import ExchangeStatus

log = logging.getLogger("ndx.markets")


@dataclass(frozen=True)
class ExchangeDef:
    code: str
    mic: str
    name: str
    tz: str


EXCHANGES: tuple[ExchangeDef, ...] = (
    ExchangeDef("NYSE", "XNYS", "New York", "America/New_York"),
    ExchangeDef("LSE", "XLON", "London", "Europe/London"),
    ExchangeDef("XETRA", "XETR", "Frankfurt", "Europe/Berlin"),
    ExchangeDef("CPH", "XCSE", "Copenhagen", "Europe/Copenhagen"),
    ExchangeDef("STO", "XSTO", "Stockholm", "Europe/Stockholm"),
    ExchangeDef("OSL", "XOSL", "Oslo", "Europe/Oslo"),
    ExchangeDef("HEL", "XHEL", "Helsinki", "Europe/Helsinki"),
    ExchangeDef("PAR", "XPAR", "Paris", "Europe/Paris"),
    ExchangeDef("AMS", "XAMS", "Amsterdam", "Europe/Amsterdam"),
    ExchangeDef("SIX", "XSWX", "Zurich", "Europe/Zurich"),
    ExchangeDef("TSE", "XTKS", "Tokyo", "Asia/Tokyo"),
    ExchangeDef("HKEX", "XHKG", "Hong Kong", "Asia/Hong_Kong"),
)


class MarketClock:
    def __init__(self) -> None:
        self._cals: dict[str, Any] = {}
        self._loaded_for: datetime | None = None

    def _ensure(self, now: datetime) -> None:
        if self._loaded_for is not None and abs((now - self._loaded_for).days) < 7:
            return
        start = (now - timedelta(days=10)).date().isoformat()
        end = (now + timedelta(days=40)).date().isoformat()
        cals: dict[str, Any] = {}
        for ex in EXCHANGES:
            try:
                cals[ex.code] = xcals.get_calendar(ex.mic, start=start, end=end)
            except Exception as exc:  # calendar data missing for range
                log.warning("calendar %s unavailable: %s", ex.mic, exc)
        self._cals = cals
        self._loaded_for = now

    def status(self, now: datetime | None = None) -> list[ExchangeStatus]:
        now = now or datetime.now(UTC)
        self._ensure(now)
        ts = pd.Timestamp(now).floor("min")
        out: list[ExchangeStatus] = []
        for ex in EXCHANGES:
            cal = self._cals.get(ex.code)
            if cal is None:
                # Calendar unavailable: state unknown (N.A.), not CLOSED.
                out.append(ExchangeStatus(code=ex.code, name=ex.name, tz=ex.tz, is_open=None))
                continue
            is_open = bool(cal.is_open_on_minute(ts))
            try:
                next_change = _next_change(cal, ts, is_open)
            except Exception:
                next_change = None
            local_day = pd.Timestamp(now).tz_convert(ex.tz).normalize().tz_localize(None)
            holiday = local_day.day_of_week < 5 and not bool(cal.is_session(local_day))
            out.append(
                ExchangeStatus(
                    code=ex.code,
                    name=ex.name,
                    tz=ex.tz,
                    is_open=is_open,
                    next_change=next_change,
                    holiday=holiday,
                )
            )
        return out


def _next_change(cal: Any, ts: pd.Timestamp, is_open: bool) -> datetime:
    """Next open/close, counting a lunch break (TSE, HKEX) as a close and its end as an open.

    `next_open`/`next_close` know only the session's open and close, while `is_open_on_minute`
    honours breaks (review 1b #1).
    """
    nxt = cal.next_close(ts) if is_open else cal.next_open(ts)
    session = cal.minute_to_session(ts, direction="next")
    edge = cal.session_break_start(session) if is_open else cal.session_break_end(session)
    if not pd.isna(edge) and ts < edge < nxt:
        nxt = edge
    return pd.Timestamp(nxt).to_pydatetime()


# ---------- session closes (daily-bar cache lifetime, SPEC §6.3) ----------

_close_cals: dict[str, tuple[Any, pd.Timestamp, pd.Timestamp]] = {}


def _close_cal(mic: str, ts: pd.Timestamp) -> Any | None:
    """An exchange calendar covering `ts` (cached per MIC; rebuilt when `ts` leaves its range)."""
    cached = _close_cals.get(mic)
    if cached is None or not (cached[1] <= ts <= cached[2]):
        start, end = ts - pd.Timedelta(days=10), ts + pd.Timedelta(days=40)
        try:
            cal = xcals.get_calendar(
                mic, start=start.date().isoformat(), end=end.date().isoformat()
            )
        except Exception as exc:
            log.debug("calendar %s unavailable: %s", mic, exc)
            return None
        cached = (cal, start + pd.Timedelta(days=1), end - pd.Timedelta(days=10))
        _close_cals[mic] = cached
    return cached[0]


def next_session_close(mic: str, after: datetime) -> datetime | None:
    """First regular session close strictly after `after` (holidays and half days included);
    None when the calendar is unknown or unavailable."""
    ts = pd.Timestamp(after).tz_convert(UTC).floor("min")
    cal = _close_cal(mic, ts)
    if cal is None:
        return None
    try:
        return pd.Timestamp(cal.next_close(ts)).to_pydatetime()
    except Exception as exc:
        log.debug("next close %s after %s failed: %s", mic, ts, exc)
        return None


def previous_session_close(mic: str, before: datetime) -> datetime | None:
    """Last regular session close at or before `before`; None without a calendar."""
    ts = pd.Timestamp(before).tz_convert(UTC).floor("min")
    cal = _close_cal(mic, ts)
    if cal is None:
        return None
    try:
        return pd.Timestamp(cal.previous_close(ts + pd.Timedelta(minutes=1))).to_pydatetime()
    except Exception as exc:
        log.debug("previous close %s before %s failed: %s", mic, ts, exc)
        return None


def session_close_on(mic: str, day: date) -> datetime | None:
    """The regular close of the session on `day` (None: no calendar, or not a session)."""
    ts = pd.Timestamp(day.isoformat(), tz=UTC)
    cal = _close_cal(mic, ts)
    if cal is None:
        return None
    session = pd.Timestamp(day.isoformat())
    try:
        if not cal.is_session(session):
            return None
        return pd.Timestamp(cal.session_close(session)).to_pydatetime()
    except Exception as exc:
        log.debug("session close %s on %s failed: %s", mic, day, exc)
        return None
