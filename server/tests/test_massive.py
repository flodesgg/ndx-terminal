"""Massive Stocks Basic, US bars history (Phase 2 step 2.7): recorded responses."""

from __future__ import annotations

from datetime import UTC, date, datetime
from zoneinfo import ZoneInfo

import httpx
import pytest
import respx

from ndx_server.market import MarketService
from ndx_server.providers.base import NotFound, NotSupported
from ndx_server.providers.cache import TTLCache
from ndx_server.providers.massive import (
    BASE,
    MassiveProvider,
    last_available_day,
    massive_symbol,
    valid_until,
)
from ndx_server.providers.ratelimit import TokenBucket
from ndx_server.providers.registry import PREFERENCES
from ndx_server.providers.router import ProviderRouter
from ndx_server.symbols import classify

from .helpers import fixture

KEY = "massive-test-key-0123456789abcdef"
NY = ZoneInfo("America/New_York")
# Recorded 2026-11-09 ~14:00 ET (Monday): the newest bar is Friday 2026-11-06.
RECORDED = datetime(2026, 11, 9, 19, 30, tzinfo=UTC)
AAPL = classify("AAPL")
AGGS = f"{BASE}/v2/aggs/ticker"


class Clock:
    def __init__(self, now: datetime) -> None:
        self.now = now

    def __call__(self) -> datetime:
        return self.now


def body(name: str) -> dict[str, object]:
    rec = fixture(name)
    out: dict[str, object] = rec["body"]
    return out


def provider(now: datetime = RECORDED) -> MassiveProvider:
    return MassiveProvider(KEY, clock=Clock(now))


def test_symbols_and_the_plan_window() -> None:
    assert massive_symbol("BRK-B") == "BRK.B" and massive_symbol("AAPL") == "AAPL"
    # Basic: the previous New York day, available a few minutes after midnight ET
    assert last_available_day(RECORDED) == date(2026, 11, 8)
    just_after_midnight = datetime(2026, 11, 10, 0, 1, tzinfo=NY)
    assert last_available_day(just_after_midnight) == date(2026, 11, 8)
    assert last_available_day(datetime(2026, 11, 10, 0, 6, tzinfo=NY)) == date(2026, 11, 9)
    assert valid_until(RECORDED) == datetime(2026, 11, 10, 0, 5, tzinfo=NY)


@respx.mock
async def test_daily_bars_request_and_parse() -> None:
    route = respx.get(url__startswith=f"{AGGS}/AAPL/range/1/day/").mock(
        return_value=httpx.Response(200, json=body("massive_aapl_1d.json"))
    )
    p = provider()
    s = await p.bars(AAPL, "1d", 365 * 5)
    req = route.calls[0].request
    # two years at most, up to the previous New York day; the key only in the header
    assert req.url.path.endswith("/range/1/day/2024-11-09/2026-11-08")
    assert req.headers["Authorization"] == f"Bearer {KEY}" and KEY not in str(req.url)
    assert req.url.params["adjusted"] == "true"
    rows = body("massive_aapl_1d.json")["results"]
    assert isinstance(rows, list) and len(s.bars) == len(rows)
    first = datetime.fromtimestamp(s.bars[0].t, UTC)
    assert (first.date(), first.hour) == (date(2024, 11, 11), 0)  # local date at 00:00
    last = s.bars[-1]
    assert last.c == rows[-1]["c"] and last.v == rows[-1]["v"]
    assert datetime.fromtimestamp(last.t, UTC).date() == date(2026, 11, 6)
    assert s.as_of == datetime(2026, 11, 6, 21, 0, tzinfo=UTC)  # 16:00 ET close
    assert s.tz == "America/New_York" and s.note is None
    await p.aclose()


@respx.mock
async def test_intraday_bars_are_local_wall_clock_with_extended_hours() -> None:
    respx.get(url__startswith=f"{AGGS}/AAPL/range/5/minute/").mock(
        return_value=httpx.Response(200, json=body("massive_aapl_5m.json"))
    )
    p = provider()
    s = await p.bars(AAPL, "5m", 7)
    first = datetime.fromtimestamp(s.bars[0].t, UTC)
    assert first.isoformat().startswith("2026-11-02T04:00")  # pre-market start, ET
    last = datetime.fromtimestamp(s.bars[-1].t, UTC)
    assert last.isoformat().startswith("2026-11-06T19:55")
    assert s.as_of == datetime(2026, 11, 6, 20, 0, tzinfo=NY)  # the last window's end
    await p.aclose()


@respx.mock
async def test_share_class_ticker_uses_a_dot() -> None:
    route = respx.get(url__startswith=f"{AGGS}/BRK.B/range/1/day/").mock(
        return_value=httpx.Response(200, json=body("massive_brkb_1d.json"))
    )
    p = provider()
    s = await p.bars(classify("BRK-B"), "1d", 7)
    assert route.called and len(s.bars) == 5
    assert p.provider_symbol(classify("BRK-B")) == "BRK.B"
    await p.aclose()


@respx.mock
async def test_today_is_outside_the_plan_not_a_bad_key() -> None:
    rec = fixture("massive_today_403.json")
    respx.get(url__startswith=f"{AGGS}/AAPL/").mock(
        return_value=httpx.Response(rec["status"], json=rec["body"])
    )
    p = provider()
    with pytest.raises(NotSupported, match="outside the plan"):
        await p.bars(AAPL, "1d", 7)
    await p.aclose()


@respx.mock
async def test_unknown_ticker_is_not_found() -> None:
    respx.get(url__startswith=f"{AGGS}/ZZZZQX/").mock(
        return_value=httpx.Response(200, json=body("massive_unknown.json"))
    )
    p = provider()
    with pytest.raises(NotFound):
        await p.bars(classify("ZZZZQX"), "1d", 7)
    await p.aclose()


async def test_out_of_scope_makes_no_request() -> None:
    p = provider()
    with pytest.raises(NotSupported):
        await p.bars(classify("NOVO-B.CO"), "1d", 30)
    with pytest.raises(NotSupported):
        await p.bars(AAPL, "1wk", 365)
    assert not MassiveProvider("").enabled
    await p.aclose()


def _page(rows: list[dict[str, object]], nxt: str | None) -> dict[str, object]:
    out: dict[str, object] = {"status": "OK", "results": rows}
    if nxt:
        out["next_url"] = nxt
    return out


@respx.mock
async def test_pages_newest_first_and_a_note_when_older_ones_are_left_out() -> None:
    rows = body("massive_aapl_5m.json")["results"]
    assert isinstance(rows, list) and len(rows) >= 9
    newest, middle, oldest = rows[-3:], rows[3:6], rows[:3]
    route = respx.get(url__startswith=f"{AGGS}/AAPL/range/1/hour/")
    route.mock(return_value=httpx.Response(200, json=_page(newest[::-1], f"{BASE}/next?c=2")))
    page2 = respx.get(f"{BASE}/next?c=2").mock(
        return_value=httpx.Response(200, json=_page(middle[::-1], f"{BASE}/next?c=3"))
    )
    page3 = respx.get(f"{BASE}/next?c=3").mock(
        return_value=httpx.Response(200, json=_page(oldest[::-1], f"{BASE}/next?c=4"))
    )
    p = provider()
    p.rate = TokenBucket.per_minute(600, 10)  # tokens at once for the extra pages
    s = await p.bars(AAPL, "1h", 240)
    assert page2.called and page3.called
    assert page3.calls[0].request.headers["Authorization"] == f"Bearer {KEY}"
    ts = [b.t for b in s.bars]
    assert ts == sorted(ts) and len(ts) == 9  # merged oldest -> newest
    assert s.note is not None and s.note.startswith("Massive: older bars not loaded")
    assert p.meta_overrides(AAPL, s) == {"note": s.note}
    await p.aclose()


@respx.mock
async def test_market_service_routes_us_bars_to_massive_tagged_eod() -> None:
    respx.get(url__startswith=f"{AGGS}/AAPL/range/1/day/").mock(
        return_value=httpx.Response(200, json=body("massive_aapl_1d.json"))
    )
    router = ProviderRouter(
        [provider()], cache=TTLCache(), preferences=PREFERENCES, retry_delays=()
    )
    res = await MarketService(router).bars("AAPL", "1d", None)
    assert res.meta.source == "Massive" and res.meta.tag == "EOD"
    assert res.meta.provider_symbol == "AAPL" and res.data
    await router.aclose()
