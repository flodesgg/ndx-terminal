"""EODHD Free adapter (Phase 2 step 2.1): recorded fixtures, persisted 18/day budget."""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta
from pathlib import Path

import httpx
import pytest
import respx

from ndx_server.barstore import BarStore
from ndx_server.market import MarketService
from ndx_server.models import Latency
from ndx_server.providers.base import (
    LocalRateLimited,
    NetworkError,
    NotFound,
    NotSupported,
    RateLimited,
)
from ndx_server.providers.cache import TTLCache
from ndx_server.providers.eodhd import (
    BASE,
    EodhdProvider,
    bar_date,
    eodhd_symbol,
    exchange_of,
    parse_eod,
    valid_until,
)
from ndx_server.providers.quota import DailyQuota
from ndx_server.providers.registry import PREFERENCES
from ndx_server.providers.router import ProviderRouter, RouterError
from ndx_server.symbols import classify

from .helpers import fixture

KEY = "eodhd-test-key-0123456789"
# Recorded 2026-11-09 18:02 UTC: two hours after Copenhagen closed, Novo B's close for
# 2026-11-09 was not published yet (newest row 2026-11-06).
RECORDED = datetime(2026, 11, 9, 18, 2, tzinfo=UTC)
NOVO = classify("NOVOB DC EQUITY")
EOD_URL = f"{BASE}/eod/NOVO-B.CO"
USER_URL = f"{BASE}/user"


def novo_rows() -> list[dict[str, object]]:
    rec = fixture("eodhd_eod_novo.json")
    assert rec["status"] == 200
    rows: list[dict[str, object]] = rec["body"]
    return rows


class Clock:
    def __init__(self, now: datetime) -> None:
        self.now = now

    def __call__(self) -> datetime:
        return self.now


def provider(tmp_path: Path | None, now: datetime = RECORDED) -> EodhdProvider:
    return EodhdProvider(KEY, tmp_path, clock=Clock(now))


def mock_user(payload: str = "eodhd_user.json") -> respx.Route:
    return respx.get(USER_URL).mock(return_value=httpx.Response(200, json=fixture(payload)))


# ----- parsing and symbols -----


def test_parse_eod_recorded() -> None:
    ex = exchange_of(NOVO)
    assert ex is not None and ex.code == "DC"
    s = parse_eod(novo_rows(), NOVO.symbol, ex, RECORDED)
    assert len(s.bars) == 10
    assert bar_date(s.bars[-1]) == date(2026, 11, 6) and s.bars[-1].c == 269.45
    assert s.bars[-1].v == 5243688
    assert s.tz == "Europe/Copenhagen" and s.utc_offset_s == 3600
    # as_of = that session's regular close (XCSE 17:00 CET)
    assert s.as_of == datetime(2026, 11, 6, 16, 0, tzinfo=UTC)
    with pytest.raises(NotFound):
        parse_eod([], NOVO.symbol, ex, RECORDED)


def test_symbols_and_scope() -> None:
    ex = exchange_of(NOVO)
    assert ex is not None and eodhd_symbol(NOVO, ex) == "NOVO-B.CO"
    sap = classify("SAP GY EQUITY")
    gex = exchange_of(sap)
    assert gex is not None and eodhd_symbol(sap, gex) == "SAP.XETRA"
    bp = classify("BP LN EQUITY")
    lex = exchange_of(bp)
    assert lex is not None and eodhd_symbol(bp, lex) == "BP.LSE"
    # US listings and non-European exchanges are out of scope (D13)
    assert exchange_of(classify("AAPL")) is None
    assert exchange_of(classify("7203.T")) is None
    assert exchange_of(classify("EURDKK")) is None


def test_valid_until_waits_for_the_next_published_close() -> None:
    ex = exchange_of(NOVO)
    assert ex is not None
    # fetched 18:02 with 11-06 as newest: 11-09 is not due yet (close 16:00 + 4 h settle)
    assert valid_until(ex, RECORDED, date(2026, 11, 6)) == datetime(2026, 11, 9, 20, 0, tzinfo=UTC)
    # fetched 21:00 and 11-09 still missing: retry in 2 h, not tomorrow
    late = datetime(2026, 11, 9, 21, 0, tzinfo=UTC)
    assert valid_until(ex, late, date(2026, 11, 6)) == late + timedelta(hours=2)
    # fetched 21:00 with 11-09 present: current until 11-10's close is published
    assert valid_until(ex, late, date(2026, 11, 9)) == datetime(2026, 11, 10, 20, 0, tzinfo=UTC)


# ----- the persisted daily budget -----


def test_daily_quota_persists_and_rolls_over(tmp_path: Path) -> None:
    clock = Clock(RECORDED)
    q = DailyQuota("eodhd", 18, tmp_path, clock)
    assert all(q.try_take() for _ in range(18))
    assert not q.try_take() and q.used == 18 and q.left == 0
    again = DailyQuota("eodhd", 18, tmp_path, clock)  # a restart keeps the count
    assert again.used == 18 and not again.try_take()
    clock.now = RECORDED + timedelta(days=1)  # 00:00 UTC resets it
    assert again.used == 0 and again.try_take()
    # the provider's own report raises the count, never lowers it
    again.sync(5, clock.now.date())
    assert again.used == 5
    again.sync(2, clock.now.date())
    again.sync(9, date(2026, 1, 1))  # another day's count is ignored
    assert again.used == 5


# ----- the adapter -----


@respx.mock
async def test_quote_and_bars_share_one_call(tmp_path: Path) -> None:
    mock_user()
    eod = respx.get(EOD_URL).mock(return_value=httpx.Response(200, json=novo_rows()))
    p = provider(tmp_path)
    q = await p.quote(NOVO)
    rows = novo_rows()
    prev = float(rows[-2]["close"])  # type: ignore[arg-type]
    assert q.price == 269.45 and q.prev_close == prev
    assert q.change == pytest.approx(269.45 - prev)
    assert q.currency == "DKK" and q.ts == datetime(2026, 11, 6, 16, 0, tzinfo=UTC)
    s = await p.bars(NOVO, "1d", 365)
    assert len(s.bars) == 10 and eod.call_count == 1
    assert p.daily.used == 1  # one call of the day's 18
    req = eod.calls[0].request
    assert req.url.params["api_token"] == KEY and req.url.params["fmt"] == "json"
    assert req.url.params["from"] == "2025-11-09"  # one year: the Free plan's history
    meta = p.meta_overrides(NOVO, q)
    assert meta["fetched_at"] == RECORDED and meta["cached"] is True  # bars re-served it
    assert meta["stale_after_s"] == pytest.approx(2 * (20 * 3600 - (18 * 3600 + 120)))
    await p.aclose()


@respx.mock
async def test_count_syncs_with_eodhd_and_is_persisted(tmp_path: Path) -> None:
    mock_user("eodhd_user_after.json")  # 3 calls already spent on 2026-11-09
    respx.get(EOD_URL).mock(return_value=httpx.Response(200, json=novo_rows()))
    p = provider(tmp_path)
    await p.quote(NOVO)
    assert p.daily.used == 4
    assert p.status().quota_used == 4 and p.status().quota_limit == 18
    assert DailyQuota("eodhd", 18, tmp_path, Clock(RECORDED)).used == 4
    await p.aclose()


@respx.mock
async def test_budget_spent_serves_the_stored_close_or_na(tmp_path: Path) -> None:
    mock_user()
    eod = respx.get(EOD_URL).mock(return_value=httpx.Response(200, json=novo_rows()))
    store = BarStore(tmp_path / "bars.duckdb")
    p = provider(tmp_path)
    p.attach_store(store)
    for _ in range(18):
        assert p.daily.try_take()
    with pytest.raises(LocalRateLimited):
        await p.quote(NOVO)  # nothing stored: N.A., and no request
    assert eod.call_count == 0

    # A close fetched yesterday is past its refresh time; the budget is gone -> served as
    # a stored copy (CACHE, ageing to STALE in the UI) with a note.
    day_before = RECORDED - timedelta(days=1)
    ex = exchange_of(NOVO)
    assert ex is not None
    store.put(
        NOVO.symbol,
        "1d",
        parse_eod(novo_rows()[:-1], NOVO.symbol, ex, day_before),
        "EODHD",
        Latency.EOD,
        day_before,
    )
    q = await p.quote(NOVO)
    assert q.price == float(novo_rows()[-2]["close"])  # type: ignore[arg-type]
    meta = p.meta_overrides(NOVO, q)
    assert meta["cached"] is True and meta["fetched_at"] == day_before
    assert "18/18" in meta["note"] and eod.call_count == 0
    store.close()
    await p.aclose()


@respx.mock
async def test_stored_close_is_reused_after_a_restart(tmp_path: Path) -> None:
    mock_user()
    eod = respx.get(EOD_URL).mock(return_value=httpx.Response(200, json=novo_rows()))
    store = BarStore(tmp_path / "bars.duckdb")
    first = provider(tmp_path)
    first.attach_store(store)
    await first.quote(NOVO)
    await first.aclose()
    second = provider(tmp_path, RECORDED + timedelta(minutes=30))
    second.attach_store(store)
    q = await second.quote(NOVO)
    assert q.price == 269.45 and eod.call_count == 1 and second.daily.used == 1
    store.close()
    await second.aclose()


@respx.mock
async def test_http_errors(tmp_path: Path) -> None:
    mock_user()
    unknown = fixture("eodhd_eod_unknown.json")  # recorded for NOSUCHTICKERX.CO
    respx.get(f"{BASE}/eod/ZZZZQ.CO").mock(
        return_value=httpx.Response(unknown["status"], text=unknown["body"])
    )
    p = provider(tmp_path)
    with pytest.raises(NotFound) as nf:
        await p.quote(classify("ZZZZQ.CO"))
    assert p.daily.used == 1  # EODHD counts a 404 as a call
    assert KEY not in str(nf.value)

    respx.get(EOD_URL).mock(
        return_value=httpx.Response(402, text="API Rate Limit Exceeded. Please, contact ...")
    )
    with pytest.raises(RateLimited):
        await p.quote(NOVO)
    assert p.daily.left == 0  # EODHD says the day's calls are gone: stop asking
    await p.aclose()


async def test_out_of_scope_requests_make_no_call(tmp_path: Path) -> None:
    p = provider(tmp_path)
    with pytest.raises(NotSupported):
        await p.quote(classify("AAPL"))
    with pytest.raises(NotSupported):
        await p.bars(NOVO, "5m", 5)
    assert p.daily.used == 0
    assert not EodhdProvider("", tmp_path).enabled
    await p.aclose()


@respx.mock
async def test_market_service_tags_eod_then_cache(tmp_path: Path) -> None:
    mock_user()
    eod = respx.get(EOD_URL).mock(return_value=httpx.Response(200, json=novo_rows()))
    p = provider(tmp_path)
    router = ProviderRouter([p], cache=TTLCache(), preferences=PREFERENCES, retry_delays=())
    store = BarStore(tmp_path / "bars.duckdb")
    service = MarketService(router, store)
    first = await service.quote("NOVOB DC EQUITY")
    assert first.meta.source == "EODHD" and first.meta.tag == "EOD"
    assert first.meta.provider_symbol == "NOVO-B.CO"
    assert first.meta.as_of == datetime(2026, 11, 6, 16, 0, tzinfo=UTC)
    router.cache.invalidate()
    again = await service.quote("NOVOB DC EQUITY")
    assert again.meta.tag == "CACHE" and again.meta.fetched_at == RECORDED
    bars = await service.bars("NOVOB DC EQUITY", "1d", None)
    assert len(bars.data) == 10 and bars.meta.source == "EODHD"
    assert eod.call_count == 1
    store.close()
    await router.aclose()


# ----- index levels (decision: OMXC25 and DAX first) -----

OMXC25 = classify("OMXC25 INDEX")
DAX = classify("DAX INDEX")


def index_rows() -> list[dict[str, object]]:
    rec = fixture("eodhd_eod_index.json")  # OMXC25.INDX, recorded for P17
    rows: list[dict[str, object]] = rec["body"]
    return rows


def test_index_venues_come_from_the_checked_codes() -> None:
    from ndx_server.providers.eodhd import venue

    v = venue(OMXC25)
    assert v is not None and v[0].code == "DC" and v[1] == "OMXC25.INDX"
    d = venue(DAX)
    assert d is not None and d[0].code == "GY" and d[1] == "GDAXI.INDX"
    assert venue(classify("UKX INDEX")) is None  # FTSE 100 is not in EODHD's INDX list
    assert venue(classify("SPX INDEX")) is None  # US/Asia indices: outside D13's scope
    assert venue(classify("ES1 INDEX")) is None  # a future, not an index level


@respx.mock
async def test_index_level_is_an_eod_quote_in_points(tmp_path: Path) -> None:
    mock_user()
    route = respx.get(f"{BASE}/eod/OMXC25.INDX").mock(
        return_value=httpx.Response(200, json=index_rows())
    )
    p = provider(tmp_path)
    q = await p.quote(OMXC25)
    last, prev = index_rows()[-1], index_rows()[-2]
    assert q.price == last["close"] and q.prev_close == prev["close"]
    assert q.currency is None  # a level, not a price in DKK
    assert q.ts is not None and q.ts.date() == date.fromisoformat(str(last["date"]))
    assert p.provider_symbol(OMXC25) == "OMXC25.INDX" and route.call_count == 1
    await p.aclose()


@respx.mock
async def test_last_calls_are_kept_for_omxc25_and_dax(tmp_path: Path) -> None:
    mock_user()
    respx.get(EOD_URL).mock(return_value=httpx.Response(200, json=novo_rows()))
    omx = respx.get(f"{BASE}/eod/OMXC25.INDX").mock(
        return_value=httpx.Response(200, json=index_rows())
    )
    p = provider(tmp_path)
    for _ in range(16):  # 2 of 18 left, neither priority index fetched yet
        assert p.daily.try_take()
    with pytest.raises(LocalRateLimited, match="kept for OMXC25 and DAX"):
        await p.quote(NOVO)
    await p.quote(OMXC25)  # a priority index may spend a kept call
    assert omx.call_count == 1 and p.daily.left == 1 and p.reserved(RECORDED) == 1
    with pytest.raises(LocalRateLimited, match="kept for OMXC25 and DAX"):
        await p.quote(NOVO)  # the last call is still DAX's
    await p.aclose()


def test_index_routing_prefers_yfinance_then_eodhd() -> None:
    from ndx_server.models import AssetClass
    from ndx_server.providers.base import Capability

    assert PREFERENCES[(Capability.QUOTE, AssetClass.INDEX)] == ["yahoo", "eodhd"]
    assert PREFERENCES[(Capability.BARS, AssetClass.INDEX)] == ["yahoo", "eodhd"]


@respx.mock
async def test_a_failed_call_is_not_retried_and_an_unreached_one_is_refunded(
    tmp_path: Path,
) -> None:
    # Review 2 M1: one 503 cost three of the day's calls (router retries), and a connection
    # that never reached EODHD still counted.
    mock_user()
    eod = respx.get(EOD_URL).mock(return_value=httpx.Response(503, text="busy"))
    p = provider(tmp_path)
    svc = MarketService(ProviderRouter([p], preferences=PREFERENCES, retry_delays=(0.0, 0.0)), None)
    with pytest.raises(RouterError):
        await svc.quote("NOVOB DC EQUITY")
    assert eod.call_count == 1 and p.daily.used == 1
    eod.mock(side_effect=httpx.ConnectError("no route"))
    used = p.daily.used
    with pytest.raises(NetworkError):
        await p.quote(NOVO)
    assert p.daily.used == used
    await p.aclose()
