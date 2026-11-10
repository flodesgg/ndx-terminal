"""Research datasets (Phase 3): fundamentals, filings, insiders, economic calendar, macro
series, Treasury yield curve and the equity screener."""

from __future__ import annotations

import csv
import io
import re
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Any, Literal

from .models import (
    AssetClass,
    ExportResult,
    FilingsResponse,
    FinancialsResponse,
    InsidersResponse,
    Latency,
    MacroResponse,
    Meta,
    ScreenResponse,
    YieldCurveResponse,
)
from .providers.base import Capability
from .providers.router import ProviderRouter, RouterError
from .providers.treasury import curve_as_of, is_treasury_series
from .providers.yahoo_research import screen_body
from .symbols import classify

FUNDAMENTALS_TTL = 12 * 3600.0  # SPEC §6.3
FILINGS_TTL = 24 * 3600.0  # SPEC §6.3
INSIDERS_TTL = 24 * 3600.0  # Form 4 filings (SPEC §6.3: filings 24 h)
MACRO_TTL = 15 * 60.0  # FRED: memory only, short TTL (SPEC §6.3)
TREASURY_SERIES_TTL = 3600.0
# STALE for release-frequency data follows the series' own cadence (SPEC §6.3). Observations are
# dated at the START of their period (Q3 → 07-01), and the next one is published only after the
# following period ends plus a publication lag (GDP advance ≈ 1 month after quarter end, PCE and
# JOLTS ≈ 1-1.5 months after month end). So a value is STALE once the next release is overdue by
# half a period: 2 periods + lag + ½ period from the observation date. Daily/weekly series are
# dated near publication: 5 days (weekends/holidays) and 2 weeks.
FREQ_STALE_DAYS = {
    "d": 5,
    "w": 15,
    "m": 2 * 31 + 45 + 15,  # 122
    "q": 2 * 92 + 60 + 46,  # 290
    "a": 2 * 366 + 120 + 183,  # 1035
}
FRED_YIELD_IDS = re.compile(r"^(DGS\d+(MO)?|T10Y2Y|T10Y3M|DTB\d+)$")
YIELDS_TTL = 3600.0
SCREEN_TTL = 120.0

Period = Literal["annual", "quarterly"]
G = AssetClass.INDEX  # routing key for global (non-instrument) datasets


def release_staleness(meta: Meta, frequency: str | None, now: datetime | None = None) -> Meta:
    """Frequency-aware STALE: a monthly series is not stale two days after its release."""
    days = FREQ_STALE_DAYS.get((frequency or "").strip().lower()[:1])
    if days is None or meta.as_of is None:
        return meta
    age = (now or datetime.now(UTC)) - meta.as_of
    return meta.model_copy(
        update={"stale": age > timedelta(days=days), "stale_after_s": float(days * 86400)}
    )


def _static(meta: Meta, note: str | None = None) -> Meta:
    return meta.model_copy(update={"note": note or meta.note})


class ResearchService:
    def __init__(self, router: ProviderRouter, export_dir: Path) -> None:
        self.router = router
        self.export_dir = export_dir

    async def financials(self, symbol: str, period: Period) -> FinancialsResponse:
        inst = classify(symbol)
        if inst.asset_class is not AssetClass.EQUITY:
            raise RouterError("bad_request", "financial statements are for equities", [])
        (periods, currency, statements), meta = await self.router.fetch(
            Capability.FUNDAMENTALS,
            inst.asset_class,
            f"{inst.symbol}:{period}",
            FUNDAMENTALS_TTL,
            lambda p: p.fundamentals(inst, period),
        )
        meta = meta.model_copy(
            update={
                "latency": Latency.STATIC,
                "note": meta.note or "as reported; updates after each filing",
            }
        )
        return FinancialsResponse(
            meta=meta,
            symbol=inst.symbol,
            period=period,
            currency=currency,
            periods=periods,
            statements=statements,
        )

    async def export_financials(self, symbol: str, period: Period) -> ExportResult:
        fin = await self.financials(symbol, period)
        buf = io.StringIO()
        w = csv.writer(buf)
        w.writerow(
            [
                f"# {fin.symbol} {period} statements, currency {fin.currency or '?'}, "
                f"source {fin.meta.source}, fetched {fin.meta.fetched_at.isoformat()}"
            ]
        )
        rows = 0
        for st in fin.statements:
            w.writerow([])
            w.writerow([st.name.upper(), *fin.periods])
            for line in st.lines:
                w.writerow([line.label, *["" if v is None else v for v in line.values]])
                rows += 1
        self.export_dir.mkdir(parents=True, exist_ok=True)
        safe = re.sub(r"[^A-Za-z0-9._-]", "_", fin.symbol)
        path = self.export_dir / f"{safe}_{period}_{date.today().isoformat()}.csv"
        path.write_text(buf.getvalue(), encoding="utf-8")
        return ExportResult(path=str(path), rows=rows)

    async def filings(self, symbol: str) -> FilingsResponse:
        inst = classify(symbol)
        data, meta = await self.router.fetch(
            Capability.FILINGS,
            inst.asset_class,
            inst.symbol,
            FILINGS_TTL,
            lambda p: p.filings(inst),  # type: ignore[attr-defined]
        )
        return FilingsResponse(
            meta=meta.model_copy(update={"latency": Latency.STATIC}), symbol=inst.symbol, data=data
        )

    async def insiders(self, symbol: str) -> InsidersResponse:
        inst = classify(symbol)
        data, meta = await self.router.fetch(
            Capability.INSIDERS,
            inst.asset_class,
            inst.symbol,
            INSIDERS_TTL,
            lambda p: p.insiders(inst),  # type: ignore[attr-defined]
        )
        meta = meta.model_copy(
            update={"latency": Latency.STATIC, "note": "from SEC Form 4 filings via Yahoo"}
        )
        return InsidersResponse(meta=meta, symbol=inst.symbol, data=data)

    async def macro(self, series_id: str) -> MacroResponse:
        sid = series_id.strip().upper()
        if not re.fullmatch(r"[A-Z0-9_.]{2,40}", sid):
            raise RouterError("bad_request", f"invalid series id {series_id!r}", [])
        if FRED_YIELD_IDS.match(sid):
            raise RouterError(
                "bad_request",
                f"US yields come from the Treasury par curve, not FRED: use US2Y, US10Y, "
                f"US30Y or US2S10S instead of {sid}",
                [],
            )
        treasury = is_treasury_series(sid)
        data, meta = await self.router.fetch(
            Capability.YIELDS if treasury else Capability.MACRO,
            G,
            f"series:{sid}" if treasury else sid,
            TREASURY_SERIES_TTL if treasury else MACRO_TTL,
            lambda p: p.series(sid),  # type: ignore[attr-defined]
            as_of=lambda s: (
                (
                    curve_as_of(date.fromisoformat(s.data[-1].date))
                    if treasury
                    else datetime.fromisoformat(s.data[-1].date).replace(tzinfo=UTC)
                )
                if s.data
                else None
            ),
        )
        return MacroResponse(meta=release_staleness(meta, data.frequency), data=data)

    async def yield_curve(self) -> YieldCurveResponse:
        cs, meta = await self.router.fetch(
            Capability.YIELDS,
            G,
            "ust",
            YIELDS_TTL,
            lambda p: p.yield_curve(),  # type: ignore[attr-defined]
            as_of=lambda c: curve_as_of(date.fromisoformat(c.current.date)),
        )
        return YieldCurveResponse(
            meta=release_staleness(meta, "daily"),
            tenors=cs.tenors,
            current=cs.current,
            month_ago=cs.month_ago,
            year_ago=cs.year_ago,
        )

    async def screen(self, **params: Any) -> ScreenResponse:
        body = screen_body(**params)
        key = repr(sorted(params.items()))
        (total, rows), meta = await self.router.fetch(
            Capability.SCREENER,
            AssetClass.EQUITY,
            key,
            SCREEN_TTL,
            lambda p: p.screen(body),  # type: ignore[attr-defined]
        )
        meta = meta.model_copy(update={"note": "screener snapshot; prices delayed per exchange"})
        return ScreenResponse(meta=meta, total=total, data=rows)
