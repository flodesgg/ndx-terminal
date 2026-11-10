"""ECB EXR and NBU official FX reference rates (Phase 2 step 2.2), recorded fixtures."""

from __future__ import annotations

import time
from datetime import UTC, date, datetime
from types import SimpleNamespace
from zoneinfo import ZoneInfo

import httpx
import pytest
import respx

from ndx_server.market import MarketService
from ndx_server.providers import ratelimit
from ndx_server.providers.base import NotSupported
from ndx_server.providers.cache import TTLCache
from ndx_server.providers.ecb import URL as ECB_URL
from ndx_server.providers.ecb import EcbProvider, parse_exr, valid_until
from ndx_server.providers.nbu import URL as NBU_URL
from ndx_server.providers.nbu import NbuProvider
from ndx_server.providers.registry import PREFERENCES
from ndx_server.providers.router import ProviderRouter
from ndx_server.symbols import classify

from .helpers import fixture, fixture_file

# Recorded 2026-11-09 ~18:40 UTC (after the ECB's 16:00 CET publication of the 11-09 fixings).
RECORDED = datetime(2026, 11, 9, 18, 40, tzinfo=UTC)
CET = ZoneInfo("Europe/Berlin")
KYIV = ZoneInfo("Europe/Kyiv")


class Clock:
    def __init__(self, now: datetime) -> None:
        self.now = now

    def __call__(self) -> datetime:
        return self.now


def exr_text() -> str:
    return fixture_file("ecb_exr_last2.csv").read_text()


def mock_ecb() -> respx.Route:
    return respx.get(ECB_URL).mock(return_value=httpx.Response(200, text=exr_text()))


def mock_nbu() -> respx.Route:
    def answer(request: httpx.Request) -> httpx.Response:
        day = request.url.params["date"]
        return httpx.Response(200, json=fixture(f"nbu_{day}.json"))

    return respx.get(NBU_URL).mock(side_effect=answer)


# ----- ECB -----


def test_parse_exr_keeps_live_currencies_only() -> None:
    fixes = parse_exr(exr_text(), RECORDED)
    assert len(fixes) == 29  # docs/PROVIDERS.md §3.7: 29 currencies
    assert "ARS" not in fixes and "RUB" not in fixes and "UAH" not in fixes
    dkk = fixes["DKK"]
    assert (dkk.day, dkk.value, dkk.prev_day, dkk.prev) == (
        date(2026, 11, 9),
        7.4753,
        date(2026, 11, 6),
        7.4752,
    )


def test_ecb_pairs_direct_inverse_cross() -> None:
    p = EcbProvider(clock=Clock(RECORDED))
    fixes = parse_exr(exr_text(), RECORDED)
    direct = p.pair_rate("EUR", "DKK", fixes)
    assert direct is not None and direct.price == 7.4753 and not direct.derived
    inverse = p.pair_rate("USD", "EUR", fixes)
    assert inverse is not None and inverse.price == pytest.approx(1 / 1.1193)
    assert inverse.derived
    cross = p.pair_rate("USD", "DKK", fixes)
    assert cross is not None and cross.derived
    assert cross.price == pytest.approx(7.4753 / 1.1193)
    assert cross.prev == pytest.approx(7.4752 / 1.1165)
    assert cross.day == date(2026, 11, 9)
    assert p.pair_rate("EUR", "XAU", fixes) is None
    assert not p.handles("EUR", "UAH")


@pytest.mark.parametrize(
    ("fetched", "newest", "expected"),
    [
        # Monday morning: today's publication
        (datetime(2026, 11, 9, 10, 0, tzinfo=CET), date(2026, 11, 6), (2026, 11, 9, 16, 15)),
        # Monday evening, today's fixing in: Tuesday's publication
        (datetime(2026, 11, 9, 18, 0, tzinfo=CET), date(2026, 11, 9), (2026, 11, 10, 16, 15)),
        # Friday evening, Friday's fixing in: Monday's publication
        (datetime(2026, 11, 13, 18, 0, tzinfo=CET), date(2026, 11, 13), (2026, 11, 16, 16, 15)),
        # Monday 21:00 without Monday's fixing (a TARGET holiday): Tuesday's
        (datetime(2026, 11, 9, 21, 0, tzinfo=CET), date(2026, 11, 6), (2026, 11, 10, 16, 15)),
    ],
)
def test_ecb_refresh_follows_publication(
    fetched: datetime, newest: date, expected: tuple[int, ...]
) -> None:
    assert valid_until(fetched, newest) == datetime(*expected, tzinfo=CET)


def test_ecb_late_fixing_is_retried_hourly() -> None:
    fetched = datetime(2026, 11, 9, 17, 0, tzinfo=CET)
    assert (valid_until(fetched, date(2026, 11, 6)) - fetched).total_seconds() == 3600


@respx.mock
async def test_ecb_batch_is_one_request() -> None:
    route = mock_ecb()
    p = EcbProvider(clock=Clock(RECORDED))
    insts = [classify(s) for s in ("EURUSD", "EURDKK", "USDDKK", "GBPUSD", "EURUAH")]
    got = await p.quotes(insts)
    assert set(got) == {"EURUSD", "EURDKK", "USDDKK", "GBPUSD"}
    assert isinstance(got.errors["EURUAH"], NotSupported)  # type: ignore[attr-defined]
    q = got["EURDKK"]
    assert q.price == 7.4753 and q.prev_close == 7.4752 and q.currency == "DKK"
    assert q.change == pytest.approx(0.0001)
    assert q.ts == datetime(2026, 11, 9, 14, 15, tzinfo=CET)
    assert p.meta_overrides(classify("EURDKK"), q)["note"] == p.source_note
    assert p.meta_overrides(classify("USDDKK"), got["USDDKK"])["note"] == p.derived_note
    await p.quotes(insts)  # answered from the table
    assert route.call_count == 1 and p.status().quota_used == 1
    assert p.meta_overrides(classify("EURDKK"), q)["cached"] is True
    await p.aclose()


# ----- NBU -----


@respx.mock
async def test_nbu_rate_in_effect_today_and_the_day_before(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # The quota counts per wall-clock minute; pin it so a run across a minute edge stays at 2.
    wall = SimpleNamespace(time=lambda: 1_789_000_020.0, monotonic=time.monotonic)
    monkeypatch.setattr(ratelimit, "time", wall)
    route = mock_nbu()
    p = NbuProvider(clock=Clock(datetime(2026, 11, 9, 10, 0, tzinfo=UTC)))
    eur = await p.quote(classify("EURUAH"))
    nbu_09 = {r["cc"]: r["rate"] for r in fixture("nbu_20261109.json")}
    nbu_08 = {r["cc"]: r["rate"] for r in fixture("nbu_20261108.json")}
    assert eur.price == nbu_09["EUR"] and eur.prev_close == nbu_08["EUR"]
    assert eur.ts == datetime(2026, 11, 9, 0, 0, tzinfo=KYIV) and eur.currency == "UAH"
    inv = await p.quote(classify("UAHUSD"))
    assert inv.price == pytest.approx(1 / nbu_09["USD"])
    assert p.meta_overrides(classify("UAHUSD"), inv)["note"] == p.derived_note
    with pytest.raises(NotSupported):
        await p.quote(classify("EURUSD"))
    dates = sorted(c.request.url.params["date"] for c in route.calls)
    assert dates == ["20261108", "20261109"]  # two requests, then the table serves
    assert p.status().quota_used == 2
    await p.aclose()


# ----- routing -----


@respx.mock
async def test_fx_routing_ecb_then_nbu_for_uah() -> None:
    mock_ecb()
    mock_nbu()
    clock = Clock(RECORDED)
    router = ProviderRouter(
        [EcbProvider(clock=clock), NbuProvider(clock=clock)],
        cache=TTLCache(),
        preferences=PREFERENCES,
        retry_delays=(),
    )
    service = MarketService(router)
    res = await service.quotes(["EURDKK", "EURUAH", "USDDKK"])
    by = {i.symbol: i for i in res.items}
    assert by["EURDKK"].meta is not None and by["EURDKK"].meta.source == "ECB"
    assert by["EURDKK"].meta.tag == "EOD"
    assert by["EURUAH"].meta is not None and by["EURUAH"].meta.source == "NBU"
    assert by["USDDKK"].meta is not None and "derived" in (by["USDDKK"].meta.note or "")
    await router.aclose()
