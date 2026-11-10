"""Application-wide state container stored on `app.state.ndx`."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from fastapi import Request

from .config import Settings
from .db import Database
from .markets import MarketClock
from .providers.router import ProviderRouter


@dataclass
class AppState:
    settings: Settings
    db: Database
    router: ProviderRouter
    markets: MarketClock
    log_path: Path
    started_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    services: dict[str, Any] = field(default_factory=dict)
    # DEMO only: the real providers, listed as disabled in the status bar and PROV.
    offline_providers: list[Any] = field(default_factory=list)


def get_state(request: Request) -> AppState:
    state: AppState = request.app.state.ndx
    return state
