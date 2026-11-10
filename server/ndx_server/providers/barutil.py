"""Bar helpers: exchange wall-clock encoding and resampling."""

from __future__ import annotations

from datetime import UTC, datetime
from zoneinfo import ZoneInfo

from ..models import Bar

DAILY_PLUS = {"1d", "1wk", "1mo"}


def wall_clock(ts_utc: int, tz: ZoneInfo, daily: bool) -> int:
    """Encode a UTC epoch as exchange-local wall-clock seconds (dates at 00:00 for daily+)."""
    local = datetime.fromtimestamp(ts_utc, tz)
    if daily:
        return int(datetime(local.year, local.month, local.day, tzinfo=UTC).timestamp())
    offset = local.utcoffset()
    return ts_utc + (int(offset.total_seconds()) if offset else 0)


def current_offset(tz_name: str) -> int:
    off = datetime.now(ZoneInfo(tz_name)).utcoffset()
    return int(off.total_seconds()) if off else 0


def resample_session(bars: list[Bar], seconds: int) -> list[Bar]:
    """Aggregate intraday bars into `seconds` buckets aligned to each day's first bar
    (so a 4h bar starts at the session open, not at an arbitrary clock boundary)."""
    out: list[Bar] = []
    day_start: int | None = None
    current: Bar | None = None
    bucket_start = 0
    for b in bars:
        day = b.t - b.t % 86400
        if day_start != day:
            day_start = day
            anchor = b.t
        idx = (b.t - anchor) // seconds
        start = anchor + idx * seconds
        if current is None or start != bucket_start:
            if current is not None:
                out.append(current)
            bucket_start = start
            current = Bar(t=start, o=b.o, h=b.h, l=b.l, c=b.c, v=b.v)
        else:
            current = Bar(
                t=current.t,
                o=current.o,
                h=max(current.h, b.h),
                l=min(current.l, b.l),
                c=b.c,
                # Any missing part makes the bucket's volume unknown (N.A.), never partial.
                v=None if current.v is None or b.v is None else current.v + b.v,
            )
    if current is not None:
        out.append(current)
    return out
