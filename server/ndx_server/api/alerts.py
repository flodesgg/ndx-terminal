"""Alert CRUD."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException

from ..models import Alert, AlertCreate
from ..state import AppState, get_state
from ..symbols import SymbolError
from ..userkeys import store_key

router = APIRouter(tags=["user"])
StateDep = Annotated[AppState, Depends(get_state)]


@router.get("/alerts", response_model=list[Alert])
def list_alerts(state: StateDep) -> list[Alert]:
    return [Alert.model_validate(a) for a in state.db.list_alerts()]


@router.post("/alerts", response_model=Alert)
def create_alert(body: AlertCreate, state: StateDep) -> Alert:
    try:
        sym = store_key(state.db, body.symbol)
    except SymbolError as exc:
        raise HTTPException(400, str(exc)) from exc
    if body.kind in ("above", "below") and body.threshold <= 0:
        raise HTTPException(400, "price threshold must be positive")
    return Alert.model_validate(state.db.create_alert(sym, body.kind, body.threshold, body.note))


@router.delete("/alerts/{alert_id}", status_code=204)
def delete_alert(alert_id: int, state: StateDep) -> None:
    if not state.db.delete_alert(alert_id):
        raise HTTPException(404, "alert not found")


@router.post("/alerts/{alert_id}/rearm", response_model=Alert)
def rearm_alert(alert_id: int, state: StateDep) -> Alert:
    a = state.db.rearm_alert(alert_id)
    if a is None:
        raise HTTPException(404, "alert not found")
    return Alert.model_validate(a)
