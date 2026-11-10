"""ECO — economic calendar from official calendars (SPEC §8, docs/PROVIDERS.md P7).

Each calendar source (`Capability.ECON`) lists releases; data/symbology/eco_events.csv maps a
release to the lines shown (event name, importance, the series behind actual/prior). Rules:

- Times: the calendar's own time when it states one; otherwise the issuer's standard release
  time from the mapping file (`time_kind="standard"`, marked in the UI).
- Actual/prior (`mode=release`): the newest release in the window gets the series' newest
  observation once the source says the series was updated at or after the release (else
  actual N.A., "not in the series yet"); prior is the observation before it. The next upcoming
  release gets the newest observation as prior.
- `mode=estimate`: flash/second/final estimates share one series, so the period an upcoming
  release refers to is unknown: only the newest released one gets actual and prior.
- `mode=date:N` (policy rates): actual = the rate N days after the decision (when it takes
  effect), prior = the rate on the decision day.
- Survey is always N.A. (no official source publishes consensus); revised is N.A. (no
  vintages kept). FRED values stay in memory only (router storage rule).
"""

from __future__ import annotations

import asyncio
import itertools
import re
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta
from functools import lru_cache
from pathlib import Path
from typing import Any, get_args

from .models import (
    AssetClass,
    EcoCountry,
    EcoEvent,
    EcoHistoryResponse,
    EcoIndicator,
    EcoIndicatorsResponse,
    EcoObservation,
    EcoResponse,
    EcoSource,
    Latency,
    MacroSeries,
    Meta,
)
from .providers.base import Capability, DataProvider
from .providers.calendars import CalEntry, time_at
from .providers.router import ProviderRouter, RouterError
from .research import release_staleness
from .secmaster import _read, symbology_dir

CAL_TTL = 3 * 3600.0  # Eurostat updates its calendar at 11:00 and 23:00 CET
SERIES_TTL = 15 * 60.0
FRESH_SLACK = timedelta(minutes=30)
SURVEY_NOTE = "survey N.A.: no official source publishes consensus"

# Which calendar answers for which country (ECO filters). The rest have no free official
# calendar wired yet (open question).
SOURCE_COUNTRY = {
    "fred": "US",
    "bea": "US",
    "fed": "US",
    "eurostat": "EZ",
    "ecb_mp": "EZ",
    "ecb_stat": "EZ",
    "dst": "DK",
}
SOURCE_LABEL = {
    "fred": "FRED (BLS/Census/Fed dates)",
    "bea": "BEA",
    "fed": "Federal Reserve",
    "eurostat": "Eurostat",
    "ecb_mp": "ECB",
    "ecb_stat": "ECB",
    "dst": "Statistics Denmark",
}
# Release time for a date-only entry the mapping file does not list.
SOURCE_STD_TIME = {"eurostat": ("11:00", "Europe/Luxembourg")}
SERIES_PROVIDER = {"fred": "fred", "eurostat": "eurostat", "dst": "dst", "ecb": "ecbstat"}


@dataclass(frozen=True)
class Rule:
    source: str
    match: str
    country: str
    event: str
    importance: int
    std_time: str
    tz: str
    series: str
    transform: str
    scale: float
    unit: str
    digits: int
    mode: str

    def matches(self, entry: CalEntry) -> bool:
        if self.source != entry.source:
            return False
        if self.source == "fred":
            return self.match == entry.key
        return re.search(self.match, entry.key, re.I) is not None


def load_rules(path: Path | None = None) -> list[Rule]:
    rows, _ = _read(path or symbology_dir() / "eco_events.csv")
    out: list[Rule] = []
    for r in rows:
        out.append(
            Rule(
                source=r["source"].strip(),
                match=r["match"].strip(),
                country=r["country"].strip(),
                event=r["event"].strip(),
                importance=int(r["importance"]),
                std_time=(r.get("std_time") or "").strip(),
                tz=(r.get("tz") or "").strip(),
                series=(r.get("series") or "").strip(),
                transform=(r.get("transform") or "level").strip() or "level",
                scale=float(r.get("scale") or 1) or 1.0,
                unit=(r.get("unit") or "").strip(),
                digits=int(r.get("digits") or 1),
                mode=(r.get("mode") or "release").strip() or "release",
            )
        )
    return out


@lru_cache(maxsize=1)
def rules() -> list[Rule]:
    return load_rules()


# ---------------------------------------------------------------------------- series math


def year_before(period: str) -> str | None:
    m = re.fullmatch(r"(\d{4})(-.+)?", period)
    if not m:
        return None
    return f"{int(m.group(1)) - 1}{m.group(2) or ''}"


def derive(series: MacroSeries, transform: str, scale: float) -> list[tuple[str, float]]:
    """Observations (period, value) after the line's transform, oldest first."""
    pts = sorted(((p.date, p.value) for p in series.data), key=lambda x: x[0])
    out: list[tuple[str, float]] = []
    if transform == "level":
        out = list(pts)
    elif transform in ("mom", "diff"):
        for (_, a), (d, b) in itertools.pairwise(pts):
            if transform == "diff":
                out.append((d, b - a))
            elif a:
                out.append((d, (b / a - 1) * 100))
    elif transform == "yoy":
        by = dict(pts)
        for d, v in pts:
            prev = by.get(year_before(d) or "")
            if prev:
                out.append((d, (v / prev - 1) * 100))
    else:
        raise ValueError(f"unknown transform {transform}")
    return [(d, v / scale) for d, v in out]


def period_label(obs_date: str, frequency: str | None) -> str:
    """A series' observation date as a period: FRED dates a month or quarter by its first day
    (`2026-10-01` monthly -> `2026-10`, quarterly -> `2026-Q4`); other sources already do."""
    f = (frequency or "").strip().upper()[:1]
    if len(obs_date) == 10 and obs_date.endswith("-01") and f in ("M", "Q"):
        y, m = obs_date[:4], int(obs_date[5:7])
        return f"{y}-{m:02d}" if f == "M" else f"{y}-Q{(m - 1) // 3 + 1}"
    return obs_date


@dataclass
class Line:
    rule: Rule | None
    entry: CalEntry
    event: EcoEvent
    group: str = ""
    extra: dict[str, Any] = field(default_factory=dict)


def _set(line: Line, **kw: Any) -> None:
    line.event = line.event.model_copy(update=kw)


def fill(
    lines: list[Line],
    obs: list[tuple[str, float]],
    updated: datetime | None,
    now: datetime,
    frequency: str | None = None,
) -> None:
    """Actual/prior for the lines of one rule (all occurrences, oldest first)."""
    if not lines:
        return
    rule = lines[0].rule
    assert rule is not None
    if not obs:
        for ln in lines:
            _set(ln, note="the series has no observations")
        return
    if rule.mode.startswith("date:"):
        lag = int(rule.mode.split(":", 1)[1] or 0)
        for ln in lines:
            day = ln.entry.day
            before = [v for d, v in obs if d[:10] <= day.isoformat()]
            effective = (day + timedelta(days=lag)).isoformat()
            after = [(d, v) for d, v in obs if d[:10] >= effective]
            kw: dict[str, Any] = {"prior": before[-1] if before else None}
            if ln.event.released and after:
                kw["actual"] = after[0][1]
            elif ln.event.released:
                kw["note"] = f"the new rate takes effect on {effective}; not in the series yet"
            _set(ln, **kw)
        return
    past = [ln for ln in lines if ln.event.released]
    future = [ln for ln in lines if not ln.event.released]
    k = len(obs) - 1
    fresh = True
    if past:
        newest = past[-1]
        fresh = updated is None or updated >= newest.event.time - FRESH_SLACK
        idx = k if fresh else k + 1
        for i, ln in enumerate(reversed(past)):
            a = idx - i
            if rule.mode == "estimate" and i > 0:
                break  # an older estimate may refer to the same period: leave it N.A.
            kw = {}
            if 0 <= a <= k:
                kw["actual"] = obs[a][1]
                kw["period"] = period_label(obs[a][0], frequency)
            else:
                kw["note"] = "released; not in the series yet"
            if 0 <= a - 1 <= k:
                kw["prior"] = obs[a - 1][1]
            _set(ln, **kw)
    if future:
        nxt = future[0]
        if rule.mode == "estimate":
            _set(nxt, note="prior N.A.: the calendar does not state which period this is")
        elif fresh:
            _set(nxt, prior=obs[k][1])
        else:
            _set(nxt, note="prior N.A.: the last release is not in the series yet")


# ---------------------------------------------------------------------------- service


def slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:48]


TRANSFORM_LABEL = {"level": "level", "mom": "% m/m", "yoy": "% y/y", "diff": "change"}


def indicator_key(rule: Rule) -> str:
    return slug(f"{rule.country} {rule.event}")


def indicator_of(rule: Rule) -> EcoIndicator:
    return EcoIndicator(
        key=indicator_key(rule),
        country=rule.country,
        event=rule.event,
        importance=rule.importance,
        series=rule.series,
        transform=rule.transform,
        transform_label=TRANSFORM_LABEL[rule.transform],
        unit=rule.unit,
        digits=rule.digits,
        calendar=SOURCE_LABEL.get(rule.source, rule.source),
    )


def indicator_rules(all_rules: list[Rule]) -> dict[str, list[Rule]]:
    """Rules with a series, by ECST key (several calendar rules may feed one indicator, e.g.
    HICP flash and final are two keys; GDP flash/estimates of one series stay separate)."""
    out: dict[str, list[Rule]] = {}
    for r in all_rules:
        if r.series:
            out.setdefault(indicator_key(r), []).append(r)
    return out


def period_start(period: str) -> str:
    """`2026-10` -> `2026-10-01`, `2026-Q3` -> `2026-07-01`, `2026` -> `2026-01-01`."""
    m = re.fullmatch(r"(\d{4})-Q([1-4])", period)
    if m:
        return f"{m.group(1)}-{(int(m.group(2)) - 1) * 3 + 1:02d}-01"
    if re.fullmatch(r"\d{4}-\d{2}", period):
        return f"{period}-01"
    if re.fullmatch(r"\d{4}", period):
        return f"{period}-01-01"
    return period[:10]


def expand(entry: CalEntry, now: datetime, all_rules: list[Rule]) -> list[Line]:
    matched = [r for r in all_rules if r.matches(entry)]
    if not matched and entry.source == "fred":
        return []  # FRED dates include data-feed updates: only mapped releases are shown
    out: list[Line] = []
    targets: list[Rule | None] = list(matched) or [None]
    for r in targets:
        if entry.when is not None:
            when, kind = entry.when, "calendar"
        elif r is not None and r.std_time:
            when, kind = time_at(entry.day, r.std_time, r.tz), "standard"
        elif entry.source in SOURCE_STD_TIME:
            hhmm, tz = SOURCE_STD_TIME[entry.source]
            when, kind = time_at(entry.day, hhmm, tz), "standard"
        else:
            continue  # neither the calendar nor the mapping gives a time
        name = r.event if r else entry.title
        ev = EcoEvent(
            id=f"{entry.source}:{entry.day.isoformat()}:{slug(name)}",
            time=when,
            time_kind=kind,
            country=r.country if r else SOURCE_COUNTRY.get(entry.source, ""),
            event=name,
            period=entry.period,
            importance=r.importance if r else 1,
            unit=r.unit if r else "",
            digits=r.digits if r else 1,
            source=SOURCE_LABEL.get(entry.source, entry.source),
            series=r.series or None if r else None,
            indicator=indicator_key(r) if r and r.series else None,
            tentative=entry.tentative,
            released=when <= now,
        )
        key = f"{r.source}|{r.match}|{r.event}" if r else ""
        out.append(Line(r, entry, ev, key))
    return out


class EcoService:
    def __init__(
        self,
        router: ProviderRouter,
        now: datetime | None = None,
        rule_source: Callable[[], list[Rule]] = rules,
    ) -> None:
        self.router = router
        self._now = now
        self._rules = rule_source

    def now(self) -> datetime:
        return self._now or datetime.now(UTC)

    def _demo(self) -> bool:
        return any(p.demo for p in self.router.providers)

    async def _calendar(self, p: DataProvider) -> tuple[list[CalEntry], Meta] | RouterError:
        try:
            return await self.router.fetch(
                Capability.ECON,
                AssetClass.INDEX,
                f"cal:{p.name}:{self.now().date().isoformat()}",
                CAL_TTL,
                lambda pp: pp.econ_calendar(),  # type: ignore[attr-defined]
                only=p.name,
            )
        except RouterError as exc:
            return exc

    async def _series(self, spec: str) -> tuple[MacroSeries, Meta] | RouterError:
        kind, _, sid = spec.partition(":")
        name = "demo" if self._demo() else SERIES_PROVIDER.get(kind, kind)
        try:
            return await self.router.fetch(
                Capability.ECON,
                AssetClass.INDEX,
                f"series:{spec}",
                SERIES_TTL,
                lambda pp: pp.econ_series(sid if name != "demo" else spec),  # type: ignore[attr-defined]
                only=name,
            )
        except RouterError as exc:
            return exc

    async def _lines(
        self, start: date, end: date
    ) -> tuple[list[Line], list[EcoSource], list[datetime], bool, bool]:
        """Calendar lines in [start, end] (no values yet), per-source status."""
        now = self.now()
        providers = self.router.chain(Capability.ECON, AssetClass.INDEX)
        results = await asyncio.gather(*(self._calendar(p) for p in providers))
        sources: list[EcoSource] = []
        entries: list[CalEntry] = []
        fetched: list[datetime] = []
        cached = True
        demo = False
        for p, r in zip(providers, results, strict=True):
            if isinstance(r, RouterError):
                sources.append(EcoSource(name=p.name, label=p.label, ok=False, detail=str(r)))
                continue
            data, meta = r
            entries.extend(data)
            fetched.append(meta.fetched_at)
            cached = cached and meta.cached
            demo = demo or meta.demo
            sources.append(
                EcoSource(
                    name=p.name,
                    label=p.label,
                    ok=True,
                    count=len(data),
                    fetched_at=meta.fetched_at,
                )
            )
        all_rules = self._rules()
        lines: list[Line] = []
        seen: set[str] = set()
        for e in entries:
            for ln in expand(e, now, all_rules):
                local_day = ln.event.time.date()
                if not (start <= local_day <= end) and not (start <= e.day <= end):
                    continue
                if ln.event.id in seen:
                    continue
                seen.add(ln.event.id)
                lines.append(ln)
        return lines, sources, fetched, cached, demo

    async def calendar(self, days_back: int = 1, days_ahead: int = 6) -> EcoResponse:
        now = self.now()
        today = now.astimezone(UTC).date()
        start, end = today - timedelta(days=days_back), today + timedelta(days=days_ahead)
        lines, sources, fetched, cached, demo = await self._lines(start, end)
        await self._fill(lines, now)
        lines.sort(key=lambda ln: (ln.event.time, -ln.event.importance, ln.event.event))
        ok = [s for s in sources if s.ok]
        meta = Meta(
            source=" + ".join(dict.fromkeys(s.label for s in ok)) or "none",
            latency=Latency.STATIC,
            fetched_at=min(fetched) if fetched else now,
            cached=cached and bool(fetched),
            demo=demo,
            note=SURVEY_NOTE,
        )
        covered = set(SOURCE_COUNTRY.values())
        return EcoResponse(
            meta=meta,
            now=now,
            start=start,
            end=end,
            data=[ln.event for ln in lines],
            sources=sources,
            no_source=[c for c in get_args(EcoCountry) if c not in covered],
        )

    def indicators(self) -> EcoIndicatorsResponse:
        by_key = indicator_rules(self._rules())
        return EcoIndicatorsResponse(data=[indicator_of(rs[0]) for rs in by_key.values()])

    async def history(self, key: str) -> EcoHistoryResponse:
        """ECST: the indicator's whole fetched history after its transform, with the last and
        next release from the calendars and frequency-aware STALE (SPEC §6.3)."""
        rs = indicator_rules(self._rules()).get(key)
        if not rs:
            raise RouterError("not_found", f"no ECST indicator {key!r} (see ECST without args)", [])
        rule = rs[0]
        now = self.now()
        today = now.astimezone(UTC).date()
        res, (lines, *_rest) = await asyncio.gather(
            self._series(rule.series),
            self._lines(today - timedelta(days=7), today + timedelta(days=30)),
        )
        if isinstance(res, RouterError):
            raise res
        series, meta = res
        obs = derive(series, rule.transform, rule.scale)
        data = []
        for d, v in obs:
            per = period_label(d, series.frequency)
            data.append(EcoObservation(period=per, date=period_start(per), value=v))
        mine = sorted((ln.event.time for ln in lines if ln.event.indicator == key), key=lambda t: t)
        past = [t for t in mine if t <= now]
        future = [t for t in mine if t > now]
        as_of = datetime.fromisoformat(data[-1].date).replace(tzinfo=UTC) if data else None
        meta = release_staleness(meta.model_copy(update={"as_of": as_of}), series.frequency, now)
        return EcoHistoryResponse(
            meta=meta,
            now=now,
            indicator=indicator_of(rule),
            title=series.title,
            frequency=series.frequency,
            updated=series.updated,
            data=data,
            last_release=past[-1] if past else None,
            next_release=future[0] if future else None,
        )

    async def _fill(self, lines: list[Line], now: datetime) -> None:
        """Group lines by rule, fetch each series once, apply the matching rules. When the
        newest release of a rule falls before the window, the window has no released line of
        it and the next one's prior is simply the newest observation."""
        groups: dict[str, list[Line]] = {}
        for ln in lines:
            if ln.rule is not None and ln.rule.series:
                groups.setdefault(ln.group, []).append(ln)
        if not groups:
            return
        specs = sorted({g[0].rule.series for g in groups.values() if g[0].rule})
        got = await asyncio.gather(*(self._series(s) for s in specs))
        by_spec = dict(zip(specs, got, strict=True))
        for group in groups.values():
            rule = group[0].rule
            assert rule is not None
            res = by_spec[rule.series]
            if isinstance(res, RouterError):
                for ln in group:
                    _set(ln, note=f"series unavailable: {res}")
                continue
            series, meta = res
            try:
                obs = derive(series, rule.transform, rule.scale)
            except (ValueError, ZeroDivisionError) as exc:
                for ln in group:
                    _set(ln, note=f"series unusable: {exc}")
                continue
            group.sort(key=lambda ln: ln.event.time)
            fill(group, obs, series.updated, now, series.frequency)
            label = meta.source
            for ln in group:
                _set(ln, series_source=label)
