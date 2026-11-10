"""Third-party seed files, downloaded on first run into the data folder (SPEC §5, PROVIDERS P9).

Never committed to git: several sources forbid storing or redistributing copies (Nasdaq Trader
allows one unaltered personal copy). Each file is refreshed when older than its TTL; a failed
download keeps the previous copy and reports the error. Nothing here runs in DEMO mode or tests.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import httpx

from .models import SeedStatus
from .providers.http import make_client

log = logging.getLogger("ndx.seeds")


@dataclass(frozen=True)
class SeedSpec:
    name: str
    url: str
    filename: str
    ttl: timedelta
    terms: str
    needs_sec_ua: bool = False


SEEDS: tuple[SeedSpec, ...] = (
    SeedSpec(
        "sec_company_tickers",
        "https://www.sec.gov/files/company_tickers.json",
        "sec_company_tickers.json",
        timedelta(days=7),
        "SEC EDGAR, public; descriptive User-Agent required",
        needs_sec_ua=True,
    ),
    SeedSpec(
        "nasdaq_listed",
        "https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqlisted.txt",
        "nasdaqlisted.txt",
        timedelta(days=1),
        "Nasdaq Trader: one unaltered personal copy; no redistribution",
    ),
    SeedSpec(
        "nasdaq_other",
        "https://www.nasdaqtrader.com/dynamic/SymDir/otherlisted.txt",
        "otherlisted.txt",
        timedelta(days=1),
        "Nasdaq Trader: one unaltered personal copy; no redistribution",
    ),
    SeedSpec(
        "binance_exchange_info",
        "https://api.binance.com/api/v3/exchangeInfo?permissions=SPOT",
        "binance_exchange_info.json",
        timedelta(days=1),
        "Binance public market data",
    ),
)


class SeedStore:
    def __init__(self, data_dir: Path, sec_user_agent: str = "") -> None:
        self.dir = data_dir / "seeds"
        self.sec_user_agent = sec_user_agent
        self.errors: dict[str, str] = {}
        self._task: asyncio.Task[None] | None = None

    def path(self, spec: SeedSpec) -> Path:
        return self.dir / spec.filename

    def _meta_path(self, spec: SeedSpec) -> Path:
        return self.dir / f"{spec.filename}.meta.json"

    def meta(self, spec: SeedSpec) -> dict[str, Any] | None:
        try:
            data: dict[str, Any] = json.loads(self._meta_path(spec).read_text())
            return data
        except (OSError, ValueError):
            return None

    def due(self, spec: SeedSpec, now: datetime) -> bool:
        m = self.meta(spec)
        if m is None or not self.path(spec).exists():
            return True
        return now - datetime.fromisoformat(m["fetched_at"]) >= spec.ttl

    async def fetch(self, spec: SeedSpec, client: httpx.AsyncClient) -> None:
        headers = {}
        if spec.needs_sec_ua:
            if not self.sec_user_agent:
                self.errors[spec.name] = "skipped: EDGAR_USER_AGENT not set"
                return
            headers["User-Agent"] = self.sec_user_agent
        try:
            r = await client.get(spec.url, headers=headers)
            r.raise_for_status()
        except httpx.HTTPError as exc:
            self.errors[spec.name] = f"{type(exc).__name__}: {exc}"[:200]
            log.warning("seed %s failed: %s", spec.name, self.errors[spec.name])
            return
        self.dir.mkdir(parents=True, exist_ok=True)
        tmp = self.path(spec).with_suffix(".part")
        tmp.write_bytes(r.content)
        tmp.replace(self.path(spec))  # atomic: readers never see a half-written file
        meta = {
            "url": spec.url,
            "fetched_at": datetime.now(UTC).isoformat(),
            "bytes": len(r.content),
            "sha256": hashlib.sha256(r.content).hexdigest(),
            "terms": spec.terms,
        }
        self._meta_path(spec).write_text(json.dumps(meta, indent=1))
        self.errors.pop(spec.name, None)
        log.info("seed %s refreshed (%d bytes)", spec.name, len(r.content))

    async def refresh_due(self, client: httpx.AsyncClient | None = None) -> None:
        now = datetime.now(UTC)
        own = client is None
        c = client or make_client(timeout=30)
        try:
            for spec in SEEDS:
                if self.due(spec, now):
                    await self.fetch(spec, c)
        finally:
            if own:
                await c.aclose()

    def seed_status(self) -> list[SeedStatus]:  # not `status`: /providers collects those
        out = []
        for spec in SEEDS:
            m = self.meta(spec) or {}
            out.append(
                SeedStatus(
                    name=spec.name,
                    url=spec.url,
                    present=self.path(spec).exists(),
                    fetched_at=m.get("fetched_at"),
                    bytes=m.get("bytes"),
                    ttl_hours=spec.ttl.total_seconds() / 3600,
                    terms=spec.terms,
                    error=self.errors.get(spec.name),
                )
            )
        return out

    # Lifecycle hooks used by the app (start/stop pattern of the other services).
    async def start(self) -> None:
        self._task = asyncio.create_task(self._loop(), name="seeds")

    async def _loop(self, every_s: float = 3600.0) -> None:
        """Refresh what is due now, then hourly: each seed is re-fetched once its TTL has run
        out, also in an app that stays open for days (SPEC §5 "refreshed per TTL")."""
        while True:
            try:
                await self.refresh_due()
            except Exception as e:  # a failed round must not end the loop
                log.warning("seed refresh failed: %s", type(e).__name__)
            await asyncio.sleep(every_s)

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
