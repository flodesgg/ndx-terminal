"""Price / percent-change alerts evaluated in the background against live quotes."""

from __future__ import annotations

import asyncio
import contextlib
import logging
from datetime import UTC, datetime
from typing import TYPE_CHECKING

from .models import Alert, LiveAlert, Quote

if TYPE_CHECKING:  # pragma: no cover
    from .db import Database
    from .live import LiveHub
    from .market import MarketService

log = logging.getLogger("ndx.alerts")


def is_triggered(alert: Alert, q: Quote) -> bool:
    if alert.kind in ("above", "below"):
        if q.price is None:
            return False
        return q.price >= alert.threshold if alert.kind == "above" else q.price <= alert.threshold
    if q.change_pct is None:
        return False
    if alert.kind == "pct_above":
        return q.change_pct >= alert.threshold
    return q.change_pct <= alert.threshold


def describe(alert: Alert) -> str:
    return {
        "above": f"{alert.symbol} ≥ {alert.threshold:g}",
        "below": f"{alert.symbol} ≤ {alert.threshold:g}",
        "pct_above": f"{alert.symbol} day change ≥ {alert.threshold:+g}%",
        "pct_below": f"{alert.symbol} day change ≤ {alert.threshold:+g}%",
    }[alert.kind]


class AlertEngine:
    def __init__(
        self, db: Database, market: MarketService, hub: LiveHub, interval: float = 10.0
    ) -> None:
        self.db = db
        self.market = market
        self.hub = hub
        self.interval = interval
        self._task: asyncio.Task[None] | None = None
        self.last_run: datetime | None = None
        self.last_error: str | None = None

    async def start(self) -> None:
        self._task = asyncio.create_task(self._loop(), name="alerts")

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await self._task

    async def check_once(self) -> list[Alert]:
        active = [Alert.model_validate(a) for a in self.db.list_alerts() if a["active"]]
        if not active:
            return []
        res = await self.market.quotes(sorted({a.symbol for a in active}))
        items = {i.symbol: i for i in res.items}
        fired: list[Alert] = []
        for a in active:
            item = items.get(a.symbol)
            if item is None or item.data is None or item.meta is None:
                continue
            if not is_triggered(a, item.data):
                continue
            updated = self.db.trigger_alert(a.id, item.data.price)
            if updated is None:
                continue
            alert = Alert.model_validate(updated)
            fired.append(alert)
            log.info(
                "alert fired: %s at %s (%s)", describe(alert), item.data.price, item.meta.source
            )
            msg = LiveAlert(
                type="alert",
                alert=alert,
                price=item.data.price,
                change_pct=item.data.change_pct,
                meta=item.meta,
            )
            self.hub.broadcast_raw(msg.model_dump_json())
        return fired

    async def _loop(self) -> None:
        while True:
            try:
                await self.check_once()
                self.last_error = None
            except Exception as exc:
                self.last_error = str(exc)
                log.warning("alert check failed: %s", exc)
            self.last_run = datetime.now(UTC)
            await asyncio.sleep(self.interval)
