"""In-memory TTL cache with single-flight (concurrent identical requests share one fetch)."""

from __future__ import annotations

import asyncio
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any


@dataclass(slots=True)
class CacheEntry:
    value: Any
    stored_at: float
    ttl: float

    def fresh(self, now: float) -> bool:
        return now - self.stored_at < self.ttl


class TTLCache:
    def __init__(self, max_entries: int = 5000) -> None:
        self._data: dict[str, CacheEntry] = {}
        self._inflight: dict[str, asyncio.Future[Any]] = {}
        self._max = max_entries

    def get(self, key: str) -> CacheEntry | None:
        """A fresh entry, else None. Expired entries are kept (until evicted) for `peek`."""
        entry = self._data.get(key)
        if entry is None or not entry.fresh(time.monotonic()):
            return None
        return entry

    def peek(self, key: str) -> CacheEntry | None:
        """The entry whatever its age (offline answers serve it as STALE)."""
        return self._data.get(key)

    def set(self, key: str, value: Any, ttl: float) -> None:
        if len(self._data) >= self._max:
            self._evict()
        self._data[key] = CacheEntry(value=value, stored_at=time.monotonic(), ttl=ttl)

    def invalidate(self, prefix: str = "") -> None:
        for k in [k for k in self._data if k.startswith(prefix)]:
            del self._data[k]

    def _evict(self) -> None:
        now = time.monotonic()
        for k in [k for k, e in self._data.items() if not e.fresh(now)]:
            del self._data[k]
        if len(self._data) >= self._max:
            oldest = sorted(self._data.items(), key=lambda kv: kv[1].stored_at)
            for k, _ in oldest[: len(oldest) // 4 + 1]:
                del self._data[k]

    # ----- in-flight registry shared by single and batch fetches (coalescing) -----

    def inflight(self, key: str) -> asyncio.Future[Any] | None:
        return self._inflight.get(key)

    def begin(self, key: str) -> asyncio.Future[Any]:
        fut: asyncio.Future[Any] = asyncio.get_running_loop().create_future()
        self._inflight[key] = fut
        return fut

    def end(self, key: str, fut: asyncio.Future[Any], result: Any) -> None:
        """Resolve a `begin` future: a (value, meta) tuple, or an exception (None = no
        result: waiters get an error)."""
        if self._inflight.get(key) is fut:
            del self._inflight[key]
        if fut.done():
            return
        if isinstance(result, BaseException):
            fut.set_exception(result)
            fut.exception()  # retrieved: no "never awaited" warning when nobody waits
        elif result is None:
            fut.set_exception(RuntimeError(f"{key}: request abandoned"))
            fut.exception()
        else:
            fut.set_result(result)

    async def get_or_fetch(
        self,
        key: str,
        ttl: float | Callable[[Any], float],
        fetch: Callable[[], Awaitable[Any]],
    ) -> tuple[Any, bool]:
        """Return (value, from_cache). Errors are never cached. `ttl` may depend on the value
        (a callable), e.g. on which provider answered."""
        entry = self.get(key)
        if entry is not None:
            return entry.value, True
        existing = self._inflight.get(key)
        if existing is not None:
            return await asyncio.shield(existing), True
        loop = asyncio.get_running_loop()
        fut: asyncio.Future[Any] = loop.create_future()
        self._inflight[key] = fut
        try:
            value = await fetch()
        except BaseException as exc:
            fut.set_exception(exc)
            # Mark retrieved so asyncio does not warn when nobody else awaited it.
            fut.exception()
            raise
        else:
            self.set(key, value, ttl(value) if callable(ttl) else ttl)
            fut.set_result(value)
            return value, False
        finally:
            self._inflight.pop(key, None)
