"""Health, provider status, exchange clock, logs, layouts and command history."""

from __future__ import annotations

import json
import logging
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query

from .. import __version__
from ..logging_setup import tail
from ..models import (
    ClientLog,
    DemoNetwork,
    ExchangeStatus,
    Health,
    HistoryEntry,
    Layout,
    LogResponse,
    OptInProviders,
    ProviderStatus,
    SessionState,
)
from ..providers.yahoo import OPT_IN_SCOPES, YahooProvider
from ..state import AppState, get_state

router = APIRouter()
client_log = logging.getLogger("ndx.client")
StateDep = Annotated[AppState, Depends(get_state)]


@router.get("/health", response_model=Health, tags=["system"])
def health(state: StateDep) -> Health:
    net = state.router.network
    return Health(
        status="ok",
        demo=state.settings.demo,
        app=state.settings.app_name,
        version=__version__,
        started_at=state.started_at,
        network="offline" if net.offline else "online",
        offline_since=net.since,
        reconnect_in_s=net.reconnect_in(),
    )


@router.get("/providers", response_model=list[ProviderStatus], tags=["system"])
def providers(state: StateDep) -> list[ProviderStatus]:
    out: list[ProviderStatus] = state.router.statuses()
    for extra in state.services.values():
        status = getattr(extra, "status", None)
        if callable(status):
            out.append(status())
    # backend-owned provider streams of the hub (symbol caps shown as quota)
    out.extend(f.status() for f in getattr(state.services.get("live"), "feeds", []))
    return out + state.offline_providers


@router.put("/demo/network", response_model=DemoNetwork, tags=["system"])
def demo_network(value: DemoNetwork, state: StateDep) -> DemoNetwork:
    """DEMO only (404 otherwise): cut or restore the fixture providers' network, so E2E can
    check OFFLINE, STALE and the automatic reconnect (SPEC §13 step 9)."""
    if not state.settings.demo:
        raise HTTPException(status_code=404, detail="Not Found")
    for p in state.router.providers:
        if p.demo:
            p.network_up = value.up  # type: ignore[attr-defined]
    return value


OPT_IN_KEY = "providers.opt_in"
# OptInProviders field -> provider name
OPT_IN_NAMES = {"yfinance": "yahoo"}


def load_opt_in(state: AppState) -> OptInProviders:
    raw = state.db.get_setting(OPT_IN_KEY)
    try:
        return OptInProviders.model_validate(raw or {})
    except ValueError:
        return OptInProviders()


def apply_opt_in(state: AppState, value: OptInProviders) -> None:
    yahoo = state.router.by_name.get("yahoo")
    if isinstance(yahoo, YahooProvider):
        scope = None if value.yfinance_scope == "all" else OPT_IN_SCOPES[value.yfinance_scope]
        if scope != yahoo.scope:
            yahoo.set_scope(scope)
            state.router.cache.invalidate()  # values outside a narrower scope must not linger
    for field, name in OPT_IN_NAMES.items():
        state.router.set_opt_in(name, bool(getattr(value, field)))


@router.get("/providers/opt-in", response_model=OptInProviders, tags=["system"])
def get_opt_in(state: StateDep) -> OptInProviders:
    return load_opt_in(state)


@router.put("/providers/opt-in", response_model=OptInProviders, tags=["system"])
def put_opt_in(value: OptInProviders, state: StateDep) -> OptInProviders:
    state.db.set_setting(OPT_IN_KEY, value.model_dump())
    apply_opt_in(state, value)
    return value


@router.get("/markets", response_model=list[ExchangeStatus], tags=["system"])
def markets(state: StateDep) -> list[ExchangeStatus]:
    return state.markets.status()


@router.get("/logs", response_model=LogResponse, tags=["system"])
def logs(state: StateDep, lines: Annotated[int, Query(ge=1, le=5000)] = 500) -> LogResponse:
    return LogResponse(path=str(state.log_path), lines=tail(state.log_path, lines))


@router.post("/logs/client", status_code=204, tags=["system"])
def post_client_log(entry: ClientLog) -> None:
    level = {
        "debug": logging.DEBUG,
        "info": logging.INFO,
        "warn": logging.WARNING,
        "error": logging.ERROR,
    }[entry.level]
    client_log.log(level, entry.message[:2000])


@router.get("/layouts", response_model=list[Layout], tags=["user"])
def list_layouts(state: StateDep) -> list[Layout]:
    return [Layout.model_validate(x) for x in state.db.list_layouts()]


@router.get("/layouts/{name}", response_model=Layout, tags=["user"])
def get_layout(name: str, state: StateDep) -> Layout:
    row = state.db.get_layout(name)
    if row is None:
        raise HTTPException(404, f"layout {name!r} not found")
    return Layout.model_validate(row)


@router.put("/layouts/{name}", status_code=204, tags=["user"])
def put_layout(name: str, layout: Layout, state: StateDep) -> None:
    if not name.strip() or len(name) > 64:
        raise HTTPException(400, "invalid layout name")
    state.db.save_layout(name, layout.tree)


@router.delete("/layouts/{name}", status_code=204, tags=["user"])
def delete_layout(name: str, state: StateDep) -> None:
    if not state.db.delete_layout(name):
        raise HTTPException(404, f"layout {name!r} not found")


# The session is a few KB; a cap keeps a runaway client from filling user.db.
MAX_SESSION_BYTES = 1_000_000


@router.get("/session", response_model=SessionState, tags=["user"])
def get_session(state: StateDep) -> SessionState:
    return SessionState(state=state.db.get_session())


@router.put("/session", status_code=204, tags=["user"])
def put_session(body: SessionState, state: StateDep) -> None:
    if body.state is None:
        raise HTTPException(400, "state required")
    if len(json.dumps(body.state)) > MAX_SESSION_BYTES:
        raise HTTPException(413, "session too large")
    state.db.set_session(body.state)


@router.delete("/session", status_code=204, tags=["user"])
def delete_session(state: StateDep) -> None:
    state.db.delete_session()


@router.get("/history", response_model=list[HistoryEntry], tags=["user"])
def get_history(state: StateDep) -> list[HistoryEntry]:
    return [HistoryEntry.model_validate(x) for x in state.db.history()]


@router.post("/history", status_code=204, tags=["user"])
def post_history(entry: HistoryEntry, state: StateDep) -> None:
    cmd = entry.command.strip()
    if cmd:
        state.db.add_history(cmd[:200])


@router.get("/settings/{key}", tags=["user"])
def get_setting(key: str, state: StateDep) -> object:
    return state.db.get_setting(key)


@router.put("/settings/{key}", status_code=204, tags=["user"])
def put_setting(key: str, value: dict[str, object], state: StateDep) -> None:
    state.db.set_setting(key, value)
