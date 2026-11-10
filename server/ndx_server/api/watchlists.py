"""Watchlist CRUD."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException

from ..db import HEADER, Database
from ..models import Watchlist, WatchlistCreate, WatchlistItems
from ..state import AppState, get_state
from ..symbols import SymbolError
from ..userkeys import store_key

router = APIRouter(tags=["user"])
StateDep = Annotated[AppState, Depends(get_state)]


MAX_SYMBOLS = 300
MAX_HEADERS = 50


def _header(raw: str) -> str:
    name = " ".join(raw[len(HEADER) :].split())
    if not 1 <= len(name) <= 32:
        raise HTTPException(400, "a group header needs a name of 1 to 32 characters")
    return HEADER + name


def _clean(db: Database, symbols: list[str]) -> list[str]:
    out: list[str] = []
    for s in symbols:
        if s.strip().startswith(HEADER):
            h = _header(s.strip())
            if h not in out:
                out.append(h)
            continue
        try:
            sym = store_key(db, s)
        except SymbolError as exc:
            raise HTTPException(400, str(exc)) from exc
        if sym not in out:
            out.append(sym)
    if sum(1 for x in out if x.startswith(HEADER)) > MAX_HEADERS:
        raise HTTPException(400, f"at most {MAX_HEADERS} group headers")
    kept: list[str] = []
    n = 0
    for x in out:
        if not x.startswith(HEADER):
            n += 1
            if n > MAX_SYMBOLS:
                continue
        kept.append(x)
    return kept


@router.get("/watchlists", response_model=list[Watchlist])
def list_watchlists(state: StateDep) -> list[Watchlist]:
    return [Watchlist.model_validate(w) for w in state.db.list_watchlists()]


@router.post("/watchlists", response_model=Watchlist)
def create_watchlist(body: WatchlistCreate, state: StateDep) -> Watchlist:
    name = body.name.strip().upper()
    if state.db.find_watchlist(name) is not None:
        raise HTTPException(409, f"watchlist {name} exists")
    return Watchlist.model_validate(state.db.create_watchlist(name))


@router.delete("/watchlists/{list_id}", status_code=204)
def delete_watchlist(list_id: int, state: StateDep) -> None:
    if not state.db.delete_watchlist(list_id):
        raise HTTPException(404, "watchlist not found")


@router.put("/watchlists/{list_id}/items", response_model=Watchlist)
def set_items(list_id: int, body: WatchlistItems, state: StateDep) -> Watchlist:
    w = state.db.set_watchlist_items(list_id, _clean(state.db, body.symbols))
    if w is None:
        raise HTTPException(404, "watchlist not found")
    return Watchlist.model_validate(w)
