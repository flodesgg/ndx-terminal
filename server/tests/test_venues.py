"""Venue calendars for CDR and session states for WEI/MON (SPEC §8 `CDR`): hours, lunch breaks,
holidays, early closes and clock changes from exchange_calendars."""

from __future__ import annotations

from datetime import UTC, date, datetime

import pytest

from ndx_server.config import Settings
from ndx_server.symbols import classify
from ndx_server.venues import GLOBEX, US, state_for, venue_info, venue_of, venues

from .conftest import make_client


def at(*args: int) -> datetime:
    return datetime(*args, tzinfo=UTC)  # type: ignore[misc]


def by_mic(mic: str):  # type: ignore[no-untyped-def]
    return next(v for v in venues() if v.mic == mic)


def test_every_wei_index_and_future_has_a_venue() -> None:
    for sym in ["^GSPC", "^NDX", "^DJI", "^RUT", "^GSPTSE", "^BVSP"]:
        assert venue_of(classify(sym)) is not None, sym
    for sym in ["^STOXX50E", "^GDAXI", "^FCHI", "^FTSE", "^OMXC25", "^OMX", "^AEX", "^IBEX"]:
        assert venue_of(classify(sym)) is not None, sym
    for sym in ["^SSMI", "^N225", "^HSI", "000001.SS", "^KS11", "^AXJO", "^NSEI"]:
        assert venue_of(classify(sym)) is not None, sym
    assert venue_of(classify("^GSPC")) == US
    assert venue_of(classify("ES=F")) == GLOBEX and venue_of(classify("CL=F")) == GLOBEX
    assert venue_of(classify("EURUSD")).mic == "24/5"  # type: ignore[union-attr]
    assert venue_of(classify("BTCUSDT")).mic == "24/7"  # type: ignore[union-attr]
    assert venue_of(classify("NOVO-B.CO")).mic == "XCSE"  # type: ignore[union-attr]
    assert venue_of(classify("^VIX")) is None  # no calendar of its own: N.A., not CLOSED


@pytest.mark.parametrize(
    ("sym", "now", "state", "change"),
    [
        ("AAPL", at(2026, 11, 9, 15, 0), "OPEN", at(2026, 11, 9, 21, 0)),
        ("AAPL", at(2026, 11, 26, 15, 0), "HOLIDAY", at(2026, 11, 27, 14, 30)),  # Thanksgiving
        ("AAPL", at(2026, 11, 7, 15, 0), "CLOSED", at(2026, 11, 9, 14, 30)),  # Saturday
        ("^N225", at(2026, 11, 10, 3, 0), "BREAK", at(2026, 11, 10, 3, 30)),  # Tokyo lunch
        ("^N225", at(2026, 11, 10, 1, 0), "OPEN", at(2026, 11, 10, 2, 30)),  # lunch next
        ("^OMXC25", at(2026, 12, 24, 10, 0), "HOLIDAY", at(2026, 12, 28, 8, 0)),
    ],
)
def test_session_state(sym: str, now: datetime, state: str, change: datetime) -> None:
    v, got, nxt = state_for(classify(sym), now)
    assert v is not None and got == state and nxt == change


def test_hours_holidays_and_early_closes() -> None:
    info = venue_info(US, at(2026, 11, 20, 15, 0))
    assert info.state == "OPEN" and info.today is not None
    assert info.today.open == at(2026, 11, 20, 14, 30) and info.today.close == at(2026, 11, 20, 21)
    assert info.next_session is not None and info.next_session.day == date(2026, 11, 23)
    thanksgiving = next(d for d in info.special if d.day == date(2026, 11, 26))
    assert thanksgiving.kind == "holiday" and thanksgiving.name == "Thanksgiving"
    friday = next(d for d in info.special if d.day == date(2026, 11, 27))
    assert friday.kind == "early_close" and friday.close == at(2026, 11, 27, 18, 0)
    assert all(d.day <= date(2027, 1, 19) for d in info.special)  # 60 days ahead
    tokyo = venue_info(by_mic("XTKS"), at(2026, 11, 10, 3, 0))
    assert tokyo.today is not None and tokyo.today.break_start == at(2026, 11, 10, 2, 30)


def test_clock_changes() -> None:
    ny = venue_info(US, at(2026, 11, 9, 15, 0))
    assert ny.utc_offset_s == -5 * 3600
    assert ny.dst_change == at(2027, 3, 14, 7, 0) and ny.dst_offset_s == -4 * 3600
    sydney = venue_info(by_mic("XASX"), at(2026, 11, 9, 15, 0))
    assert sydney.dst_change == at(2027, 4, 3, 16, 0) and sydney.dst_offset_s == 10 * 3600
    tokyo = venue_info(by_mic("XTKS"), at(2026, 11, 9, 15, 0))
    assert tokyo.dst_change is None  # no DST


def test_a_calendar_without_next_years_holidays_is_na_not_closed() -> None:
    shanghai = by_mic("XSHG")
    now = venue_info(shanghai, at(2026, 11, 10, 2, 0))
    assert now.state == "OPEN" and now.known_until is not None
    assert now.known_until <= date(2026, 12, 31)
    later = venue_info(shanghai, at(2027, 1, 5, 2, 0))
    if later.known_until is None:  # holidays not recorded for 2027 in this library version
        assert later.state is None and later.today is None and later.special == []
    _, state, _ = state_for(classify("000001.SS"), at(2027, 1, 5, 2, 0))
    assert state == later.state


def test_calendar_endpoints(settings: Settings) -> None:
    with make_client(settings) as c:
        r = c.get("/calendar").json()
        assert r["meta"]["latency"] == "STATIC" and r["meta"]["source"].startswith(
            "exchange_calendars"
        )
        codes = {v["code"] for v in r["venues"]}
        assert {"US", "DC", "GY", "JT", "CME"} <= codes
        s = c.get("/calendar/state", params={"symbols": "^GSPC,ES=F,^VIX,$$"}).json()
        items = {i["symbol"]: i for i in s["items"]}
        assert items["^GSPC"]["venue"] == "US" and items["^GSPC"]["state"] is not None
        assert items["ES=F"]["venue_name"] == "CME Globex"
        assert items["^VIX"]["state"] is None and items["^VIX"]["error"] is None
        assert items["$$"]["error"]
