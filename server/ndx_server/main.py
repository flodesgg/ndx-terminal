"""FastAPI application factory and CLI entrypoint."""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import logging
import os
import sys
import tempfile
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from . import __version__
from .alerts import AlertEngine
from .api import alerts as alerts_api
from .api import calendar as calendar_api
from .api import market as market_api
from .api import phase4, system, watchlists, ws
from .api import research as research_api
from .api import secmaster as secmaster_api
from .api.errors import router_error_handler, symbol_error_handler
from .barstore import BarStore
from .config import Settings, default_data_dir, get_settings
from .db import Database
from .demo import NOW as DEMO_NOW
from .eco import EcoService
from .live import LiveHub
from .logging_setup import setup_logging
from .market import MarketService
from .markets import MarketClock
from .migrate_symbols import migrate_user_db
from .news import NewsService
from .portfolio import PortfolioService
from .providers.base import DataProvider
from .providers.cache import TTLCache
from .providers.finnhub_ws import FinnhubFeed
from .providers.network import NetworkMonitor
from .providers.registry import PREFERENCES, build_providers, demo_offline_statuses
from .providers.router import ProviderRouter, RouterError
from .providers.rss import RssProvider
from .providers.tiingo_ws import TiingoFeed
from .research import ResearchService
from .secmaster import symbology
from .secrets_store import secret_values
from .security import (
    TOKEN_HEADER,
    BodyLimitMiddleware,
    GuardMiddleware,
    allowed_origins,
    validate_token,
)
from .seeds import SeedStore
from .state import AppState
from .symbols import SymbolError

log = logging.getLogger("ndx.main")


async def _watch_parent(pid: int) -> None:
    """Exit when the parent (Tauri shell) dies so no orphaned sidecar is left behind."""
    while True:
        await asyncio.sleep(2)
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            log.warning("parent process %s gone; exiting", pid)
            os._exit(0)
        except PermissionError:
            pass


def create_app(
    settings: Settings | None = None,
    providers: list[DataProvider] | None = None,
    start_background: bool = True,
) -> FastAPI:
    settings = settings or get_settings()
    validate_token(settings.token)
    if settings.demo and settings.data_dir == default_data_dir():
        # DEMO never touches the user's real data folder (user.db, bar cache).
        settings.data_dir = Path(tempfile.mkdtemp(prefix="ndx-demo-"))
    settings.ensure_dirs()
    log_path = setup_logging(settings.log_dir, secrets=secret_values(settings))
    db = Database(settings.data_dir / "user.db")
    # Security master (SPEC §5): learned share-class maps, then the one-time migration of stored
    # symbols to canonical IDs (backup of user.db first, report in <data>/migrations/).
    sm = symbology()
    learned = db.symbol_map()
    bad = [k for k, v in learned.items() if not sm.valid_learned(k, v)]
    if bad:  # wrong mappings stored by older builds (`AAPL US` <-> `aapl`): forget them
        log.warning("dropping %d invalid learned symbol mappings: %s", len(bad), bad)
        db.delete_symbol_map(bad)
    sm.add_learned(learned)
    migrate_user_db(db, settings.data_dir, sm)
    if settings.demo and providers is None:
        from .demo import DemoProvider

        # DEMO: fixtures only, no network providers at all (SPEC §1.2).
        providers = [DemoProvider()]
        log.warning("DEMO mode: deterministic fixtures only, no live data")
    network = None
    demo_net = [p for p in (providers or []) if p.demo]
    if settings.demo and demo_net:
        # DEMO: "the network" is the fixture provider's E2E switch; probe it often.
        async def demo_probe() -> bool:
            return all(getattr(p, "network_up", True) for p in demo_net)

        network = NetworkMonitor(probe=demo_probe, base_s=0.5, cap_s=2.0)
    router = ProviderRouter(
        providers if providers is not None else build_providers(settings),
        cache=TTLCache(),
        preferences=PREFERENCES,
        network=network,
    )
    state = AppState(
        settings=settings, db=db, router=router, markets=MarketClock(), log_path=log_path
    )
    if settings.demo and any(p.demo for p in router.providers):
        state.offline_providers = demo_offline_statuses(settings)
    market = MarketService(router, BarStore(settings.data_dir / "bars.duckdb"))
    hub = LiveHub(market, stream_crypto=not settings.demo)
    state.services["market"] = market
    state.services["live"] = hub
    if hub.stream_crypto:  # DEMO mode has no network feeds to report
        state.services["binance_ws"] = hub.binance
        if settings.finnhub_api_key:  # US live primary: trade prints, 50 symbols (§6.2)
            hub.add_feed(FinnhubFeed(settings.finnhub_api_key))
        if settings.tiingo_api_key:  # US live secondary: what Finnhub cannot carry (§6.2)
            hub.add_feed(TiingoFeed(settings.tiingo_api_key, settings.data_dir))
    state.services["research"] = ResearchService(
        router, Path.home() / "Downloads" / settings.app_name
    )
    state.services["alerts"] = AlertEngine(db, market, hub)
    rss = next((p for p in router.providers if isinstance(p, RssProvider)), None)
    state.services["news"] = NewsService(
        db,
        market,
        hub,
        rss=rss,
        env_feeds=settings.rss_feed_list,
        now=DEMO_NOW if settings.demo and any(p.demo for p in router.providers) else None,
    )
    state.services["eco"] = EcoService(
        router, now=DEMO_NOW if settings.demo and any(p.demo for p in router.providers) else None
    )
    state.services["portfolio"] = PortfolioService(db, market)
    if not settings.demo:  # third-party seeds: downloaded at runtime, never in DEMO
        state.services["seeds"] = SeedStore(settings.data_dir, settings.edgar_user_agent)
    # Opt-in sources (yfinance) stay off unless the user enabled them in PDF.
    system.apply_opt_in(state, system.load_opt_in(state))

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        log.info(
            "%s server %s starting (data=%s)", settings.app_name, __version__, settings.data_dir
        )
        tasks: list[asyncio.Task[None]] = []
        if settings.parent_pid:
            tasks.append(asyncio.create_task(_watch_parent(settings.parent_pid)))
        if start_background:
            for svc in state.services.values():
                start = getattr(svc, "start", None)
                if callable(start):
                    await start()
        try:
            yield
        finally:
            for t in tasks:
                t.cancel()
            for svc in state.services.values():
                stop = getattr(svc, "stop", None)
                if callable(stop):
                    with contextlib.suppress(Exception):
                        await stop()
            await router.aclose()
            log.info("server stopped")

    app = FastAPI(
        title=f"{settings.app_name} API",
        version=__version__,
        lifespan=lifespan,
        # API docs only in dev; the schema is still generated offline by scripts/gen-types.sh.
        docs_url="/docs" if settings.dev else None,
        redoc_url=None,
        openapi_url="/openapi.json" if settings.dev else None,
    )
    app.state.ndx = state
    app.add_exception_handler(RouterError, router_error_handler)
    app.add_exception_handler(SymbolError, symbol_error_handler)

    app.add_middleware(
        CORSMiddleware,
        allow_origins=sorted(allowed_origins(settings.dev)),
        allow_methods=["GET", "POST", "PUT", "DELETE"],
        allow_headers=[TOKEN_HEADER, "content-type"],
    )
    # Bodies that store user state are capped on their bytes, before parsing (review 1b #17).
    app.add_middleware(
        BodyLimitMiddleware,
        max_bytes=system.MAX_SESSION_BYTES,
        prefixes=("/session", "/settings/", "/layouts/"),
    )
    # Added last = outermost: Host/Origin/token are checked before CORS and routing.
    app.add_middleware(GuardMiddleware, token=settings.token, port=settings.port, dev=settings.dev)
    app.include_router(system.router)
    app.include_router(market_api.router)
    app.include_router(watchlists.router)
    app.include_router(ws.router)
    app.include_router(research_api.router)
    app.include_router(alerts_api.router)
    app.include_router(phase4.router)
    app.include_router(secmaster_api.router)
    app.include_router(calendar_api.router)
    _install_openapi(app)
    return app


def _install_openapi(app: FastAPI) -> None:
    """Include every model from `models.py` in the schema so shared TS types never drift."""
    import inspect

    from fastapi.openapi.utils import get_openapi
    from pydantic import BaseModel
    from pydantic.json_schema import models_json_schema

    from . import models

    def custom() -> dict[str, object]:
        if app.openapi_schema:
            return app.openapi_schema
        spec = get_openapi(title=app.title, version=app.version, routes=app.routes)
        all_models = [
            m
            for _, m in inspect.getmembers(models, inspect.isclass)
            if issubclass(m, BaseModel)
            and m.__module__ == models.__name__
            and m is not models.BaseModel
        ]
        _, defs = models_json_schema(
            [(m, "serialization") for m in all_models],
            ref_template="#/components/schemas/{model}",
        )
        schemas = spec.setdefault("components", {}).setdefault("schemas", {})
        for name, schema in defs.get("$defs", {}).items():
            schemas.setdefault(name, schema)
        app.openapi_schema = spec
        return spec

    app.openapi = custom  # type: ignore[method-assign]


def cli() -> None:
    parser = argparse.ArgumentParser(description="NDX Terminal data server")
    parser.add_argument("--port", type=int, default=None, help="required (or NDX_PORT)")
    parser.add_argument(
        "--token-stdin",
        action="store_true",
        help="read the per-launch token from the first line of stdin (packaged app)",
    )
    parser.add_argument("--parent-pid", type=int, default=None)
    parser.add_argument("--reload", action="store_true")
    args = parser.parse_args()
    # The token never travels in argv (visible to every local user via `ps`): the packaged
    # shell writes it to stdin, `make dev` passes it in the environment.
    if args.port is not None:
        os.environ["NDX_PORT"] = str(args.port)
    if args.parent_pid is not None:
        os.environ["NDX_PARENT_PID"] = str(args.parent_pid)
    settings = get_settings()
    if args.token_stdin:
        settings.token = sys.stdin.readline().strip()
    if not settings.port:
        sys.exit("no port: pass --port or NDX_PORT (the launcher picks a random free port)")
    try:
        validate_token(settings.token)
    except ValueError as exc:
        sys.exit(str(exc))

    import uvicorn

    if args.reload:
        if args.token_stdin:
            sys.exit("--reload needs NDX_TOKEN in the environment (worker processes re-read it)")
        uvicorn.run(
            "ndx_server.main:app_factory",
            factory=True,
            host="127.0.0.1",
            port=settings.port,
            reload=True,
            log_config=None,
        )
    else:
        uvicorn.run(
            create_app(settings),
            host="127.0.0.1",
            port=settings.port,
            log_config=None,
            ws_ping_interval=20,
        )


def app_factory() -> FastAPI:
    return create_app()


if __name__ == "__main__":
    cli()
