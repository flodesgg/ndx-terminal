"""FRED macro series via the official API (key required).

Storage rule (SPEC §6.3, PROVIDERS P3): values are kept in memory only with a short TTL, never
written to disk and never served offline. FRED is not used for US yields (Treasury is).
`FredCsvProvider` (fredgraph.csv) is an undocumented endpoint and is not registered anywhere."""

from __future__ import annotations

import csv
import io
import re
from datetime import UTC, date, datetime, timedelta
from typing import Any, ClassVar

import httpx

from ..models import AssetClass, Latency, MacroPoint, MacroSeries
from .base import AuthError, Capability, DataProvider, NotFound, ProviderError
from .budgets import BUDGETS
from .calendars import CalEntry
from .http import check, get_json, make_client

API = "https://api.stlouisfed.org/fred"
PAGE = 1000
CSV_URL = "https://fred.stlouisfed.org/graph/fredgraph.csv"

# Curated dashboard series: id -> (title, units, frequency)
CATALOG: dict[str, tuple[str, str, str]] = {
    "CPIAUCSL": ("CPI, all items", "Index 1982-84=100", "Monthly"),
    "CPILFESL": ("Core CPI (ex food & energy)", "Index 1982-84=100", "Monthly"),
    "PCEPILFE": ("Core PCE price index", "Index 2017=100", "Monthly"),
    "UNRATE": ("Unemployment rate", "%", "Monthly"),
    "PAYEMS": ("Nonfarm payrolls", "Thousands of persons", "Monthly"),
    "FEDFUNDS": ("Effective fed funds rate", "%", "Monthly"),
    "GDPC1": ("Real GDP", "Billions of chained 2017 $", "Quarterly"),
    "A191RL1Q225SBEA": ("Real GDP growth (annualized q/q)", "%", "Quarterly"),
    "RSAFS": ("Retail sales", "Millions of $", "Monthly"),
    "INDPRO": ("Industrial production", "Index 2017=100", "Monthly"),
    "UMCSENT": ("UMich consumer sentiment", "Index 1966:Q1=100", "Monthly"),
    "ICSA": ("Initial jobless claims", "Persons", "Weekly"),
    "MORTGAGE30US": ("30-year mortgage rate", "%", "Weekly"),
}


def parse_csv(series_id: str, text: str) -> MacroSeries:
    rows = list(csv.reader(io.StringIO(text)))
    if len(rows) < 2 or len(rows[0]) < 2:
        raise NotFound(f"FRED has no data for {series_id}")
    points = []
    for r in rows[1:]:
        if len(r) < 2 or r[1] in ("", "."):
            continue  # "." marks missing observations in FRED
        try:
            points.append(MacroPoint(date=r[0], value=float(r[1])))
        except ValueError:
            continue
    if not points:
        raise NotFound(f"FRED has no observations for {series_id}")
    title, units, freq = CATALOG.get(series_id, (series_id, "", ""))
    return MacroSeries(
        id=series_id, title=title, units=units or None, frequency=freq or None, data=points
    )


def parse_last_updated(raw: Any) -> datetime | None:
    """FRED's `last_updated`, e.g. "2026-11-10 07:41:06-06" (Central time with its offset)."""
    if not isinstance(raw, str):
        return None
    s = raw.strip()
    if re.search(r"[+-]\d{2}$", s):
        s += ":00"
    try:
        dt = datetime.fromisoformat(s)
    except ValueError:
        return None
    return dt.astimezone(UTC) if dt.tzinfo else None


def parse_release_dates(obj: Any) -> list[CalEntry]:
    """`fred/releases/dates` -> one entry per (release, date); dates only, no times."""
    out: list[CalEntry] = []
    for r in (obj or {}).get("release_dates") or []:
        try:
            day = date.fromisoformat(r["date"])
            rid = str(int(r["release_id"]))
        except (KeyError, TypeError, ValueError):
            continue
        out.append(CalEntry("fred", rid, str(r.get("release_name") or rid), day))
    return out


def parse_api(series_id: str, info: dict[str, Any], obs: dict[str, Any]) -> MacroSeries:
    meta = (info.get("seriess") or [{}])[0]
    points = [
        MacroPoint(date=o["date"], value=float(o["value"]))
        for o in obs.get("observations") or []
        if o.get("value") not in (None, "", ".")
    ]
    if not points:
        raise NotFound(f"FRED has no observations for {series_id}")
    return MacroSeries(
        id=series_id,
        title=meta.get("title") or series_id,
        units=meta.get("units_short") or meta.get("units"),
        frequency=meta.get("frequency_short") or meta.get("frequency"),
        data=points,
        updated=parse_last_updated(meta.get("last_updated")),
    )


NOT_ENDORSED = (
    "This product uses the FRED® API but is not endorsed or certified by the Federal Reserve "
    "Bank of St. Louis."
)


class _FredBase(DataProvider):
    storage = "memory"
    capabilities: ClassVar[dict[Capability, frozenset[AssetClass]]] = {
        Capability.MACRO: frozenset({AssetClass.INDEX}),
    }

    def latency(self, asset: AssetClass) -> tuple[Latency, int | None]:
        return Latency.EOD, None

    def result_meta(self, asset: AssetClass, value: Any) -> tuple[Latency, int | None, str | None]:
        freq = value.frequency if isinstance(value, MacroSeries) else None
        rel = f"official releases ({freq.lower()}); " if freq else ""
        return Latency.EOD, None, rel + NOT_ENDORSED


class FredApiProvider(_FredBase):
    name = "fred"
    label = "FRED API"
    requires_key = True
    capabilities: ClassVar[dict[Capability, frozenset[AssetClass]]] = {
        Capability.MACRO: frozenset({AssetClass.INDEX}),
        Capability.ECON: frozenset({AssetClass.INDEX}),  # release dates + ECO series
    }

    def __init__(self, api_key: str, client: httpx.AsyncClient | None = None) -> None:
        super().__init__(BUDGETS["fred"].bucket(), api_key=api_key)
        self.client = client or make_client()

    async def aclose(self) -> None:
        await self.client.aclose()

    async def series(self, series_id: str) -> MacroSeries:
        params = {"series_id": series_id, "api_key": self.api_key, "file_type": "json"}
        try:
            info = await get_json(self.client, f"{API}/series", "FRED", params)
            obs = await get_json(self.client, f"{API}/series/observations", "FRED", params)
        except ProviderError as exc:
            if " 400" in str(exc) and "api_key" in str(exc):
                # FRED answers a malformed or unknown key with 400, not 401/403
                raise AuthError("FRED rejected the API key (HTTP 400)") from exc
            if " 400" in str(exc):
                raise NotFound(f"FRED has no series {series_id}") from exc
            raise
        return parse_api(series_id, info, obs)

    async def econ_calendar(self) -> list[CalEntry]:
        """Release dates from 7 days back to 40 ahead (future dates need
        `include_release_dates_with_no_data`). Paged: a month is ~900 dates (many are
        data-feed updates the mapping file ignores); at most 4 pages."""
        today = datetime.now(UTC).date()
        params: dict[str, str] = {
            "api_key": self.api_key,
            "file_type": "json",
            "realtime_start": (today - timedelta(days=7)).isoformat(),
            "realtime_end": (today + timedelta(days=40)).isoformat(),
            "include_release_dates_with_no_data": "true",
            "limit": str(PAGE),
            "sort_order": "asc",
        }
        out: list[CalEntry] = []
        for page in range(4):
            params["offset"] = str(page * PAGE)
            obj = await get_json(self.client, f"{API}/releases/dates", "FRED", params)
            out.extend(parse_release_dates(obj))
            if (page + 1) * PAGE >= int((obj or {}).get("count") or 0):
                return out
        raise ProviderError("FRED: more than 4 pages of release dates")

    async def econ_series(self, spec: str) -> MacroSeries:
        return await self.series(spec)


class FredCsvProvider(_FredBase):
    name = "fredcsv"
    label = "FRED (public CSV)"

    def __init__(self, client: httpx.AsyncClient | None = None) -> None:
        super().__init__(BUDGETS["fredcsv"].bucket())
        self.client = client or make_client(timeout=25)

    async def aclose(self) -> None:
        await self.client.aclose()

    async def series(self, series_id: str) -> MacroSeries:
        resp = await self.client.get(CSV_URL, params={"id": series_id})
        check(resp, "FRED")
        if "html" in resp.headers.get("content-type", ""):
            raise NotFound(f"FRED has no series {series_id}")
        return parse_csv(series_id, resp.text)
