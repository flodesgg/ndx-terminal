"""U.S. Treasury daily par yield curve (keyless CSV from home.treasury.gov)."""

from __future__ import annotations

import asyncio
import csv
import io
import re
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta
from typing import Any, ClassVar
from zoneinfo import ZoneInfo

import httpx

from ..models import AssetClass, Latency, MacroPoint, MacroSeries, YieldCurve
from .base import Capability, DataProvider, NotFound
from .budgets import BUDGETS
from .http import check, make_client

URL = (
    "https://home.treasury.gov/resource-center/data-chart-center/interest-rates/"
    "daily-treasury-rates.csv/{year}/all"
)


ET = ZoneInfo("America/New_York")
# Treasury yield curve methodology (checked 2026-11-09): inputs are "indicative, bid-side market
# price quotations ... obtained by the Federal Reserve Bank of New York at or near 3:30 PM each
# trading day"; the curve is "usually available ... by 6:00 PM Eastern Time".
QUOTE_TIME = time(15, 30)
NOTE = "Daily par yield curve: FRBNY indicative bid quotes at ~3:30 PM ET, published by ~6 PM ET"


def curve_as_of(d: date) -> datetime:
    """The moment a curve date's values describe: that day's ~3:30 PM ET quotations."""
    return datetime.combine(d, QUOTE_TIME, ET)


def et_today() -> date:
    """The curve's calendar is New York's, not the machine's."""
    return datetime.now(ET).date()


def parse_csv(text: str) -> tuple[list[str], dict[date, list[float | None]]]:
    rows = list(csv.reader(io.StringIO(text)))
    if not rows or rows[0][0] != "Date":
        raise NotFound("unexpected Treasury CSV format")
    tenors = [t.replace("Month", "Mo").replace(" ", "") for t in rows[0][1:]]
    data: dict[date, list[float | None]] = {}
    for r in rows[1:]:
        if not r or not r[0]:
            continue
        d = datetime.strptime(r[0], "%m/%d/%Y").date()
        data[d] = [float(x) if x not in ("", "N/A") else None for x in r[1:]]
    return tenors, data


def merge_tables(
    tables: list[tuple[list[str], dict[date, list[float | None]]]],
) -> tuple[list[str], dict[date, list[float | None]]]:
    """Align columns across years (tenors were added over time, e.g. 1.5 Mo)."""
    tenors: list[str] = []
    for t, _ in tables:
        for name in t:
            if name not in tenors:
                tenors.append(name)
    order = {"Mo": 0, "Yr": 1}
    tenors.sort(key=lambda x: (order.get(x[-2:], 2), float(x[:-2])))
    out: dict[date, list[float | None]] = {}
    for t, data in tables:
        idx = {name: i for i, name in enumerate(t)}
        for d, vals in data.items():
            out[d] = [vals[idx[n]] if n in idx else None for n in tenors]
    return tenors, out


@dataclass
class CurveSet:
    tenors: list[str]
    current: YieldCurve
    month_ago: YieldCurve | None
    year_ago: YieldCurve | None


def curve_on_or_before(data: dict[date, list[float | None]], target: date) -> YieldCurve | None:
    candidates = [d for d in data if d <= target]
    if not candidates:
        return None
    d = max(candidates)
    return YieldCurve(date=d.isoformat(), yields=data[d])


# Macro-style series ids served from the par curve: US{n}M / US{n}Y and the 2s10s spread.
SPREADS = {"US2S10S": ("10Yr", "2Yr", "US 10Y minus 2Y (Treasury par curve)")}
_TENOR_ID = re.compile(r"^US(\d+(?:\.\d+)?)([MY])$")


def tenor_column(series_id: str) -> str | None:
    m = _TENOR_ID.match(series_id)
    if not m:
        return None
    n, unit = m.groups()
    return f"{n}{'Mo' if unit == 'M' else 'Yr'}"


def is_treasury_series(series_id: str) -> bool:
    return series_id in SPREADS or tenor_column(series_id) is not None


def build_series(
    series_id: str, tenors: list[str], data: dict[date, list[float | None]]
) -> MacroSeries:
    idx = {t: i for i, t in enumerate(tenors)}
    points: list[MacroPoint] = []
    if series_id in SPREADS:
        hi, lo, title = SPREADS[series_id]
        if hi not in idx or lo not in idx:
            raise NotFound(f"Treasury curve has no {hi}/{lo} columns")
        for d in sorted(data):
            a, b = data[d][idx[hi]], data[d][idx[lo]]
            if a is not None and b is not None:
                points.append(MacroPoint(date=d.isoformat(), value=round(a - b, 4)))
    else:
        col = tenor_column(series_id)
        if col is None or col not in idx:
            raise NotFound(f"Treasury par curve has no tenor for {series_id}")
        title = f"US Treasury {col.replace('Mo', ' Mo').replace('Yr', ' Yr')} par yield"
        for d in sorted(data):
            v = data[d][idx[col]]
            if v is not None:
                points.append(MacroPoint(date=d.isoformat(), value=v))
    if not points:
        raise NotFound(f"no Treasury observations for {series_id}")
    return MacroSeries(id=series_id, title=title, units="%", frequency="Daily", data=points)


class TreasuryProvider(DataProvider):
    name = "treasury"
    label = "U.S. Treasury"
    capabilities: ClassVar[dict[Capability, frozenset[AssetClass]]] = {
        Capability.YIELDS: frozenset({AssetClass.INDEX}),
    }

    def __init__(self, client: httpx.AsyncClient | None = None) -> None:
        super().__init__(BUDGETS["treasury"].bucket())
        self.client = client or make_client(timeout=25)

    def latency(self, asset: AssetClass) -> tuple[Latency, int | None]:
        return Latency.EOD, None

    def result_meta(self, asset: AssetClass, value: Any) -> tuple[Latency, int | None, str | None]:
        return Latency.EOD, None, NOTE

    async def aclose(self) -> None:
        await self.client.aclose()

    async def _year(self, year: int) -> tuple[list[str], dict[date, list[float | None]]]:
        resp = await self.client.get(
            URL.format(year=year),
            params={
                "type": "daily_treasury_yield_curve",
                "field_tdr_date_value": str(year),
                "page": "",
                "_format": "csv",
            },
        )
        check(resp, "Treasury")
        return parse_csv(resp.text)

    async def series(self, series_id: str, years: int = 2) -> MacroSeries:
        """Daily history of one tenor (or spread) from the official par curve CSVs."""
        this = et_today().year
        tables = await asyncio.gather(*(self._year(y) for y in range(this - years + 1, this + 1)))
        tenors, data = merge_tables(list(tables))
        return build_series(series_id, tenors, data)

    async def yield_curve(self) -> CurveSet:
        today = et_today()
        years = sorted({today.year, (today - timedelta(days=400)).year})
        tables = await asyncio.gather(*(self._year(y) for y in years))
        tenors, data = merge_tables(list(tables))
        if not data:
            raise NotFound("no Treasury yield data")
        latest = max(data)
        return CurveSet(
            tenors=tenors,
            current=YieldCurve(date=latest.isoformat(), yields=data[latest]),
            month_ago=curve_on_or_before(data, latest - timedelta(days=30)),
            year_ago=curve_on_or_before(data, latest - timedelta(days=365)),
        )
