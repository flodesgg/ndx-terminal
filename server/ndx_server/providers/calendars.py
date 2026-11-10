"""Official economic release calendars and the series behind their numbers (SPEC §8 `ECO`).

Sources, each checked live on 2026-11-10 (docs/PROVIDERS.md §3.7, §3.9, §3.11, §3.12):

- BEA `release_dates.json` — release times in UTC.
- Eurostat "Euro indicators" ICS (`/eurostat/o/calendars/eventsIcal?theme=0&category=2`, the
  URL the subscribe page builds) — dates only; Eurostat publishes euro indicators at 11:00 CET.
- ECB statistical calendar and Governing Council meetings pages — HTML, Frankfurt time.
- Statistics Denmark planned releases (`/en/Statistik/planlagte?days=b&prod=1`, news only) —
  HTML table, Danish time.
- Federal Reserve FOMC meetings page — HTML, dates only (statement 2:00 p.m. ET).
- FRED release dates (key; in `fred.py`) — dates only; used for BLS, Census and Fed releases
  because BLS refuses automated access that does not carry the user's contact details.

Series for actual/prior: Eurostat dissemination API (JSON-stat 2.0), StatBank API (CSV), ECB
SDMX (CSV), FRED (`fred.py`). No source publishes consensus, so `survey` is always N.A.
"""

from __future__ import annotations

import csv
import html
import io
import re
from dataclasses import dataclass
from datetime import UTC, date, datetime, time, timedelta
from typing import Any, ClassVar
from urllib.parse import parse_qsl
from zoneinfo import ZoneInfo

import httpx

from ..models import AssetClass, Latency, MacroPoint, MacroSeries
from .base import Capability, DataProvider, NotFound, ProviderError
from .budgets import BUDGETS
from .http import check, get_json, get_text, make_client

CPH = ZoneInfo("Europe/Copenhagen")
FRANKFURT = ZoneInfo("Europe/Berlin")

BEA_URL = "https://apps.bea.gov/API/signup/release_dates.json"
EUROSTAT_ICS = "https://ec.europa.eu/eurostat/o/calendars/eventsIcal"
EUROSTAT_API = "https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/"
ECB_STATSCAL = "https://www.ecb.europa.eu/press/calendars/statscal/html/index.en.html"
ECB_MEETINGS = "https://www.ecb.europa.eu/press/calendars/mgcgc/html/index.en.html"
ECB_SDMX = "https://data-api.ecb.europa.eu/service/data/"
DST_RELEASES = "https://www.dst.dk/en/Statistik/planlagte"
DST_API = "https://api.statbank.dk/v1/"
FOMC_URL = "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm"


# History fetched per series: enough for ECO's actual/prior and ECST's 10-year chart.
HISTORY_PERIODS = 130  # monthly: ~10.8 years; quarterly: all of DST/Eurostat's recent history
HISTORY_YEARS = 10  # daily series (ECB policy rates)


@dataclass(frozen=True, slots=True)
class CalEntry:
    """One release as a calendar lists it, before data/symbology/eco_events.csv maps it."""

    source: str  # fred | bea | fed | eurostat | ecb_mp | ecb_stat | dst
    key: str  # what the mapping file matches: a FRED release id, else the title
    title: str
    day: date  # release date in the issuer's zone
    when: datetime | None = None  # UTC, when the calendar states the time
    period: str | None = None
    tentative: bool = False


# ---------------------------------------------------------------------------- periods

_MONTHS = {
    m: i + 1
    for names in (
        "january february march april may june july august september october november december",
        "januar februar marts april maj juni juli august september oktober november december",
        "jan feb mar apr may jun jul aug sep oct nov dec",
    )
    for i, m in enumerate(names.split())
}
_ORD_Q = re.compile(r"^(\d)(?:st|nd|rd|th)?\s+quarter\s+(\d{4})$", re.I)


def norm_period(raw: str | None) -> str | None:
    """Calendar periods -> `YYYY-MM`, `YYYY-Qn` or `YYYY`; anything else is kept as written
    (ECB "Sep-2026 / Q3 2026" ranges, weeks)."""
    if not raw:
        return None
    s = " ".join(raw.replace("\u00a0", " ").split())
    m = re.fullmatch(r"([A-Za-zæøå]+)[- ](\d{4})", s)
    if m and m.group(1).lower() in _MONTHS:
        return f"{m.group(2)}-{_MONTHS[m.group(1).lower()]:02d}"
    m = re.fullmatch(r"Q([1-4]) (\d{4})", s)
    if m:
        return f"{m.group(2)}-Q{m.group(1)}"
    m = _ORD_Q.fullmatch(s)
    if m:
        return f"{m.group(2)}-Q{m.group(1)}"
    if re.fullmatch(r"\d{4}", s):
        return s
    return s


def norm_obs_date(raw: str) -> str:
    """Series period labels -> `YYYY-MM`, `YYYY-Qn`, `YYYY-MM-DD` (DST `2026M10`, `2026K2`)."""
    s = raw.strip()
    m = re.fullmatch(r"(\d{4})M(\d{2})", s)
    if m:
        return f"{m.group(1)}-{m.group(2)}"
    m = re.fullmatch(r"(\d{4})[KQ]([1-4])", s)
    if m:
        return f"{m.group(1)}-Q{m.group(2)}"
    m = re.fullmatch(r"(\d{4})-Q([1-4])", s)
    if m:
        return s
    return s


def infer_frequency(dates: list[str]) -> str | None:
    """`D`/`M`/`Q`/`A` from normalised observation labels (Eurostat, DST, ECB do not say)."""
    if not dates:
        return None
    d = dates[-1]
    if re.fullmatch(r"\d{4}-Q[1-4]", d):
        return "Q"
    if re.fullmatch(r"\d{4}-\d{2}", d):
        return "M"
    if re.fullmatch(r"\d{4}", d):
        return "A"
    if re.fullmatch(r"\d{4}-W\d{2}", d):
        return "W"
    return "D"


# ---------------------------------------------------------------------------- calendars


def parse_bea(obj: Any) -> list[CalEntry]:
    """`{"<release name>": {"release_dates": ["2026-11-25T13:30:00+00:00", ...]}, ...}`."""
    out: list[CalEntry] = []
    if not isinstance(obj, dict):
        raise ProviderError("BEA: unexpected release_dates.json shape")
    for title, body in obj.items():
        if not isinstance(body, dict):
            continue  # a few top-level keys are metadata strings
        seen: set[datetime] = set()
        for raw in body.get("release_dates") or []:
            try:
                when = datetime.fromisoformat(str(raw)).astimezone(UTC)
            except ValueError:
                continue
            if when in seen:  # the file repeats some dates
                continue
            seen.add(when)
            day = when.astimezone(ZoneInfo("America/New_York")).date()
            out.append(CalEntry("bea", title, title, day, when))
    return out


def _ics_unescape(v: str) -> str:
    return (
        v.replace("\\n", " ").replace("\\N", " ").replace("\\,", ",").replace("\\;", ";")
    ).replace("\\\\", "\\")


def parse_ics(text: str, source: str) -> list[CalEntry]:
    """VEVENTs of an iCalendar file. Eurostat's are all-day (`DTSTART;VALUE=DATE`)."""
    unfolded = re.sub(r"\r?\n[ \t]", "", text)
    out: list[CalEntry] = []
    for block in unfolded.split("BEGIN:VEVENT")[1:]:
        block = block.split("END:VEVENT")[0]
        start = re.search(r"^DTSTART([^:\n]*):(\S+)", block, re.M)
        summary = re.search(r"^SUMMARY[^:\n]*:(.*)$", block, re.M)
        if not start or not summary:
            continue
        title = " ".join(_ics_unescape(summary.group(1)).replace("\u00a0", " ").split())
        value = start.group(2)
        when: datetime | None = None
        try:
            if "T" in value:
                if value.endswith("Z"):
                    when = datetime.strptime(value, "%Y%m%dT%H%M%SZ").replace(tzinfo=UTC)
                else:
                    tz = re.search(r"TZID=([^;:]+)", start.group(1))
                    zone = ZoneInfo(tz.group(1)) if tz else UTC
                    when = datetime.strptime(value, "%Y%m%dT%H%M%S").replace(tzinfo=zone)
                    when = when.astimezone(UTC)
                day = when.date()
            else:
                day = datetime.strptime(value[:8], "%Y%m%d").date()
        except (ValueError, KeyError):
            continue
        out.append(CalEntry(source, title, title, day, when))
    return out


_DT_DD = re.compile(r"<dt>(.*?)</dt>\s*<dd>(.*?)</dd>", re.S)


def _text_lines(fragment: str) -> list[str]:
    parts = re.split(r"<br\s*/?>", fragment)
    lines = [" ".join(html.unescape(re.sub(r"<[^>]+>", " ", p)).split()) for p in parts]
    return [x for x in lines if x]


def parse_ecb_statscal(page: str) -> list[CalEntry]:
    """`<dt>04/11/2026 10:00 [<br>Tentative]</dt><dd>Title (Dataset: X)<br>Reference period:
    Oct-2026<br>...</dd>`; "All times are local to Frankfurt am Main"."""
    out: list[CalEntry] = []
    for dt, dd in _DT_DD.findall(page):
        head = _text_lines(dt)
        m = re.match(r"(\d{2})/(\d{2})/(\d{4})\s+(\d{2}):(\d{2})", head[0] if head else "")
        lines = _text_lines(dd)
        if not m or not lines:
            continue
        d, mo, y, hh, mm = (int(x) for x in m.groups())
        local = datetime(y, mo, d, hh, mm, tzinfo=FRANKFURT)
        title = re.sub(r"\s*\(Dataset:[^)]*\)\s*$", "", lines[0]).strip()
        period = next(
            (x.split(":", 1)[1].strip() for x in lines if x.startswith("Reference period:")),
            None,
        )
        tentative = any("tentative" in x.lower() for x in head[1:])
        out.append(
            CalEntry(
                "ecb_stat",
                title,
                title,
                local.date(),
                local.astimezone(UTC),
                norm_period(period),
                tentative,
            )
        )
    return out


def parse_ecb_meetings(page: str) -> list[CalEntry]:
    """Governing Council meetings: dates only. Only monetary policy meetings are kept (the
    decision day is "Day 2 ... followed by press conference"; Day 1 adds nothing to show)."""
    out: list[CalEntry] = []
    for dt, dd in _DT_DD.findall(page):
        head = _text_lines(dt)
        m = re.match(r"(\d{2})/(\d{2})/(\d{4})", head[0] if head else "")
        lines = _text_lines(dd)
        if not m or not lines:
            continue
        title = lines[0]
        low = title.lower()
        if "monetary policy meeting" not in low or "non-monetary" in low or "day 1" in low:
            continue
        d, mo, y = (int(x) for x in m.groups())
        out.append(CalEntry("ecb_mp", title, title, date(y, mo, d)))
    return out


def parse_dst(page: str) -> list[CalEntry]:
    """Planned releases table: Date | Time | Type | Title | Subsubject | Period | Confirmed."""
    out: list[CalEntry] = []
    for row in re.findall(r"<tr>\s*(.*?)</tr>", page, re.S):
        cells = [
            " ".join(html.unescape(re.sub(r"<[^>]+>", " ", c)).split())
            for c in re.findall(r"<td[^>]*>(.*?)</td>", row, re.S)
        ]
        if len(cells) < 7 or cells[2] != "News":
            continue
        day_s = cells[0].replace("\u2011", "-")
        m = re.fullmatch(r"(\d{2})-(\d{2})-(\d{4})", day_s)
        t = re.fullmatch(r"(\d{2}):(\d{2})", cells[1])
        if not m or not t:
            continue
        d, mo, y = (int(x) for x in m.groups())
        local = datetime(y, mo, d, int(t.group(1)), int(t.group(2)), tzinfo=CPH)
        out.append(
            CalEntry(
                "dst",
                cells[3],
                cells[3],
                local.date(),
                local.astimezone(UTC),
                norm_period(cells[5]),
                tentative=cells[6].lower() != "yes",
            )
        )
    return out


def parse_fomc(page: str) -> list[CalEntry]:
    """Panels "YYYY FOMC Meetings" with rows month ("April/May" spans two) and days ("27-28",
    "17-18*" with projections). The decision (statement) is on the last day."""
    out: list[CalEntry] = []
    panels = re.split(r">(\d{4}) FOMC Meetings<", page)
    for i in range(1, len(panels) - 1, 2):
        year = int(panels[i])
        body = panels[i + 1]
        for month, days in re.findall(
            r"fomc-meeting__month[^>]*>\s*<strong>([^<]+)</strong>.*?"
            r"fomc-meeting__date[^>]*>([^<]+)<",
            body,
            re.S,
        ):
            last_month = month.split("/")[-1].strip().lower()
            nums = re.findall(r"\d+", days)
            if last_month not in _MONTHS or not nums or "notation" in days.lower():
                continue
            if "unscheduled" in days.lower():
                continue
            try:
                d = date(year, _MONTHS[last_month], int(nums[-1]))
            except ValueError:
                continue
            out.append(CalEntry("fed", "FOMC", "FOMC meeting", d))
    return out


# ---------------------------------------------------------------------------- series


def split_spec(spec: str) -> tuple[str, dict[str, str]]:
    """`dataset?k=v&k2=v2` -> ("dataset", {...})."""
    head, _, query = spec.partition("?")
    return head, dict(parse_qsl(query, keep_blank_values=False))


def parse_eurostat(obj: Any, spec: str) -> MacroSeries:
    """JSON-stat 2.0 with every non-time dimension filtered to one value."""
    try:
        dims: list[str] = obj["id"]
        sizes: list[int] = obj["size"]
        times: dict[str, int] = obj["dimension"]["time"]["category"]["index"]
        values: dict[str, float | None] = obj.get("value") or {}
    except (KeyError, TypeError) as exc:
        raise ProviderError("Eurostat: unexpected JSON-stat shape") from exc
    for d, n in zip(dims, sizes, strict=False):
        if d != "time" and n != 1:
            raise ProviderError(f"Eurostat {spec}: filter leaves {n} values of {d}")
    pts = [
        MacroPoint(date=norm_obs_date(t), value=float(v))
        for t, i in sorted(times.items(), key=lambda kv: kv[1])
        if (v := values.get(str(i))) is not None
    ]
    if not pts:
        raise NotFound(f"Eurostat has no observations for {spec}")
    updated = None
    if obj.get("updated"):
        try:
            updated = datetime.fromisoformat(obj["updated"]).astimezone(UTC)
        except ValueError:
            updated = None
    return MacroSeries(
        id=spec,
        title=str(obj.get("label") or spec),
        frequency=infer_frequency([p.date for p in pts]),
        data=pts,
        updated=updated,
    )


def parse_dst_csv(text: str, spec: str, updated: datetime | None) -> MacroSeries:
    """StatBank `format=CSV`, `;`-separated, the last two columns TID;INDHOLD (`..` = none)."""
    rows = list(csv.reader(io.StringIO(text.lstrip("\ufeff")), delimiter=";"))
    pts: list[MacroPoint] = []
    for r in rows[1:]:
        if len(r) < 2 or r[-1] in ("", ".."):
            continue
        try:
            pts.append(MacroPoint(date=norm_obs_date(r[-2]), value=float(r[-1])))
        except ValueError:
            continue
    if not pts:
        raise NotFound(f"Statistics Denmark has no observations for {spec}")
    return MacroSeries(
        id=spec,
        title=spec,
        frequency=infer_frequency([p.date for p in pts]),
        data=pts,
        updated=updated,
    )


def parse_ecb_csv(text: str, spec: str) -> MacroSeries:
    pts: list[MacroPoint] = []
    for r in csv.DictReader(io.StringIO(text)):
        try:
            pts.append(MacroPoint(date=r["TIME_PERIOD"], value=float(r["OBS_VALUE"])))
        except (KeyError, TypeError, ValueError):
            continue
    if not pts:
        raise NotFound(f"ECB has no observations for {spec}")
    return MacroSeries(
        id=spec, title=spec, frequency=infer_frequency([p.date for p in pts]), data=pts
    )


# ---------------------------------------------------------------------------- providers


class CalendarProvider(DataProvider):
    """A keyless official calendar (and, for some, the series behind its numbers)."""

    capabilities: ClassVar[dict[Capability, frozenset[AssetClass]]] = {
        Capability.ECON: frozenset({AssetClass.INDEX}),
    }
    budget: ClassVar[str]
    timeout: ClassVar[float] = 25.0

    def __init__(self, client: httpx.AsyncClient | None = None) -> None:
        super().__init__(BUDGETS[self.budget].bucket())
        self.client = client or make_client(timeout=self.timeout)

    async def aclose(self) -> None:
        await self.client.aclose()

    def latency(self, asset: AssetClass) -> tuple[Latency, int | None]:
        return Latency.STATIC, None

    async def econ_calendar(self) -> list[CalEntry]:
        raise NotImplementedError

    async def econ_series(self, spec: str) -> MacroSeries:
        raise NotFound(f"{self.label} serves no series")


class BeaProvider(CalendarProvider):
    name = "bea"
    label = "BEA"
    budget = "bea"

    async def econ_calendar(self) -> list[CalEntry]:
        return parse_bea(await get_json(self.client, BEA_URL, "BEA"))


class EurostatProvider(CalendarProvider):
    name = "eurostat"
    label = "Eurostat"
    budget = "eurostat"
    timeout = 30.0

    async def econ_calendar(self) -> list[CalEntry]:
        text = await get_text(
            self.client, EUROSTAT_ICS, "Eurostat", {"theme": "0", "category": "2"}
        )
        if "BEGIN:VCALENDAR" not in text:
            raise ProviderError("Eurostat: the calendar answer is not iCalendar")
        return parse_ics(text, "eurostat")

    async def econ_series(self, spec: str) -> MacroSeries:
        dataset, filters = split_spec(spec)
        obj = await get_json(
            self.client,
            EUROSTAT_API + dataset,
            "Eurostat",
            {**filters, "lastTimePeriod": str(HISTORY_PERIODS)},
        )
        return parse_eurostat(obj, spec)


class EcbStatProvider(CalendarProvider):
    name = "ecbstat"
    label = "ECB"
    budget = "ecbstat"

    async def econ_calendar(self) -> list[CalEntry]:
        stats = await get_text(self.client, ECB_STATSCAL, "ECB")
        meetings = await get_text(self.client, ECB_MEETINGS, "ECB")
        out = parse_ecb_statscal(stats) + parse_ecb_meetings(meetings)
        if not out:
            raise ProviderError("ECB: no calendar entries found (page layout changed?)")
        return out

    async def econ_series(self, spec: str) -> MacroSeries:
        text = await get_text(
            self.client,
            ECB_SDMX + spec,
            "ECB",
            {
                "startPeriod": (date.today() - timedelta(days=HISTORY_YEARS * 366)).isoformat(),
                "format": "csvdata",
                "detail": "dataonly",
            },
        )
        return parse_ecb_csv(text, spec)


class DstProvider(CalendarProvider):
    name = "dst"
    label = "Statistics Denmark"
    budget = "dst"

    async def econ_calendar(self) -> list[CalEntry]:
        page = await get_text(
            self.client, DST_RELEASES, "Statistics Denmark", {"days": "b", "prod": "1"}
        )
        out = parse_dst(page)
        if not out and "SchLeft" not in page:
            raise ProviderError("Statistics Denmark: release table not found")
        return out

    async def econ_series(self, spec: str) -> MacroSeries:
        table, filters = split_spec(spec)
        info = await get_json(
            self.client, f"{DST_API}tableinfo/{table}", "Statistics Denmark", {"format": "JSON"}
        )
        updated = None
        if isinstance(info, dict) and info.get("updated"):
            try:
                updated = (
                    datetime.fromisoformat(str(info["updated"])).replace(tzinfo=CPH)
                ).astimezone(UTC)
            except ValueError:
                updated = None
        body = {
            "table": table,
            "format": "CSV",
            "lang": "en",
            "variables": [{"code": k, "values": [v]} for k, v in filters.items()]
            + [{"code": "Tid", "values": [f"(-n+{HISTORY_PERIODS})"]}],
        }
        try:
            resp = await self.client.post(f"{DST_API}data", json=body)
        except httpx.HTTPError as exc:
            raise ProviderError(f"Statistics Denmark: {type(exc).__name__}") from exc
        check(resp, "Statistics Denmark")
        return parse_dst_csv(resp.text, spec, updated)


class FedProvider(CalendarProvider):
    name = "fed"
    label = "Federal Reserve"
    budget = "fed"

    async def econ_calendar(self) -> list[CalEntry]:
        out = parse_fomc(await get_text(self.client, FOMC_URL, "Federal Reserve"))
        if not out:
            raise ProviderError("Federal Reserve: no FOMC meetings found (page layout changed?)")
        return out


def time_at(day: date, hhmm: str, tz: str) -> datetime:
    """The issuer's standard release time on `day`, in UTC."""
    h, m = (int(x) for x in hhmm.split(":"))
    return datetime.combine(day, time(h, m), ZoneInfo(tz)).astimezone(UTC)
