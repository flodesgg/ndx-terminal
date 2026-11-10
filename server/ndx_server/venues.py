"""Trading venues: hours, holidays, early closes and DST for CDR, and the session state of any
instrument (WEI/MON dim closed markets). Everything comes from `exchange_calendars` (SPEC §8
`CDR`); a venue whose calendar is unavailable has state None (N.A.), never CLOSED."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

import exchange_calendars as xcals
import pandas as pd

from .models import AssetClass, Instrument, SessionTimes, SpecialDay, VenueInfo, VenueState

log = logging.getLogger("ndx.venues")

SOURCE = f"exchange_calendars {xcals.__version__}"
# How far ahead CDR lists holidays and early closes, and looks for a clock change.
SPECIAL_DAYS = 60
DST_LOOKAHEAD_DAYS = 200  # one full half-year of either hemisphere
# Calendars are built for a window around now and rebuilt when now leaves it.
_BEFORE, _AFTER = timedelta(days=10), timedelta(days=SPECIAL_DAYS + 30)


@dataclass(frozen=True)
class Venue:
    code: str
    name: str
    mic: str  # calendar name in exchange_calendars
    tz: str
    country: str


# The US composite has no single MIC: NYSE and Nasdaq share sessions and holidays.
US = Venue("US", "NYSE / Nasdaq", "XNYS", "America/New_York", "US")
# CME, CBOT, NYMEX and COMEX contracts trade on Globex: one calendar (exchange_calendars CMES).
GLOBEX = Venue("CME", "CME Globex", "CMES", "America/Chicago", "US")
FX = Venue("FX", "FX (24/5)", "24/5", "UTC", "")
CRYPTO = Venue("CRYPTO", "Crypto (24/7)", "24/7", "UTC", "")


def venues() -> list[Venue]:
    """CDR's list: the exchanges of the security master, the index calendars, and Globex."""
    from .secmaster import symbology

    sm = symbology()
    out: dict[str, Venue] = {"US": US}
    for ex in sm.exchanges.values():
        if ex.mic and ex.code not in out:
            out[ex.code] = Venue(ex.code, ex.name, ex.mic, ex.tz, ex.country)
    for row in sm.indices.values():
        mic = row.get("mic") or ""
        if mic and not any(v.mic == mic for v in out.values()):
            out[mic] = Venue(mic, row.get("venue") or mic, mic, row["tz"], row["country"])
    out[GLOBEX.code] = GLOBEX
    return list(out.values())


def venue_of(inst: Instrument) -> Venue | None:
    """The venue whose sessions an instrument trades in, or None if unknown."""
    if inst.asset_class is AssetClass.CRYPTO:
        return CRYPTO
    if inst.asset_class is AssetClass.FX:
        return FX
    from .secmaster import symbology

    sm = symbology()
    parts = (inst.id or "").split()
    if len(parts) >= 2 and parts[-1] in ("INDEX", "COMDTY"):
        code = " ".join(parts[:-1])
        if code in sm.futures:
            return GLOBEX
        row = sm.indices.get(code)
        mic = (row or {}).get("mic") or ""
        if not mic:
            return None
        if mic == US.mic:
            return US
        return next((v for v in venues() if v.mic == mic), None)
    if len(parts) >= 3 and parts[-1] == "EQUITY":
        code = parts[-2]
        if code == "US":
            return US
        ex = sm.exchanges.get(code)
        if ex is not None and ex.mic:
            return Venue(ex.code, ex.name, ex.mic, ex.tz, ex.country)
    return None


# ----- calendars -----

_cals: dict[str, tuple[Any, pd.Timestamp, pd.Timestamp]] = {}


def _calendar(mic: str, ts: pd.Timestamp) -> Any | None:
    """A calendar covering now and the next SPECIAL_DAYS. Some calendars record holidays only
    to the end of a year (XSHG, XBOM, XSES): then it covers up to that year end, and from the
    next year on the venue is N.A. until the library knows its holidays."""
    cached = _cals.get(mic)
    if cached is not None and cached[1] <= ts <= cached[2]:
        return cached[0]
    start, end = ts - _BEFORE, ts + _AFTER
    year_end = pd.Timestamp(year=ts.year, month=12, day=31, tz=UTC)
    for upto, usable in (
        (end, end - pd.Timedelta(days=SPECIAL_DAYS + 5)),
        (year_end, year_end - pd.Timedelta(hours=1)),
    ):
        if upto <= ts:
            continue
        try:
            cal = xcals.get_calendar(
                mic, start=start.date().isoformat(), end=upto.date().isoformat()
            )
        except Exception as exc:
            log.debug("calendar %s to %s unavailable: %s", mic, upto.date(), exc)
            continue
        _cals[mic] = (cal, start + pd.Timedelta(days=2), usable)
        return cal
    log.warning("calendar %s unavailable around %s", mic, ts.date())
    return None


def _ts(now: datetime) -> pd.Timestamp:
    return pd.Timestamp(now).tz_convert(UTC).floor("min")


def _local_day(ts: pd.Timestamp, tz: str) -> pd.Timestamp:
    return ts.tz_convert(tz).normalize().tz_localize(None)


def _session_times(cal: Any, session: pd.Timestamp) -> SessionTimes:
    def dt(x: Any) -> datetime | None:
        return None if pd.isna(x) else pd.Timestamp(x).to_pydatetime()

    close = pd.Timestamp(cal.session_close(session))
    return SessionTimes(
        day=session.date(),
        open=pd.Timestamp(cal.session_open(session)).to_pydatetime(),
        close=close.to_pydatetime(),
        break_start=dt(cal.session_break_start(session)),
        break_end=dt(cal.session_break_end(session)),
        early_close=_is_early(cal, session),
    )


def _is_early(cal: Any, session: pd.Timestamp) -> bool:
    early = getattr(cal, "early_closes", None)
    try:
        return early is not None and session in early
    except Exception:
        return False


def state_of(cal: Any, tz: str, ts: pd.Timestamp) -> tuple[VenueState, datetime | None]:
    """OPEN, BREAK (lunch), HOLIDAY (a weekday without a session) or CLOSED, and when it next
    changes (a lunch break's start and end count as changes)."""
    is_open = bool(cal.is_open_on_minute(ts))
    try:
        nxt = pd.Timestamp(cal.next_close(ts) if is_open else cal.next_open(ts))
        session = cal.minute_to_session(ts, direction="next")
        edge = cal.session_break_start(session) if is_open else cal.session_break_end(session)
        if not pd.isna(edge) and ts < edge < nxt:
            nxt = pd.Timestamp(edge)
        next_change: datetime | None = nxt.to_pydatetime()
    except Exception:
        next_change = None
    if is_open:
        return "OPEN", next_change
    day = _local_day(ts, tz)
    if _in_range(cal, day) and cal.is_session(day):
        bs, be = cal.session_break_start(day), cal.session_break_end(day)
        if not pd.isna(bs) and bs <= ts < be:
            return "BREAK", next_change
        return "CLOSED", next_change
    if day.day_of_week < 5 and _in_range(cal, day) and cal.name not in ("24/5", "24/7"):
        return "HOLIDAY", next_change
    return "CLOSED", next_change


def _in_range(cal: Any, day: pd.Timestamp) -> bool:
    return bool(cal.first_session <= day <= cal.last_session)


def _special_days(cal: Any, tz: str, ts: pd.Timestamp) -> list[SpecialDay]:
    first = _local_day(ts, tz)
    last = first + pd.Timedelta(days=SPECIAL_DAYS)
    names: dict[date, str] = {}
    regular = getattr(cal, "regular_holidays", None)
    if regular is not None:
        try:
            got = regular.holidays(first, last, return_name=True)
            names = {pd.Timestamp(d).date(): str(n) for d, n in got.items()}
        except Exception:  # some calendars build their holidays differently
            names = {}
    out: list[SpecialDay] = []
    for day in pd.date_range(first, min(last, cal.last_session), freq="D"):
        if day.day_of_week >= 5 and day.date() not in names:
            continue  # ordinary weekend
        if not cal.is_session(day):
            out.append(SpecialDay(day=day.date(), kind="holiday", name=names.get(day.date())))
        elif _is_early(cal, day):
            close = pd.Timestamp(cal.session_close(day)).to_pydatetime()
            out.append(SpecialDay(day=day.date(), kind="early_close", close=close))
    return out


def _dst_change(tz: str, now: datetime) -> tuple[datetime | None, int | None]:
    """The next change of the venue's UTC offset within DST_LOOKAHEAD_DAYS, and the new offset."""
    zone = ZoneInfo(tz)
    cur = now.astimezone(zone).utcoffset()
    hour = now.astimezone(UTC).replace(minute=0, second=0, microsecond=0)
    for day in range(1, DST_LOOKAHEAD_DAYS + 1):
        t = hour + timedelta(days=day)
        off = t.astimezone(zone).utcoffset()
        if off != cur:
            lo = t - timedelta(days=1)
            while (t - lo) > timedelta(hours=1):  # narrow to the hour
                mid = lo + (t - lo) / 2
                if mid.astimezone(zone).utcoffset() == cur:
                    lo = mid
                else:
                    t = mid
            t = t.replace(minute=0, second=0, microsecond=0)
            if t.astimezone(zone).utcoffset() == cur:
                t += timedelta(hours=1)
            return t, int(off.total_seconds()) if off is not None else None
    return None, None


def venue_info(v: Venue, now: datetime) -> VenueInfo:
    ts = _ts(now)
    offset = now.astimezone(ZoneInfo(v.tz)).utcoffset()
    dst_at, dst_offset = _dst_change(v.tz, now)
    base = VenueInfo(
        code=v.code,
        name=v.name,
        mic=v.mic,
        tz=v.tz,
        country=v.country,
        utc_offset_s=int(offset.total_seconds()) if offset is not None else 0,
        dst_change=dst_at,
        dst_offset_s=dst_offset,
    )
    cal = _calendar(v.mic, ts)
    if cal is None:
        return base
    state, nxt = state_of(cal, v.tz, ts)
    day = _local_day(ts, v.tz)
    today = _session_times(cal, day) if _in_range(cal, day) and cal.is_session(day) else None
    following = None
    try:
        after = cal.date_to_session(day, direction="next")
        if today is not None or after == day:
            after = cal.next_session(day)
        following = _session_times(cal, pd.Timestamp(after))
    except Exception:
        following = None
    return base.model_copy(
        update={
            "known_until": pd.Timestamp(cal.last_session).date(),
            "state": state,
            "next_change": nxt,
            "today": today,
            "next_session": following,
            "special": _special_days(cal, v.tz, ts),
        }
    )


def state_for(
    inst: Instrument, now: datetime
) -> tuple[Venue | None, VenueState | None, datetime | None]:
    v = venue_of(inst)
    if v is None:
        return None, None, None
    ts = _ts(now)
    cal = _calendar(v.mic, ts)
    if cal is None:
        return v, None, None
    state, nxt = state_of(cal, v.tz, ts)
    return v, state, nxt
