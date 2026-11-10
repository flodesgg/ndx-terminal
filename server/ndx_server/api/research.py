"""Phase 3 research endpoints."""

from __future__ import annotations

from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Query

from ..eco import EcoService
from ..models import (
    EcoHistoryResponse,
    EcoIndicatorsResponse,
    EcoResponse,
    ExportResult,
    FilingsResponse,
    FinancialsResponse,
    InsidersResponse,
    MacroResponse,
    ScreenResponse,
    YieldCurveResponse,
)
from ..research import ResearchService
from ..state import AppState, get_state
from .errors import ERROR_RESPONSES

router = APIRouter(tags=["research"], responses=ERROR_RESPONSES)


def get_research(state: Annotated[AppState, Depends(get_state)]) -> ResearchService:
    svc: ResearchService = state.services["research"]
    return svc


R = Annotated[ResearchService, Depends(get_research)]
PeriodQ = Literal["annual", "quarterly"]


@router.get("/financials/{symbol:path}", response_model=FinancialsResponse)
async def financials(symbol: str, svc: R, period: PeriodQ = "annual") -> FinancialsResponse:
    return await svc.financials(symbol, period)


@router.post("/financials/{symbol:path}/export", response_model=ExportResult)
async def export_financials(symbol: str, svc: R, period: PeriodQ = "annual") -> ExportResult:
    return await svc.export_financials(symbol, period)


@router.get("/filings/{symbol:path}", response_model=FilingsResponse)
async def filings(symbol: str, svc: R) -> FilingsResponse:
    return await svc.filings(symbol)


@router.get("/insiders/{symbol:path}", response_model=InsidersResponse)
async def insiders(symbol: str, svc: R) -> InsidersResponse:
    return await svc.insiders(symbol)


@router.get("/eco", response_model=EcoResponse)
async def eco(
    state: Annotated[AppState, Depends(get_state)],
    days_back: Annotated[int, Query(ge=0, le=14)] = 1,
    days_ahead: Annotated[int, Query(ge=0, le=30)] = 6,
) -> EcoResponse:
    """Economic calendar from official calendars (SPEC §8 `ECO`)."""
    svc: EcoService = state.services["eco"]
    return await svc.calendar(days_back, days_ahead)


@router.get("/eco/indicators", response_model=EcoIndicatorsResponse)
async def eco_indicators(state: Annotated[AppState, Depends(get_state)]) -> EcoIndicatorsResponse:
    """Mapped economic series (SPEC §8 `ECST` list)."""
    svc: EcoService = state.services["eco"]
    return svc.indicators()


@router.get("/eco/indicators/{key}", response_model=EcoHistoryResponse)
async def eco_history(
    key: str, state: Annotated[AppState, Depends(get_state)]
) -> EcoHistoryResponse:
    """History of one mapped series after its transform, with the last and next release."""
    svc: EcoService = state.services["eco"]
    return await svc.history(key)


@router.get("/macro/{series_id}", response_model=MacroResponse)
async def macro(series_id: str, svc: R) -> MacroResponse:
    return await svc.macro(series_id)


@router.get("/yields/us", response_model=YieldCurveResponse)
async def yields(svc: R) -> YieldCurveResponse:
    return await svc.yield_curve()


@router.get("/screen", response_model=ScreenResponse)
async def screen(
    svc: R,
    region: Annotated[str, Query(pattern="^[a-z]{2}$")] = "us",
    sector: str | None = None,
    mcap_min: Annotated[float | None, Query(ge=0)] = None,
    mcap_max: Annotated[float | None, Query(ge=0)] = None,
    pe_max: Annotated[float | None, Query(gt=0)] = None,
    chg_min: float | None = None,
    chg_max: float | None = None,
    vol_min: Annotated[float | None, Query(ge=0)] = None,
    sort: Literal["mcap", "chg", "volume", "pe"] = "mcap",
    desc: bool = True,
    size: Annotated[int, Query(ge=1, le=100)] = 50,
) -> ScreenResponse:
    return await svc.screen(
        region=region,
        sector=sector or None,
        mcap_min=mcap_min,
        mcap_max=mcap_max,
        pe_max=pe_max,
        chg_min=chg_min,
        chg_max=chg_max,
        vol_min=vol_min,
        sort=sort,
        desc=desc,
        size=size,
    )
