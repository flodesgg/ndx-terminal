"""Cache TTLs, the bar store and the per-provider storage rules (SPEC §6.3, PROVIDERS.md)."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import ClassVar

import pytest

from ndx_server import market as mkt
from ndx_server import research
from ndx_server.barstore import BarStore
from ndx_server.markets import next_session_close
from ndx_server.models import AssetClass, Bar, Instrument, Interval, Latency
from ndx_server.providers.base import BarSeries, Capability, DataProvider
from ndx_server.providers.coingecko import CoinGeckoProvider
from ndx_server.providers.fred import FredApiProvider
from ndx_server.providers.ratelimit import TokenBucket
from ndx_server.providers.router import ProviderRouter
from ndx_server.providers.storage import rule_for

DAY = 86400


def _bars(days: range, c: float = 1.0) -> list[Bar]:
    return [Bar(t=d * DAY, o=c, h=c, l=c, c=c, v=1) for d in days]


def _series(days: range, c: float = 1.0) -> BarSeries:
    return BarSeries(bars=_bars(days, c), tz="UTC", utc_offset_s=0)


# ---------- TTLs ----------


def test_ttls_follow_spec() -> None:
    assert all(2 <= t <= 15 for t in (*mkt.QUOTE_TTL.values(), mkt.DEFAULT_QUOTE_TTL))
    assert mkt.INTRADAY_BARS_TTL == 60
    assert research.FUNDAMENTALS_TTL == 12 * 3600
    assert research.FILINGS_TTL == research.INSIDERS_TTL == 24 * 3600
    assert mkt.PROFILE_TTL == mkt.SEARCH_TTL == 7 * DAY
    # CoinGecko: refreshed at least every 24 h
    assert mkt.CRYPTO_MARKETS_TTL <= DAY


def test_next_session_close_uses_the_exchange_calendar() -> None:
    # Friday 2026-11-06 15:00 New York -> the close that day (16:00 EST = 21:00 UTC)
    fri = datetime(2026, 11, 6, 20, 0, tzinfo=UTC)
    assert next_session_close("XNYS", fri) == datetime(2026, 11, 6, 21, 0, tzinfo=UTC)
    # after the close on Friday -> Monday's close
    assert next_session_close("XNYS", fri + timedelta(hours=2)) == datetime(
        2026, 11, 9, 21, 0, tzinfo=UTC
    )
    # Thanksgiving 2026-11-26 is a holiday; 27th is a half day (13:00 EST = 18:00 UTC)
    wed_late = datetime(2026, 11, 25, 22, 0, tzinfo=UTC)
    assert next_session_close("XNYS", wed_late) == datetime(2026, 11, 27, 18, 0, tzinfo=UTC)
    assert next_session_close("NOPE", fri) is None


# ---------- bar store ----------


def test_bar_store_updates_incrementally(tmp_path: Path) -> None:
    store = BarStore(tmp_path / "b.duckdb")
    t0 = datetime(2026, 11, 1, tzinfo=UTC)
    store.put("X", "1d", _series(range(1, 6)), "Src", Latency.EOD, t0)
    # second fetch only covers the tail: day 5 revised, days 6-7 new; days 1-4 stay as stored
    store.put("X", "1d", _series(range(5, 8), c=2.0), "Src", Latency.EOD, t0 + timedelta(days=1))
    got = store.get("X", "1d")
    assert got is not None
    assert [b.t // DAY for b in got.series.bars] == [1, 2, 3, 4, 5, 6, 7]
    assert [b.c for b in got.series.bars] == [1, 1, 1, 1, 2, 2, 2]
    assert got.fetched_at == t0 + timedelta(days=1)
    assert store.last_t("X", "1d") == 7 * DAY
    # a different source replaces the series (never mixes provenance)
    store.put("X", "1d", _series(range(10, 12), c=3.0), "Other", Latency.EOD, t0)
    got = store.get("X", "1d")
    assert got is not None and got.source == "Other" and len(got.series.bars) == 2


def test_bar_store_prunes_to_a_window(tmp_path: Path) -> None:
    store = BarStore(tmp_path / "b.duckdb")
    store.put("X", "1d", _series(range(0, 1000)), "Massive", Latency.EOD, datetime.now(UTC))
    store.prune_source("Massive", keep_days=730, now_t=1000 * DAY)
    got = store.get("X", "1d")
    assert got is not None and got.series.bars[0].t == 270 * DAY


def test_old_bar_table_without_key_is_replaced(tmp_path: Path) -> None:
    import duckdb

    path = tmp_path / "b.duckdb"
    con = duckdb.connect(str(path))
    con.execute("CREATE TABLE bars (symbol VARCHAR, interval VARCHAR, t BIGINT, o DOUBLE)")
    con.close()
    store = BarStore(path)
    store.put("X", "1d", _series(range(1, 3)), "Src", Latency.EOD, datetime.now(UTC))
    store.put("X", "1d", _series(range(2, 4)), "Src", Latency.EOD, datetime.now(UTC))
    got = store.get("X", "1d")
    assert got is not None and len(got.series.bars) == 3


# ---------- storage rules through MarketService ----------


class BarsProvider(DataProvider):
    name = "fake"
    label = "Fake Bars"
    capabilities: ClassVar[dict[Capability, frozenset[AssetClass]]] = {
        Capability.BARS: frozenset({AssetClass.EQUITY}),
    }

    def __init__(self, name: str = "fake", days: int = 10) -> None:
        super().__init__(TokenBucket(1000, 1000))
        self.name = name  # type: ignore[misc]
        self.label = name.title()  # type: ignore[misc]
        self.days = days
        self.lookbacks: list[int] = []

    def latency(self, asset: AssetClass) -> tuple[Latency, int | None]:
        return Latency.EOD, None

    async def bars(self, inst: Instrument, interval: Interval, lookback_days: int) -> BarSeries:
        self.lookbacks.append(lookback_days)
        today = int(datetime.now(UTC).timestamp()) // DAY
        first = max(today - self.days, today - lookback_days)
        return BarSeries(bars=_bars(range(first, today)), tz="UTC", utc_offset_s=0)


def _service(tmp_path: Path, p: DataProvider) -> mkt.MarketService:
    return mkt.MarketService(ProviderRouter([p]), BarStore(tmp_path / "b.duckdb"))


@pytest.mark.parametrize("name", ["fred", "tiingo", "coingecko"])
async def test_memory_only_and_coingecko_bars_never_reach_the_bar_store(
    tmp_path: Path, name: str
) -> None:
    svc = _service(tmp_path, BarsProvider(name))
    await svc.bars("AAPL", "1d", None)
    assert svc.barstore is not None and svc.barstore.get("AAPL", "1d") is None


def test_rules_table() -> None:
    assert rule_for(FredApiProvider("k")).memory_only
    assert not rule_for(FredApiProvider("k")).bar_store
    cg = rule_for(CoinGeckoProvider(""))
    assert not cg.bar_store and cg.max_age_s == DAY
    m = BarsProvider("massive")
    assert rule_for(m).history_days == 730
    t = BarsProvider("tiingo")
    assert rule_for(t).memory_only


async def test_massive_bars_are_pruned_to_two_years(tmp_path: Path) -> None:
    svc = _service(tmp_path, BarsProvider("massive", days=1200))
    res = await svc.bars("AAPL", "1d", None)
    today = int(datetime.now(UTC).timestamp()) // DAY
    assert svc.barstore is not None
    stored = svc.barstore.get("AAPL", "1d")
    assert stored is not None
    assert stored.series.bars[0].t >= (today - 730) * DAY
    assert res.data[0].t >= (today - 730) * DAY  # never served beyond the window either


async def test_daily_bars_refetch_only_the_missing_tail(tmp_path: Path) -> None:
    p = BarsProvider("fake", days=400)
    svc = _service(tmp_path, p)
    today = int(datetime.now(UTC).timestamp()) // DAY
    assert svc.barstore is not None
    # stored copy fetched 10 days ago (before at least one session close), 3 bars behind
    svc.barstore.put(
        "AAPL",
        "1d",
        BarSeries(bars=_bars(range(today - 400, today - 3)), tz="UTC", utc_offset_s=0),
        "Fake",
        Latency.EOD,
        datetime.now(UTC) - timedelta(days=10),
    )
    res = await svc.bars("AAPL", "1d", None)
    assert len(p.lookbacks) == 1 and p.lookbacks[0] <= 10  # incremental, not 5 years
    assert [b.t // DAY for b in res.data] == list(range(today - 400, today))
    assert res.meta.source == "Fake" and not res.meta.cached


async def test_daily_bars_served_from_store_until_the_next_close(tmp_path: Path) -> None:
    p = BarsProvider("fake", days=30)
    svc = _service(tmp_path, p)
    await svc.bars("AAPL US EQUITY", "1d", None)
    svc.router.cache.invalidate()
    res = await svc.bars("AAPL US EQUITY", "1d", None)
    assert len(p.lookbacks) == 1 and res.meta.cached
