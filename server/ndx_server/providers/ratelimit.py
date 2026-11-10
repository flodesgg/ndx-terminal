"""Async token-bucket rate limiter (one per provider) with a quota counter for PROV."""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass

PERIOD_LABELS = {1.0: "s", 60.0: "min", 3600.0: "hour", 86400.0: "day"}
# A queued request that does not come back within this long after its turn loses its place
# (the window was closed): its token is spent, later turns are not held up.
QUEUE_GRACE_S = 30.0
# How long a request may queue for a provider's tokens before it gives up (LocalRateLimited):
# up to a minute of the budget, so a burst (WEI's 48 index bar requests on Yahoo's 60/min)
# is served in turn rather than refused. Refusals known without a request take no token
# (`DataProvider.serves`), so nothing queues behind them (review 2 B, real run 2026-11-10).
PATIENCE_S = 60.0
# ...but a busy plain budget hands the request to the next source after this long.
FALL_THROUGH_S = 3.0
# A turn this close is taken now (the client's timer fires a little early or late).
CLAIM_SLACK_S = 0.5


@dataclass(frozen=True)
class Quota:
    limit: int
    period: str
    used: int
    left: int


class TokenBucket:
    """`rate` tokens per second, bursting up to `capacity`.

    `limit`/`period_s` describe the budget it enforces; `quota()` counts the tokens actually
    taken in the current window (UTC-aligned: a daily budget resets at 00:00 UTC)."""

    def __init__(
        self,
        rate: float,
        capacity: float | None = None,
        *,
        limit: float | None = None,
        period_s: float = 1.0,
    ) -> None:
        if rate <= 0:
            raise ValueError("rate must be positive")
        self.rate = rate
        self.capacity = capacity if capacity is not None else max(1.0, rate)
        self.limit = limit if limit is not None else rate * period_s
        self.period_s = period_s
        self._tokens = self.capacity
        self._updated = time.monotonic()
        self._lock = asyncio.Lock()
        self._window = 0.0
        self._used = 0
        self._held: dict[str, float] = {}  # queued request key -> monotonic time of its turn

    @classmethod
    def per_minute(cls, n: float, burst: float | None = None) -> TokenBucket:
        return cls.from_budget(n, 60.0, burst if burst is not None else max(1.0, n / 6))

    @classmethod
    def from_budget(cls, limit: float, period_s: float, burst: float | None = None) -> TokenBucket:
        if burst is None:
            # long windows (hour, day): the whole budget may go at once (e.g. after the close)
            burst = limit if period_s >= 3600 else max(1.0, limit / 6)
        return cls(limit / period_s, burst, limit=limit, period_s=period_s)

    def _refill(self, now: float) -> None:
        elapsed = now - self._updated
        self._updated = now
        self._tokens = min(self.capacity, self._tokens + elapsed * self.rate)

    def _count(self) -> None:
        start = (time.time() // self.period_s) * self.period_s
        if start != self._window:
            self._window, self._used = start, 0
        self._used += 1

    def quota(self) -> Quota:
        start = (time.time() // self.period_s) * self.period_s
        used = self._used if start == self._window else 0
        limit = int(self.limit)
        label = PERIOD_LABELS.get(self.period_s, f"{self.period_s:g}s")
        return Quota(limit=limit, period=label, used=used, left=max(0, limit - used))

    def wait_time(self) -> float:
        """Seconds until one token is available (0 if available now)."""
        self._refill(time.monotonic())
        if self._tokens >= 1:
            return 0.0
        return (1 - self._tokens) / self.rate

    async def acquire(self, max_wait: float = 5.0) -> bool:
        """Take one token, waiting up to `max_wait` s. False if it would wait longer."""
        async with self._lock:
            self._refill(time.monotonic())
            if self._tokens >= 1:
                self._tokens -= 1
                self._count()
                return True
            # The wait includes the turns already handed out (a debt), so `max_wait` bounds
            # the whole queue: a caller never sleeps behind 25 others for half a minute.
            needed = (1 - self._tokens) / self.rate
            if needed > max_wait:
                return False
            # Take the turn now (no clamp at 0: the debt orders later callers), then wait for
            # it outside the lock (review 2 B: sleeping under the lock serialised every caller
            # and made `max_wait` meaningless).
            self._tokens -= 1
            self._count()
        await asyncio.sleep(needed)
        return True

    # ----- queue (a request that may come back later, e.g. a chart window) -----

    def reserve(self, key: str, max_wait: float) -> float | None:
        """A place in the queue for `key`: seconds until its turn. The token is taken now
        (the bucket goes into debt), so later callers queue behind it, first come first
        served. None if the turn is more than `max_wait` away (no place is taken)."""
        now = time.monotonic()
        self._expire(now)
        due = self._held.get(key)
        if due is not None:
            return max(0.0, due - now)
        self._refill(now)
        wait = 0.0 if self._tokens >= 1 else (1 - self._tokens) / self.rate
        if wait > max_wait:
            return None
        self._tokens -= 1
        self._held[key] = now + wait
        return wait

    def claim(self, key: str) -> float | None:
        """None: `key` holds no place. 0: its turn has come and the token is its own (taken
        at `reserve`). Otherwise the seconds still to wait."""
        now = time.monotonic()
        self._expire(now)
        due = self._held.get(key)
        if due is None:
            return None
        if due - now > CLAIM_SLACK_S:
            return due - now
        del self._held[key]
        self._count()
        return 0.0

    def queued(self) -> int:
        self._expire(time.monotonic())
        return len(self._held)

    def _expire(self, now: float) -> None:
        for key in [k for k, due in self._held.items() if due + QUEUE_GRACE_S < now]:
            del self._held[key]
