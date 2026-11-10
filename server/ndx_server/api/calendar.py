"""Exchange calendars (SPEC §8 `CDR`) and the session state of instruments (WEI, MON)."""

from __future__ import annotations

import asyncio
import time
from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Query

from ..models import (
    CalendarResponse,
    Latency,
    Meta,
    SessionStateItem,
    SessionStatesResponse,
)
from ..symbols import SymbolError, classify
from ..venues import SOURCE, state_for, venue_info, venues

router = APIRouter(tags=["calendar"])
# Hours and holidays do not tick: the table is rebuilt at most once a minute (state, countdowns).
CALENDAR_TTL_S = 60.0
_cache: tuple[float, CalendarResponse] | None = None


def _meta(now: datetime) -> Meta:
    return Meta(
        source=SOURCE,
        latency=Latency.STATIC,
        as_of=now,
        fetched_at=now,
        stale_after_s=2 * CALENDAR_TTL_S,
        note="hours, holidays and early closes as the library's exchange rules state them",
    )


def build_calendar(now: datetime) -> CalendarResponse:
    return CalendarResponse(meta=_meta(now), venues=[venue_info(v, now) for v in venues()])


@router.get("/calendar", response_model=CalendarResponse)
async def calendar() -> CalendarResponse:
    global _cache
    if _cache is not None and time.monotonic() - _cache[0] < CALENDAR_TTL_S:
        return _cache[1]
    res = await asyncio.to_thread(build_calendar, datetime.now(UTC))
    _cache = (time.monotonic(), res)
    return res


def session_states(symbols: list[str], now: datetime) -> SessionStatesResponse:
    items: list[SessionStateItem] = []
    for raw in symbols:
        try:
            inst = classify(raw)
        except SymbolError as exc:
            items.append(SessionStateItem(symbol=raw, error=str(exc)))
            continue
        v, state, nxt = state_for(inst, now)
        items.append(
            SessionStateItem(
                symbol=raw,
                venue=v.code if v else None,
                venue_name=v.name if v else None,
                state=state,
                next_change=nxt,
            )
        )
    return SessionStatesResponse(meta=_meta(now), items=items)


@router.get("/calendar/state", response_model=SessionStatesResponse)
async def states(
    symbols: Annotated[str, Query(max_length=4000, description="Comma-separated symbols")],
) -> SessionStatesResponse:
    """Session state per instrument from its venue's calendar; a symbol whose venue is unknown
    has state null (N.A.)."""
    wanted = [s.strip() for s in symbols.split(",") if s.strip()][:200]
    return await asyncio.to_thread(session_states, wanted, datetime.now(UTC))
