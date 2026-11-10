"""US yields from the Treasury par curve; FRED memory-only and never used for yields."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

import httpx
import pytest
import respx

from ndx_server.config import Settings
from ndx_server.models import AssetClass, Latency, Meta
from ndx_server.providers.fred import NOT_ENDORSED, FredApiProvider
from ndx_server.providers.treasury import (
    TreasuryProvider,
    build_series,
    is_treasury_series,
    parse_csv,
)
from ndx_server.research import release_staleness

from .conftest import make_client
from .helpers import fixture_file


def treasury_csv() -> str:
    return fixture_file("treasury_2026.csv").read_text()


def test_series_ids() -> None:
    for sid in ("US2Y", "US10Y", "US30Y", "US1M", "US1.5M", "US2S10S"):
        assert is_treasury_series(sid)
    assert not is_treasury_series("DGS10") and not is_treasury_series("UNRATE")


def test_build_10y_and_spread() -> None:
    tenors, data = parse_csv(treasury_csv())
    s10 = build_series("US10Y", tenors, data)
    assert s10.data[-1].date == "2026-11-06" and s10.data[-1].value == pytest.approx(4.86)
    spread = build_series("US2S10S", tenors, data)
    assert spread.data[-1].value == pytest.approx(4.86 - 4.51)


@respx.mock
def test_macro_endpoint_routes_us10y_to_treasury(settings: Settings) -> None:
    respx.get(url__regex=r"https://home\.treasury\.gov/.*").mock(
        return_value=httpx.Response(200, text=treasury_csv())
    )
    with make_client(settings, [TreasuryProvider()]) as c:
        r = c.get("/macro/US10Y")
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["meta"]["source"] == "U.S. Treasury" and body["meta"]["tag"] in ("EOD", "STALE")
        assert body["data"]["data"][-1]["value"] == pytest.approx(4.86)


@respx.mock
def test_treasury_as_of_is_the_quote_time_in_new_york(settings: Settings) -> None:
    """The 2026-11-06 curve describes FRBNY's ~3:30 PM ET quotes (methodology page), not
    midnight UTC (which would make it look ~20 hours older than it is)."""
    respx.get(url__regex=r"https://home\.treasury\.gov/.*").mock(
        return_value=httpx.Response(200, text=treasury_csv())
    )
    ny = ZoneInfo("America/New_York")
    with make_client(settings, [TreasuryProvider()]) as c:
        curve = c.get("/yields/us")
        assert curve.status_code == 200, curve.text
        meta = curve.json()["meta"]
        assert datetime.fromisoformat(meta["as_of"]) == datetime(2026, 11, 6, 15, 30, tzinfo=ny)
        assert "3:30 PM ET" in meta["note"]
        series = c.get("/macro/US10Y").json()["meta"]
        assert datetime.fromisoformat(series["as_of"]) == datetime(2026, 11, 6, 15, 30, tzinfo=ny)


def test_fred_yield_ids_rejected(settings: Settings) -> None:
    with make_client(settings, [FredApiProvider("k" * 32)]) as c:
        r = c.get("/macro/DGS10")
        assert r.status_code == 400 and "Treasury" in r.json()["error"]


def test_fred_is_memory_only_with_notice() -> None:
    fred = FredApiProvider("k" * 32)
    assert fred.storage == "memory"
    assert NOT_ENDORSED in (fred.result_meta(AssetClass.INDEX, None)[2] or "")


def test_frequency_aware_stale() -> None:
    now = datetime(2026, 11, 9, tzinfo=UTC)
    base = Meta(source="x", latency=Latency.EOD, fetched_at=now)
    monthly = base.model_copy(update={"as_of": now - timedelta(days=40)})
    assert release_staleness(monthly, "Monthly", now).tag == "EOD"
    daily = base.model_copy(update={"as_of": now - timedelta(days=40)})
    assert release_staleness(daily, "Daily", now).tag == "STALE"


def test_latest_release_is_not_stale_before_the_next_one_is_due() -> None:
    # Review 1a #6: observations are dated at the period start, so publication lag counts.
    def tag(as_of: datetime, freq: str, now: datetime) -> str:
        meta = Meta(source="x", latency=Latency.EOD, fetched_at=now, as_of=as_of)
        return release_staleness(meta, freq, now).tag

    d = lambda y, m, day: datetime(y, m, day, tzinfo=UTC)  # noqa: E731
    # Real GDP Q3 (07-01) is the latest value until the Q4 advance estimate (~01-28).
    assert tag(d(2026, 7, 1), "Quarterly", d(2027, 1, 27)) == "EOD"
    assert tag(d(2026, 7, 1), "Q", d(2027, 5, 1)) == "STALE"  # Q4 long overdue
    # PCE August (08-01) stays latest until September PCE (~10-30); CPI likewise (~10-15).
    assert tag(d(2026, 8, 1), "Monthly", d(2026, 10, 29)) == "EOD"
    assert tag(d(2026, 8, 1), "Monthly", d(2026, 10, 12)) == "EOD"
    assert tag(d(2026, 8, 1), "Monthly", d(2026, 12, 15)) == "STALE"


# FRED's answer to a malformed key, recorded 2026-11-09 (the key itself is not echoed).
FRED_BAD_KEY = (
    '{"error_code":400,"error_message":"Bad Request.  The value for variable api_key is not a '
    "32 character alpha-numeric lower-case string.  Read "
    'https:\\/\\/fred.stlouisfed.org\\/docs\\/api\\/api_key.html for more information."}'
)


@respx.mock
async def test_fred_bad_key_is_an_auth_error_not_a_missing_series() -> None:
    from ndx_server.providers.base import AuthError, NotFound

    route = respx.get(url__regex=r"https://api\.stlouisfed\.org/fred/series.*")
    route.mock(return_value=httpx.Response(400, text=FRED_BAD_KEY))
    fred = FredApiProvider("x" * 32)
    with pytest.raises(AuthError, match="rejected the API key"):
        await fred.series("UNRATE")
    route.mock(
        return_value=httpx.Response(
            400,
            text='{"error_code":400,"error_message":"Bad Request.  The series does not exist."}',
        )
    )
    with pytest.raises(NotFound, match="no series NOSUCH"):
        await fred.series("NOSUCH")
    await fred.aclose()
