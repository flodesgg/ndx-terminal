"""ECO — official release calendars, the mapping file and actual/prior (SPEC §8)."""

from __future__ import annotations

import re
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

import httpx
import pytest
import respx

from ndx_server.config import Settings
from ndx_server.demo import NOW, DemoProvider
from ndx_server.eco import (
    SERIES_PROVIDER,
    SOURCE_COUNTRY,
    Line,
    Rule,
    derive,
    expand,
    fill,
    indicator_rules,
    load_rules,
    period_label,
    period_start,
)
from ndx_server.models import Latency, MacroPoint, MacroSeries, Meta
from ndx_server.providers.calendars import (
    DST_API,
    CalEntry,
    DstProvider,
    infer_frequency,
    norm_period,
    parse_bea,
    parse_dst,
    parse_dst_csv,
    parse_ecb_meetings,
    parse_ecb_statscal,
    parse_eurostat,
    parse_fomc,
    parse_ics,
)
from ndx_server.providers.fred import parse_last_updated, parse_release_dates
from ndx_server.research import release_staleness

from .conftest import make_client
from .helpers import fixture, fixture_file


def text(name: str) -> str:
    return fixture_file(name).read_text(encoding="utf-8")


# ---------------------------------------------------------------------------- calendars


def test_bea_release_dates_are_utc_and_deduplicated() -> None:
    entries = parse_bea(fixture("bea_release_dates.json"))
    gdp = [e for e in entries if e.key == "Gross Domestic Product"]
    assert gdp and all(e.when is not None and e.when.tzinfo == UTC for e in gdp)
    nov = [e for e in gdp if e.day == date(2026, 11, 25)]
    assert len(nov) == 1 and nov[0].when == datetime(2026, 11, 25, 13, 30, tzinfo=UTC)
    trade = [e.when for e in entries if e.key.startswith("U.S. International Trade")]
    assert len(trade) == len(set(trade))  # the file repeats 2025-06-05; kept once
    assert not any(e.key == "file_last_updated" for e in entries)  # metadata key skipped


def test_eurostat_ics_is_all_day_with_unescaped_titles() -> None:
    entries = parse_ics(text("eurostat_euroind.ics"), "eurostat")
    assert entries and all(e.when is None for e in entries)
    titles = {e.title for e in entries}
    assert "Industrial producer prices, domestic market" in titles  # "\\," unescaped
    assert any(e.day == date(2026, 11, 13) and "GDP" in e.title for e in entries)


def test_ecb_statistical_calendar_frankfurt_times_periods_tentative() -> None:
    entries = parse_ecb_statscal(text("ecb_statscal.html"))
    wage = entries[0]
    assert wage.title == "ECB Wage Tracker"  # "(Dataset: EWT)" dropped
    assert wage.when == datetime(2026, 11, 4, 9, 0, tzinfo=UTC)  # 10:00 CET
    assert wage.period == "2026-10"
    assert any(e.tentative for e in entries)  # "Tentative" under the date
    assert any(e.period == "2026-Q2" for e in entries)


def test_ecb_meetings_keep_monetary_policy_decision_days_only() -> None:
    entries = parse_ecb_meetings(text("ecb_meetings.html"))
    assert entries and all("Day 2" in e.title for e in entries)
    assert entries[0].day == date(2026, 12, 17)


def test_dst_keeps_news_rows_in_copenhagen_time() -> None:
    entries = parse_dst(text("dst_planlagte.html"))
    assert entries and all(e.source == "dst" for e in entries)
    cpi = entries[0]
    assert cpi.title.startswith("Consumer price index")
    assert cpi.when == datetime(2026, 11, 10, 7, 0, tzinfo=UTC)  # 08:00 CET
    assert cpi.period == "2026-10"  # "Oktober 2026"
    assert not any(e.title.startswith("PRIS01") for e in entries)  # Table rows dropped


def test_fomc_decision_is_the_last_meeting_day() -> None:
    days = [e.day for e in parse_fomc(text("fomc_calendar.html"))]
    assert date(2026, 12, 9) in days and date(2026, 12, 8) not in days
    assert date(2027, 1, 27) in days


def test_fred_release_dates_and_last_updated() -> None:
    obj = {
        "release_dates": [
            {"release_id": 10, "release_name": "Consumer Price Index", "date": "2026-11-10"},
            {"release_id": "x", "date": "2026-11-10"},
        ]
    }
    assert parse_release_dates(obj) == [
        CalEntry("fred", "10", "Consumer Price Index", date(2026, 11, 10))
    ]
    assert parse_last_updated("2026-11-10 07:41:06-06") == datetime(
        2026, 11, 10, 13, 41, 6, tzinfo=UTC
    )
    assert parse_last_updated(None) is None


@pytest.mark.parametrize(
    ("raw", "want"),
    [
        ("Oct-2026", "2026-10"),
        ("Oktober 2026", "2026-10"),
        ("3rd Quarter 2026", "2026-Q3"),
        ("3 quarter 2026", "2026-Q3"),
        ("Q3 2026", "2026-Q3"),
        ("2025", "2025"),
        ("Sep-2026 / Q3 2026", "Sep-2026 / Q3 2026"),
        (None, None),
    ],
)
def test_periods_normalise(raw: str | None, want: str | None) -> None:
    assert norm_period(raw) == want


# ---------------------------------------------------------------------------- series


def test_eurostat_json_stat_and_updated() -> None:
    s = parse_eurostat(fixture("eurostat_prc_hicp_minr.json"), "x")
    assert s.data[-1].date == "2026-10" and s.data[-1].value == 4.0
    assert s.updated == datetime(2026, 11, 4, 10, 0, tzinfo=UTC)
    bad = fixture("eurostat_prc_hicp_minr.json")
    bad["size"] = [1, 2, 1, 1, len(bad["dimension"]["time"]["category"]["index"])]
    with pytest.raises(Exception, match="filter leaves 2"):
        parse_eurostat(bad, "x")


def test_dst_csv_periods() -> None:
    s = parse_dst_csv(text("dst_pris01.csv"), "PRIS01", None)
    assert [p.date for p in s.data][-2:] == ["2026-09", "2026-10"]
    assert s.data[-1].value == 2.2


@respx.mock
async def test_dst_series_reads_table_updated_and_posts_filters() -> None:
    respx.get(f"{DST_API}tableinfo/PRIS01").mock(
        return_value=httpx.Response(200, json={"updated": "2026-11-10T08:00:00"})
    )
    route = respx.post(f"{DST_API}data").mock(
        return_value=httpx.Response(200, text=text("dst_pris01.csv"))
    )
    p = DstProvider()
    s = await p.econ_series("PRIS01?VAREGR=000000&ENHED=300")
    await p.aclose()
    assert s.updated == datetime(2026, 11, 10, 7, 0, tzinfo=UTC)
    body = route.calls[0].request.content.decode()
    assert '"VAREGR"' in body and '"300"' in body and "(-n+130)" in body
    assert s.frequency == "M"


def series(points: list[tuple[str, float]], freq: str = "M") -> MacroSeries:
    return MacroSeries(
        id="s",
        title="s",
        frequency=freq,
        data=[MacroPoint(date=d, value=v) for d, v in points],
    )


def test_transforms() -> None:
    s = series([("2025-10", 100.0), ("2026-09", 102.0), ("2026-10", 103.02)])
    assert derive(s, "level", 1)[-1] == ("2026-10", 103.02)
    assert derive(s, "mom", 1)[-1][1] == pytest.approx(1.0)
    ((period, yoy),) = derive(s, "yoy", 1)
    assert period == "2026-10" and yoy == pytest.approx(3.02)
    assert derive(s, "diff", 1)[-1][1] == pytest.approx(1.02)
    claims = series([("2026-10-31", 221000.0)], "W")
    assert derive(claims, "level", 1000) == [("2026-10-31", 221.0)]
    assert period_label("2026-10-01", "M") == "2026-10"
    assert period_label("2026-07-01", "Q") == "2026-Q3"
    assert period_label("2026-11-09", "D") == "2026-11-09"


# ---------------------------------------------------------------------------- matching

RULE = Rule("fred", "10", "US", "CPI MoM", 3, "08:30", "America/New_York", "fred:X",
            "level", 1, "%", 1, "release")  # fmt: skip


def line(day: int, now: datetime, rule: Rule = RULE) -> Line:
    entry = CalEntry(rule.source, rule.match, "t", date(2026, 11, day))
    return expand(entry, now, [rule])[0]


def test_release_mode_waits_until_the_series_is_updated() -> None:
    now = datetime(2026, 11, 10, 15, 0, tzinfo=UTC)
    obs = [("2026-08", 0.2), ("2026-09", 0.3), ("2026-10", 0.4)]
    released, upcoming = line(10, now), line(20, now)
    assert released.event.released and not upcoming.event.released
    assert released.event.time == datetime(2026, 11, 10, 13, 30, tzinfo=UTC)  # 08:30 ET
    assert released.event.time_kind == "standard"
    group = [released, upcoming]
    fill(group, obs, updated=now - timedelta(minutes=20), now=now)
    assert (released.event.actual, released.event.prior) == (0.4, 0.3)
    assert released.event.period == "2026-10"
    assert upcoming.event.prior == 0.4
    stale = [line(10, now), line(20, now)]
    fill(stale, obs, updated=now - timedelta(days=20), now=now)
    assert stale[0].event.actual is None and stale[0].event.prior == 0.4
    assert "not in the series yet" in (stale[0].event.note or "")
    assert stale[1].event.prior is None


def test_estimate_mode_leaves_the_upcoming_prior_na() -> None:
    now = datetime(2026, 11, 10, 15, 0, tzinfo=UTC)
    rule = Rule(**{**RULE.__dict__, "mode": "estimate"})
    group = [line(20, now, rule)]
    fill(group, [("2026-Q2", 0.6), ("2026-Q3", 0.4)], None, now)
    assert group[0].event.prior is None and "which period" in (group[0].event.note or "")


def test_policy_rate_actual_waits_for_the_effective_date() -> None:
    rule = Rule(**{**RULE.__dict__, "mode": "date:6", "std_time": "14:15", "tz": "Europe/Berlin"})
    obs = [(f"2026-12-{d:02d}", 2.0) for d in range(10, 18)]
    now = datetime(2026, 12, 18, 9, 0, tzinfo=UTC)
    decision = [line(17, now, rule)]
    decision[0].entry = CalEntry("fred", "10", "t", date(2026, 12, 17))
    fill(decision, obs, None, now)
    assert decision[0].event.prior == 2.0 and decision[0].event.actual is None
    assert "takes effect on 2026-12-23" in (decision[0].event.note or "")
    later = [line(17, now, rule)]
    later[0].entry = CalEntry("fred", "10", "t", date(2026, 12, 17))
    fill(later, [*obs, ("2026-12-23", 1.75)], None, now)
    assert later[0].event.actual == 1.75


def test_unmapped_fred_dates_are_dropped_unmapped_others_kept() -> None:
    now = datetime(2026, 11, 10, tzinfo=UTC)
    assert expand(CalEntry("fred", "441", "Coinbase", date(2026, 11, 10)), now, []) == []
    es = expand(CalEntry("eurostat", "Retail trade", "Retail trade", date(2026, 11, 6)), now, [])
    assert len(es) == 1 and es[0].event.importance == 1
    assert es[0].event.time == datetime(2026, 11, 6, 10, 0, tzinfo=UTC)  # 11:00 Luxembourg


def test_mapping_file_is_consistent() -> None:
    rules = load_rules(Path(__file__).resolve().parents[2] / "data/symbology/eco_events.csv")
    assert len(rules) >= 30
    for r in rules:
        assert r.source in SOURCE_COUNTRY, r
        assert 1 <= r.importance <= 3
        assert r.transform in ("level", "mom", "yoy", "diff")
        assert r.mode in ("release", "estimate") or re.fullmatch(r"date:\d+", r.mode)
        if r.series:
            assert r.series.split(":", 1)[0] in SERIES_PROVIDER
        if r.source != "fred":
            re.compile(r.match)
        if r.std_time:
            assert re.fullmatch(r"\d{2}:\d{2}", r.std_time) and r.tz


# ---------------------------------------------------------------------------- API (DEMO)


@pytest.fixture
def demo_settings(settings: Settings) -> Settings:
    return settings.model_copy(update={"demo": True})


def test_api_eco_in_demo(demo_settings: Settings) -> None:
    with make_client(demo_settings, [DemoProvider()]) as c:
        r = c.get("/eco").json()
    assert r["meta"]["demo"] is True and r["now"].startswith("2026-11-09T14:30")
    assert "consensus" in r["meta"]["note"]
    dk = next(e for e in r["data"] if e["country"] == "DK" and e["event"] == "CPI YoY")
    assert dk["released"] and dk["time_kind"] == "calendar" and dk["period"] == "2026-10"
    assert dk["actual"] is not None and dk["prior"] is not None
    us = next(e for e in r["data"] if e["country"] == "US" and e["event"] == "CPI MoM")
    assert us["released"] and us["actual"] is not None and us["prior"] is not None
    assert us["time_kind"] == "standard" and us["period"] == "2026-10"
    assert all(e["survey"] is None and e["revised"] is None for e in r["data"])
    upcoming = [e for e in r["data"] if not e["released"]]
    assert upcoming[0]["event"] == "UMich consumer sentiment"
    assert upcoming[0]["time"].startswith("2026-11-09T15:00")
    assert r["no_source"] == ["DE", "UK", "JP", "CN"]
    assert r["sources"][0]["ok"] is True
    times = [e["time"] for e in r["data"]]
    assert times == sorted(times)
    assert (r["start"], r["end"]) == ("2026-11-08", (NOW.date() + timedelta(days=6)).isoformat())


# ---------------------------------------------------------------------------- ECST


def test_frequency_inference_and_period_start() -> None:
    assert infer_frequency(["2026-10"]) == "M"
    assert infer_frequency(["2026-Q3"]) == "Q"
    assert infer_frequency(["2026"]) == "A"
    assert infer_frequency(["2026-11-09"]) == "D"
    assert infer_frequency([]) is None
    assert period_start("2026-10") == "2026-10-01"
    assert period_start("2026-Q3") == "2026-07-01"
    assert period_start("2026") == "2026-01-01"
    assert period_start("2026-11-09") == "2026-11-09"


def test_indicator_keys_are_unique_per_series_line() -> None:
    by_key = indicator_rules(load_rules())
    assert "us-cpi-yoy" in by_key and "dk-cpi-yoy" in by_key and "ez-hicp-flash-yoy" in by_key
    for key, rs in by_key.items():
        assert re.fullmatch(r"[a-z0-9-]+", key)
        # one key = one series and one transform (the chart must not mix two definitions)
        assert len({(r.series, r.transform, r.scale) for r in rs}) == 1, key


def test_api_ecst_in_demo(demo_settings: Settings) -> None:
    with make_client(demo_settings, [DemoProvider()]) as c:
        lst = c.get("/eco/indicators").json()["data"]
        keys = {i["key"] for i in lst}
        assert {"us-cpi-mom", "dk-cpi-yoy", "ez-ecb-rate-decision-deposit-facility"} <= keys
        r = c.get("/eco/indicators/us-cpi-mom").json()
        missing = c.get("/eco/indicators/nope")
    assert r["indicator"]["transform_label"] == "% m/m" and r["frequency"] == "M"
    assert r["data"][-1]["period"] == "2026-10" and r["data"][-1]["date"] == "2026-10-01"
    assert len(r["data"]) >= 24
    assert r["meta"]["demo"] is True and r["meta"]["stale"] is False
    assert r["meta"]["as_of"].startswith("2026-10-01")
    assert r["last_release"].startswith("2026-11-09T13:30")  # US CPI, 08:30 ET today
    assert r["next_release"] is None  # the next CPI is beyond the DEMO calendar
    assert missing.status_code == 404


def test_ecst_marks_a_monthly_series_stale_only_after_months() -> None:
    meta = Meta(source="x", latency=Latency.STATIC, fetched_at=NOW)
    as_of = datetime(2026, 8, 1, tzinfo=UTC)
    fresh = release_staleness(meta.model_copy(update={"as_of": as_of}), "M", NOW)
    assert fresh.stale is False  # August data on 9 Nov: 100 days, under 2 periods + lag
    old = release_staleness(
        meta.model_copy(update={"as_of": datetime(2026, 7, 1, tzinfo=UTC)}), "M", NOW
    )
    assert old.stale is True  # July data on 9 Nov: Aug, Sep (and Oct) releases missed
