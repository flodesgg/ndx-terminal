"""WEI to spec (Phase 2 step 3.2): index currency from the security master, % YTD base from
the daily series, and "no source" (not a failure) when nobody supports a request."""

from __future__ import annotations

from datetime import UTC, date, datetime
from typing import ClassVar

import pytest

from ndx_server.config import Settings
from ndx_server.market import MarketService
from ndx_server.models import AssetClass, Bar, Instrument, Interval
from ndx_server.providers.base import BarSeries, Capability, DataProvider, NotSupported
from ndx_server.providers.cache import TTLCache
from ndx_server.providers.ratelimit import TokenBucket
from ndx_server.providers.router import ProviderRouter, RouterError

from .conftest import make_client


def day(y: int, m: int, d: int) -> int:
    return int(datetime(y, m, d, tzinfo=UTC).timestamp())


class DailyOnly(DataProvider):
    """Daily index bars across a year end; intraday is not supported (like EODHD Free)."""

    name = "dailyonly"
    label = "Daily Only"
    capabilities: ClassVar[dict[Capability, frozenset[AssetClass]]] = {
        Capability.BARS: frozenset({AssetClass.INDEX, AssetClass.EQUITY}),
    }
    closes: ClassVar[dict[int, float]] = {}

    def __init__(self) -> None:
        super().__init__(TokenBucket(1000, 1000))

    async def bars(self, inst: Instrument, interval: Interval, lookback_days: int) -> BarSeries:
        if interval != "1d":
            raise NotSupported("daily only")
        bars = [Bar(t=t, o=c, h=c, l=c, c=c, v=None) for t, c in sorted(self.closes.items())]
        return BarSeries(bars=bars, tz="Europe/Copenhagen", utc_offset_s=3600, as_of=None)


def market(closes: dict[int, float]) -> MarketService:
    DailyOnly.closes = closes
    router = ProviderRouter([DailyOnly()], cache=TTLCache(), retry_delays=())
    return MarketService(router)


async def test_ytd_base_is_the_last_close_of_the_previous_year() -> None:
    year = datetime.now(UTC).year
    m = market({day(year - 1, 12, 29): 100.0, day(year - 1, 12, 30): 110.0, day(year, 1, 2): 120.0})
    got = await m.ytd_base("^OMXC25")
    assert got.close == 110.0 and got.day == date(year - 1, 12, 30)
    assert got.meta is not None and got.meta.source == "Daily Only" and got.error is None


async def test_ytd_base_is_na_without_a_close_in_the_previous_year() -> None:
    year = datetime.now(UTC).year
    m = market({day(year, 1, 2): 120.0, day(year, 1, 3): 121.0})
    got = await m.ytd_base("^OMXC25")
    assert got.close is None and got.day is None and got.error is None
    m = market({day(year - 2, 12, 30): 90.0, day(year, 1, 2): 120.0})  # a gap over a year
    assert (await m.ytd_base("^OMXC25")).close is None


async def test_ytd_without_a_source_reports_no_provider() -> None:
    m = MarketService(ProviderRouter([], cache=TTLCache(), retry_delays=()))
    got = (await m.ytd_bases(["^GSPC", "$$"])).items
    assert got[0].error is not None and got[0].error.startswith("[no_provider]")
    assert got[1].error is not None and got[1].error.startswith("[bad_request]")


async def test_nobody_supporting_a_request_is_no_source_not_a_failure() -> None:
    m = market({day(2026, 11, 6): 1.0})
    with pytest.raises(RouterError) as e:
        await m.bars("^OMXC25", "5m", 1)  # intraday: NotSupported by the only provider
    assert e.value.code == "no_provider"


def test_index_currency_and_batch_lookup(settings: Settings) -> None:
    with make_client(settings) as c:
        r = c.get("/secmaster/securities", params={"symbols": "^OMXC25,^GSPC,^VIX,$$"})
        items = {i["symbol"]: i for i in r.json()}
        assert items["^OMXC25"]["record"]["currency"] == "DKK"
        assert items["^OMXC25"]["record"]["id"] == "OMXC25 INDEX"
        assert items["^GSPC"]["record"]["currency"] == "USD"
        assert items["^VIX"]["record"]["currency"] is None  # volatility points
        assert items["$$"]["record"] is None and items["$$"]["error"]
        y = c.get("/ytd", params={"symbols": "^GSPC"}).json()
        assert y["items"][0]["error"].startswith("[no_provider]")
