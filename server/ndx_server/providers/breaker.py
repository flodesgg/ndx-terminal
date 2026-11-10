"""Circuit breaker per provider (SPEC §6.3): open after N failures, half-open probe.

closed -> (threshold consecutive failures) -> open -> (reset_after_s) -> half_open: one probe
request is let through; success closes the circuit, failure re-opens it with a doubled wait
(capped). While open, the router skips the provider and falls back to the next one.
"""

from __future__ import annotations

import time
from collections.abc import Callable
from typing import Literal

BreakerState = Literal["closed", "open", "half_open"]


class CircuitBreaker:
    def __init__(
        self,
        threshold: int = 5,
        reset_after_s: float = 30.0,
        max_reset_s: float = 300.0,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.threshold = threshold
        self.reset_after_s = reset_after_s
        self.max_reset_s = max_reset_s
        self.clock = clock
        self.state: BreakerState = "closed"
        self.failures = 0
        self.wait_s = reset_after_s
        self._since = 0.0  # opened at (open) / probe started at (half_open)

    def allow(self) -> bool:
        if self.state == "closed":
            return True
        now = self.clock()
        if now - self._since >= self.wait_s:
            # open long enough, or a probe that never reported back: (another) probe
            self.state, self._since = "half_open", now
            return True
        return False

    def retry_in(self) -> float:
        if self.state == "closed":
            return 0.0
        return max(0.0, self.wait_s - (self.clock() - self._since))

    def success(self) -> None:
        self.state, self.failures, self.wait_s = "closed", 0, self.reset_after_s

    def failure(self) -> None:
        if self.state == "half_open":
            self.wait_s = min(self.max_reset_s, self.wait_s * 2)
            self.state, self._since = "open", self.clock()
            return
        self.failures += 1
        if self.state == "closed" and self.failures >= self.threshold:
            self.state, self._since = "open", self.clock()
