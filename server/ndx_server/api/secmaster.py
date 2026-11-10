"""Security master endpoints (SPEC §5)."""

from __future__ import annotations

from dataclasses import asdict
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query

from ..migrate_symbols import MARKER
from ..models import SecIndex, SecmasterStatus, SecurityLookup, SecurityRecord
from ..secindex import IndexCache
from ..secmaster import SymbologyError, symbology
from ..seeds import SeedStore
from ..state import AppState, get_state

router = APIRouter(tags=["secmaster"])
StateDep = Annotated[AppState, Depends(get_state)]
_index = IndexCache()


@router.get("/secmaster/index", response_model=SecIndex)
def index(state: StateDep) -> SecIndex:
    """Every security the command line can name (tables + runtime seeds; DEMO: fixtures)."""
    if state.settings.demo:
        from ..demo import FIXTURES

        return _index.get(symbology(), None, {k: v[0] for k, v in FIXTURES.items()})
    return _index.get(symbology(), state.settings.data_dir / "seeds")


_names: tuple[SecIndex | None, dict[str, str]] = (None, {})


def _index_names(state: AppState) -> dict[str, str]:
    """Canonical ID -> name from the index (the listings seeds name every US security)."""
    global _names
    idx = index(state)
    if _names[0] is not idx:
        _names = (idx, {it[0]: it[1] for it in idx.items if len(it) > 1 and it[1]})
    return _names[1]


@router.get("/secmaster/security/{symbol:path}", response_model=SecurityRecord)
def security(symbol: str) -> SecurityRecord:
    """Security-master record for a canonical ID or provider symbol, with its provider map."""
    try:
        return SecurityRecord.model_validate(asdict(symbology().security(symbol)))
    except SymbologyError as exc:
        raise HTTPException(404, str(exc)) from exc


@router.get("/secmaster/securities", response_model=list[SecurityLookup])
def securities(
    state: StateDep,
    symbols: Annotated[str, Query(max_length=4000, description="Comma-separated symbols")],
) -> list[SecurityLookup]:
    """Several records at once (WEI/MON reference columns such as name and currency). A record
    without a name takes the one the index lists (listings seeds), if any."""
    out: list[SecurityLookup] = []
    names: dict[str, str] | None = None
    for raw in [s.strip() for s in symbols.split(",") if s.strip()][:200]:
        try:
            rec = SecurityRecord.model_validate(asdict(symbology().security(raw)))
            if rec.name is None:
                names = names if names is not None else _index_names(state)
                rec.name = names.get(rec.id)
            out.append(SecurityLookup(symbol=raw, record=rec))
        except SymbologyError as exc:
            out.append(SecurityLookup(symbol=raw, error=str(exc)))
    return out


@router.get("/secmaster/status", response_model=SecmasterStatus)
def status(state: StateDep) -> SecmasterStatus:
    sm = symbology()
    seeds = state.services.get("seeds")
    raw = state.db.get_setting(MARKER)
    return SecmasterStatus(
        tables_reviewed={k: v.isoformat() if v else None for k, v in sm.reviewed.items()},
        learned=len(sm.learned),
        seeds=seeds.seed_status() if isinstance(seeds, SeedStore) else [],
        migration=raw if isinstance(raw, dict) else None,
    )
