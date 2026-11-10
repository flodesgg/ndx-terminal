"""Network reachability (SPEC §6.3 offline): OFFLINE in the status bar, automatic reconnect.

The machine counts as offline after `threshold` consecutive connection failures (DNS,
connect refused/timed out) with no success in between. While offline the router makes no
provider requests and serves cached copies as STALE; a probe retries with exponential backoff
and jitter, and the first success (probe or any provider call) brings the app back online.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime

from .backoff import backoff_delay

log = logging.getLogger("ndx.network")

# Hosts the default providers already talk to; the probe only opens a TCP connection.
PROBE_HOSTS: tuple[tuple[str, int], ...] = (
    ("api.binance.com", 443),
    ("www.sec.gov", 443),
    ("home.treasury.gov", 443),
)


async def tcp_probe() -> bool:
    for host, port in PROBE_HOSTS:
        try:
            _, writer = await asyncio.wait_for(asyncio.open_connection(host, port), 3.0)
        except (OSError, TimeoutError):
            continue
        writer.close()
        with contextlib.suppress(Exception):
            await writer.wait_closed()
        return True
    return False


class NetworkMonitor:
    def __init__(
        self,
        probe: Callable[[], Awaitable[bool]] | None = None,
        threshold: int = 2,
        base_s: float = 1.0,
        cap_s: float = 60.0,
    ) -> None:
        self.probe = probe or tcp_probe
        self.threshold = threshold
        self.base_s = base_s
        self.cap_s = cap_s
        self.offline = False
        self.since: datetime | None = None
        self.failures = 0
        self.last_error: str | None = None
        self.next_probe_at: float | None = None
        self._task: asyncio.Task[None] | None = None

    def ok(self) -> None:
        self.failures = 0
        if self.offline:
            self._online()

    def failure(self, exc: BaseException) -> None:
        self.failures += 1
        self.last_error = f"{type(exc).__name__}: {exc}"[:300]
        if self.offline or self.failures < self.threshold:
            return
        self.offline, self.since = True, datetime.now(UTC)
        log.warning("network unreachable (%s): OFFLINE, serving cached data", self.last_error)
        try:
            asyncio.get_running_loop()
        except RuntimeError:
            return  # no event loop (sync tests): nothing to probe from
        if self._task is None or self._task.done():
            self._task = asyncio.create_task(self._probe_loop(), name="network-probe")

    def _online(self) -> None:
        log.warning("network back after %s: online", self.since)
        self.offline, self.since, self.next_probe_at = False, None, None
        self.failures = 0

    def reconnect_in(self) -> float | None:
        if not self.offline or self.next_probe_at is None:
            return None
        return max(0.0, self.next_probe_at - time.monotonic())

    async def _probe_loop(self) -> None:
        attempt = 0
        while self.offline:
            delay = backoff_delay(attempt, self.base_s, self.cap_s)
            self.next_probe_at = time.monotonic() + delay
            await asyncio.sleep(delay)
            attempt += 1
            try:
                up = await self.probe()
            except Exception as exc:  # a broken probe must not end the loop
                log.debug("network probe failed: %s", exc)
                up = False
            if up and self.offline:
                self._online()

    async def stop(self) -> None:
        if self._task is not None:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await self._task
            self._task = None
