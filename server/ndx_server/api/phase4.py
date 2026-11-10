"""Portfolio, correlation, notes and backtest endpoints."""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Query

from ..analytics import TradeError, apply_trades
from ..backtest import list_scripts, run_script
from ..journal import parse_trades_csv, summarize, today
from ..models import (
    BtRunRequest,
    BtRunResponse,
    BtScriptsResponse,
    CorrelationResponse,
    JournalEntryBody,
    JournalResponse,
    Note,
    NoteBody,
    PortfolioResponse,
    Trade,
    TradeCreate,
    TradeImport,
    TradeImportResult,
)
from ..portfolio import PortfolioService
from ..state import AppState, get_state
from ..symbols import SymbolError
from ..userkeys import store_key
from .errors import ERROR_RESPONSES

router = APIRouter(responses=ERROR_RESPONSES)
StateDep = Annotated[AppState, Depends(get_state)]


def get_portfolio(state: StateDep) -> PortfolioService:
    svc: PortfolioService = state.services["portfolio"]
    return svc


PortDep = Annotated[PortfolioService, Depends(get_portfolio)]


@router.get("/portfolio", response_model=PortfolioResponse, tags=["portfolio"])
async def portfolio(svc: PortDep, risk: bool = True) -> PortfolioResponse:
    return await svc.summary(with_risk=risk)


@router.get("/portfolio/trades", response_model=list[Trade], tags=["portfolio"])
def list_trades(state: StateDep) -> list[Trade]:
    return [Trade.model_validate(t) for t in state.db.list_trades()]


@router.post("/portfolio/trades", response_model=Trade, tags=["portfolio"])
async def add_trade(body: TradeCreate, state: StateDep, svc: PortDep) -> Trade:
    try:
        sym = store_key(state.db, body.symbol)
    except SymbolError as exc:
        raise HTTPException(400, str(exc)) from exc
    if body.qty == 0:
        raise HTTPException(400, "quantity must be non-zero")
    try:
        svc.validate_trade(sym, body.qty)
    except TradeError as exc:
        raise HTTPException(400, str(exc)) from exc
    price = body.price
    note = body.note
    if price is None:
        q = await svc.market.quote(sym)
        if q.data.price is None:
            raise HTTPException(502, f"no price available for {sym}")
        price = q.data.price
        stamp = q.meta.as_of.isoformat(timespec="seconds") if q.meta.as_of else "N.A."
        note = (note + " " if note else "") + (
            f"[filled at {q.meta.source} {q.meta.tag} quote, as of {stamp}]"
        )
    if price <= 0:
        raise HTTPException(400, "price must be positive")
    return Trade.model_validate(state.db.add_trade(sym, body.qty, price, note.strip()))


@router.delete("/portfolio/trades/{trade_id}", status_code=204, tags=["portfolio"])
def delete_trade(trade_id: int, state: StateDep) -> None:
    if not state.db.delete_trade(trade_id):
        raise HTTPException(404, "trade not found")


@router.post("/portfolio/import", response_model=TradeImportResult, tags=["portfolio"])
def import_trades(body: TradeImport, state: StateDep, svc: PortDep) -> TradeImportResult:
    """CSV import, all or nothing: any bad row (format, unknown security, selling more than
    held at that point) imports nothing and lists every error."""
    rows, errors = parse_trades_csv(body.csv)
    resolved: list[tuple[str, dict[str, Any]]] = []
    for i, r in enumerate(rows):
        try:
            resolved.append((store_key(state.db, str(r["security"])), r))
        except SymbolError as exc:
            errors.append(f"row {i + 1} ({r['security']}): {exc}")
    if not errors:
        # Check in the order holdings() replays them (ORDER BY ts, id): imported rows are
        # dated at 00:00Z and may land before trades already stored; on equal ts the new rows
        # get the larger ids, so they sort after the stored ones.
        held = [
            (t["ts"], 0, t["id"], t["symbol"], t["qty"], t["price"]) for t in state.db.list_trades()
        ]
        new = [(r["ts"], 1, i, sym, r["qty"], r["price"]) for i, (sym, r) in enumerate(resolved)]
        try:
            apply_trades([(sym, q, p) for *_, sym, q, p in sorted([*held, *new])])
        except TradeError as exc:
            errors.append(str(exc))
    if errors:
        return TradeImportResult(imported=0, errors=errors)
    state.db.add_trades(
        [
            (sym, float(r["qty"]), float(r["price"]), str(r["note"]), str(r["ts"]))
            for sym, r in resolved
        ]
    )
    return TradeImportResult(imported=len(resolved))


@router.get("/journal", response_model=JournalResponse, tags=["journal"])
def journal(state: StateDep) -> JournalResponse:
    return summarize(state.db.list_journal())


def _journal_values(body: JournalEntryBody, state: AppState) -> dict[str, object]:
    try:
        sym = store_key(state.db, body.symbol)
    except SymbolError:
        sym = body.symbol.strip().upper()  # a journal may name anything the user traded
    v = body.model_dump()
    v["symbol"] = sym
    v["opened"] = body.opened or today()
    if body.exit is None:
        v["closed"] = None
    elif not body.closed:
        v["closed"] = today()
    return v


@router.post("/journal", response_model=JournalResponse, tags=["journal"])
def add_journal(body: JournalEntryBody, state: StateDep) -> JournalResponse:
    state.db.save_journal(_journal_values(body, state))
    return summarize(state.db.list_journal())


@router.put("/journal/{entry_id}", response_model=JournalResponse, tags=["journal"])
def edit_journal(entry_id: int, body: JournalEntryBody, state: StateDep) -> JournalResponse:
    if state.db.save_journal(_journal_values(body, state), entry_id) is None:
        raise HTTPException(404, "journal entry not found")
    return summarize(state.db.list_journal())


@router.delete("/journal/{entry_id}", response_model=JournalResponse, tags=["journal"])
def delete_journal(entry_id: int, state: StateDep) -> JournalResponse:
    if not state.db.delete_journal(entry_id):
        raise HTTPException(404, "journal entry not found")
    return summarize(state.db.list_journal())


@router.get("/correlation", response_model=CorrelationResponse, tags=["analytics"])
async def correlation(
    svc: PortDep,
    symbols: Annotated[str, Query(max_length=1000)],
    days: Annotated[int, Query(ge=20, le=1260)] = 252,
) -> CorrelationResponse:
    syms = [s for s in (x.strip() for x in symbols.split(",")) if s][:30]
    if len(syms) < 2:
        raise HTTPException(400, "need at least two symbols")
    try:
        return await svc.correlation(syms, days)
    except SymbolError as exc:
        raise HTTPException(400, str(exc)) from exc


def _note_key(state: AppState, symbol: str) -> str:
    """Notes follow the security (canonical ID); free-form keys stay as typed (upper-cased)."""
    try:
        return store_key(state.db, symbol)
    except SymbolError:
        return symbol.strip().upper()


@router.get("/notes", response_model=list[Note], tags=["user"])
def list_notes(state: StateDep) -> list[Note]:
    return [Note.model_validate(n) for n in state.db.list_notes()]


@router.get("/notes/{symbol:path}", response_model=Note, tags=["user"])
def get_note(symbol: str, state: StateDep) -> Note:
    sym = _note_key(state, symbol)
    n = state.db.get_note(sym)
    return Note.model_validate(n) if n else Note(symbol=sym, body="", updated_at=None)


@router.put("/notes/{symbol:path}", response_model=Note, tags=["user"])
def put_note(symbol: str, body: NoteBody, state: StateDep) -> Note:
    sym = _note_key(state, symbol)
    if not sym or len(sym) > 24:
        raise HTTPException(400, "invalid symbol")
    return Note.model_validate(state.db.save_note(sym, body.body))


@router.get("/bt/scripts", response_model=BtScriptsResponse, tags=["backtest"])
def bt_scripts(state: StateDep) -> BtScriptsResponse:
    return list_scripts(state.settings.research_dir)


@router.post("/bt/run", response_model=BtRunResponse, tags=["backtest"])
async def bt_run(body: BtRunRequest, state: StateDep) -> BtRunResponse:
    s = state.settings
    return await run_script(
        s.research_dir, body.script, body.args, f"http://127.0.0.1:{s.port}", s.token
    )
