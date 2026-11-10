"""Routes a request through a chain of providers with rate limiting, retry, caching and fallback."""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from typing import Any, TypeVar

from ..models import AssetClass, Instrument, Latency, Meta
from . import ratelimit
from .backoff import backoff_delay, jitter
from .base import (
    Capability,
    CircuitOpen,
    DataProvider,
    LocalRateLimited,
    NetworkError,
    NotFound,
    NotSupported,
    PartialBatch,
    ProviderError,
    RateLimited,
    RateQueued,
)
from .cache import TTLCache
from .network import NetworkMonitor
from .storage import DEFAULT as DEFAULT_RULE
from .storage import rule_for

__all__ = ["ProviderRouter", "RouterError", "backoff_delay"]

log = logging.getLogger("ndx.router")
T = TypeVar("T")

# Nominal retry delays (exponential); each sleep is jittered to 50-100 % of it.
RETRY_DELAYS = (0.4, 0.8)


def _ms(t0: float) -> float:
    return (time.perf_counter() - t0) * 1000


OFFLINE_MSG = "offline: network unreachable, no cached copy"
# Longest turn a request may queue for in a provider's own budget (Massive: 4 calls/min, so
# about a dozen chart windows); beyond it the request fails as rate-limited, as before.
QUEUE_MAX_S = 180.0


class RouterError(Exception):
    def __init__(
        self,
        code: str,
        message: str,
        attempts: list[str],
        network: bool = False,
        *,
        retry_after_s: float | None = None,
        provider: str | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.attempts = attempts
        # every failure was a connection failure (or we are offline): a stale copy may serve
        self.network = network
        # rate_limited with a place in the queue: repeat after this long (the turn is held)
        self.retry_after_s = retry_after_s
        self.provider = provider  # label of the provider the queue or deferral is for


class ProviderRouter:
    def __init__(
        self,
        providers: list[DataProvider],
        cache: TTLCache | None = None,
        preferences: dict[tuple[Capability, AssetClass], list[str]] | None = None,
        retry_delays: tuple[float, ...] = RETRY_DELAYS,
        network: NetworkMonitor | None = None,
    ) -> None:
        self.providers = providers
        self.by_name = {p.name: p for p in providers}
        self.cache = cache or TTLCache()
        self.preferences = preferences or {}
        self.retry_delays = retry_delays
        self.network = network or NetworkMonitor()
        # Opt-in providers the user switched on in PDF (yfinance). Off by default.
        self.opt_in_enabled: set[str] = set()

    def available(self, p: DataProvider) -> bool:
        return p.enabled and (not p.opt_in or p.name in self.opt_in_enabled)

    def make_meta(
        self,
        provider: DataProvider,
        asset: AssetClass,
        value: Any,
        *,
        ttl: float,
        attempts: list[str],
        as_of: datetime | None,
        inst: Instrument | None,
        fetched_at: datetime | None = None,
    ) -> Meta:
        lat, delay, note = provider.result_meta(asset, value)
        meta = Meta(
            source=provider.label,
            latency=lat,
            delay_minutes=delay if lat is Latency.DELAYED else None,
            venue=provider.venue(asset, value) if lat is Latency.REALTIME else None,
            provider_symbol=provider.provider_symbol(inst) if inst is not None else None,
            as_of=as_of,
            fetched_at=fetched_at or datetime.now(UTC),
            # STALE = older than 2x the expected refresh (SPEC §6.1); callers with
            # release-frequency data override this.
            stale_after_s=2 * ttl,
            personal_use=provider.personal_use,
            demo=provider.demo,
            attempts=list(attempts),
            note=note,
        )
        extra = provider.meta_overrides(inst, value)
        return meta.model_copy(update=extra) if extra else meta

    def chain(self, cap: Capability, asset: AssetClass) -> list[DataProvider]:
        """Enabled providers for (capability, asset class) in preference order."""
        order = self.preferences.get((cap, asset))
        candidates = [p for p in self.providers if self.available(p) and p.supports(cap, asset)]
        if order:
            rank = {n: i for i, n in enumerate(order)}
            candidates.sort(key=lambda p: rank.get(p.name, len(rank)))
        return candidates

    async def fetch(
        self,
        cap: Capability,
        asset: AssetClass,
        cache_key: str,
        ttl: float,
        call: Callable[[DataProvider], Awaitable[T]],
        as_of: Callable[[T], datetime | None] | None = None,
        only: str | None = None,
        inst: Instrument | None = None,
        defer: bool = False,
    ) -> tuple[T, Meta]:
        """`defer`: the request can wait for the user (a window not in focus): answer from the
        cache or from providers without a tight budget; scarce ones are left for later
        (RouterError "deferred"). A request over a provider's per-minute budget takes a
        place in its queue (RouterError "rate_limited" with `retry_after_s`)."""
        chain = self.chain(cap, asset)
        if only is not None:
            chain = [p for p in chain if p.name == only]
        if not chain:
            raise RouterError(
                "no_provider",
                f"no enabled provider for {cap.value}/{asset.value}"
                " (missing API key or unsupported)",
                [],
            )

        full_key = f"{cap.value}:{cache_key}"
        keep = [ttl]  # the answering provider may cache longer (`DataProvider.cache_ttl`)

        async def run() -> tuple[T, Meta]:
            if self.network.offline:  # no requests until the probe sees the network again
                raise RouterError("upstream", OFFLINE_MSG, [], network=True)
            attempts: list[str] = []
            errors: list[ProviderError | Exception] = []
            deferred: list[str] = []
            serving = [p for p in chain if p.serves(cap, inst)]
            for provider in chain:
                if not provider.serves(cap, inst):
                    continue  # known without a request: no token, no attempt (review 2 B)
                if defer and provider.scarce:
                    deferred.append(provider.label)
                    continue
                attempts.append(provider.name)
                if not provider.breaker.allow():
                    errors.append(CircuitOpen(f"{provider.name} circuit open"))
                    continue
                try:
                    # Only a scarce budget queues; others fall through to the next source.
                    queue_key = full_key if provider.scarce else None
                    later = serving[serving.index(provider) + 1 :]
                    value = await self._call_with_retry(
                        provider, call, queue_key, self._patience(later)
                    )
                except NotSupported:
                    attempts.pop()
                    continue
                except RateQueued as exc:
                    # Its turn is held: wait for it rather than spend the next source's budget.
                    errors.append(exc)
                    break
                except Exception as exc:
                    errors.append(exc)
                    log.warning("%s %s failed via %s: %s", cap.value, cache_key, provider.name, exc)
                    continue
                keep[0] = provider.cache_ttl(inst, value, ttl)
                meta = self.make_meta(
                    provider,
                    asset,
                    value,
                    ttl=keep[0],
                    attempts=attempts,
                    as_of=as_of(value) if as_of else None,
                    inst=inst,
                )
                return value, meta
            queued = next((e for e in errors if isinstance(e, RateQueued)), None)
            if queued is not None:
                raise RouterError(
                    "rate_limited",
                    str(queued),
                    attempts,
                    retry_after_s=queued.retry_after_s,
                    provider=queued.label,
                )
            if deferred:
                raise RouterError(
                    "deferred",
                    f"{', '.join(deferred)}: tight budget, loads when the window is focused",
                    attempts,
                    provider=deferred[0],
                )
            if errors and all(isinstance(e, NotFound) for e in errors):
                raise RouterError("not_found", str(errors[-1]), attempts)
            if errors and all(isinstance(e, RateLimited) for e in errors):
                raise RouterError("rate_limited", "all providers rate-limited", attempts)
            if not errors:
                # Every enabled provider said NotSupported (e.g. intraday index bars without
                # yfinance): no source for this request, not a failure.
                raise RouterError(
                    "no_provider",
                    f"no enabled provider for {cap.value}/{asset.value} supports this request",
                    attempts,
                )
            msg = "; ".join(f"{n}: {e}" for n, e in zip(attempts, errors, strict=False))
            network = all(isinstance(e, NetworkError) for e in errors)
            raise RouterError("upstream", msg, attempts, network)

        try:
            if defer:
                # Not shared with an in-flight request: a focused window asking for the same
                # key must not get this request's "deferred".
                entry = self.cache.get(full_key)
                if entry is not None:
                    result, from_cache = entry.value, True
                else:
                    result, from_cache = await run(), False
                    self.cache.set(full_key, result, keep[0])
            else:
                result, from_cache = await self.cache.get_or_fetch(full_key, lambda _: keep[0], run)
        except RouterError as exc:
            stale = self.stale_copy(full_key) if exc.network else None
            if stale is None:
                raise
            return stale
        value, meta = result
        if from_cache:
            meta = meta.model_copy(update={"cached": True})
        return value, meta

    async def fetch_batch(
        self,
        cap: Capability,
        asset: AssetClass,
        keys: dict[str, Any],
        ttl: float,
        call: Callable[[DataProvider, list[Any]], Awaitable[dict[str, T]]],
        as_of: Callable[[T], datetime | None] | None = None,
    ) -> dict[str, tuple[T, Meta] | RouterError]:
        """Batch variant of `fetch`. `keys` maps cache key -> request item; providers return a
        dict keyed by the same keys. Items a provider misses fall through to the next one.
        Shares cache entries with `fetch` (same `cap:key` format)."""
        results: dict[str, tuple[T, Meta] | RouterError] = {}
        missing: dict[str, Any] = {}
        waiting: dict[str, asyncio.Future[Any]] = {}
        for key, item in keys.items():
            entry = self.cache.get(f"{cap.value}:{key}")
            if entry is not None:
                value, meta = entry.value
                results[key] = (value, meta.model_copy(update={"cached": True}))
                continue
            fut = self.cache.inflight(f"{cap.value}:{key}")
            if fut is not None:  # another request is fetching this key: share its result
                waiting[key] = fut
            else:
                missing[key] = item
        own = {key: self.cache.begin(f"{cap.value}:{key}") for key in missing}
        try:
            if self.network.offline:
                for key in missing:
                    results[key] = RouterError("upstream", OFFLINE_MSG, [], network=True)
            else:
                await self._batch_chain(cap, asset, missing, ttl, call, as_of, results)
            for key, r in list(results.items()):
                if isinstance(r, RouterError) and r.network:
                    results[key] = self.stale_copy(f"{cap.value}:{key}") or r
        finally:
            for key, fut in own.items():
                self.cache.end(f"{cap.value}:{key}", fut, results.get(key))
        for key, fut in waiting.items():
            try:
                value, meta = await asyncio.shield(fut)
                results[key] = (value, meta.model_copy(update={"cached": True}))
            except RouterError as exc:
                results[key] = exc
            except Exception as exc:
                results[key] = RouterError("upstream", str(exc), [])
        return results

    async def _batch_chain(
        self,
        cap: Capability,
        asset: AssetClass,
        missing: dict[str, Any],
        ttl: float,
        call: Callable[[DataProvider, list[Any]], Awaitable[dict[str, T]]],
        as_of: Callable[[T], datetime | None] | None,
        results: dict[str, tuple[T, Meta] | RouterError],
    ) -> None:
        missing = dict(missing)
        attempts: list[str] = []
        # Per-key errors (whole-batch failures and the keys a partial batch lacks): their error
        # classes decide the code (rate_limited, upstream, not_found, no_provider), never a
        # blanket not_found that depends on what else was in the batch (re-verify R2).
        key_errors: dict[str, list[tuple[str, ProviderError]]] = {}
        for provider in self.chain(cap, asset):
            if not missing:
                break
            attempts.append(provider.name)
            if not provider.breaker.allow():
                skip = CircuitOpen(f"{provider.name} circuit open")
                for key in missing:
                    key_errors.setdefault(key, []).append((provider.name, skip))
                continue
            # Only the items this source can serve: no token spent on the rest (review 2 B).
            batch = []
            for key, item in missing.items():
                if isinstance(item, Instrument) and not provider.serves(cap, item):
                    no = NotSupported(f"{provider.name} does not cover {item.symbol}")
                    key_errors.setdefault(key, []).append((provider.name, no))
                else:
                    batch.append(item)
            if not batch:
                attempts.pop()
                continue
            try:
                # Batches are quotes, polled again in seconds: a busy budget fails fast here
                # rather than hold up the whole poll behind a queue (bars, profiles wait).
                got = await self._call_with_retry(
                    provider,
                    lambda p, b=batch: call(p, b),  # type: ignore[misc]
                    None,
                    ratelimit.FALL_THROUGH_S,
                )
            except NotSupported:
                attempts.pop()
                continue
            except Exception as exc:
                log.warning("batch %s via %s failed: %s", cap.value, provider.name, exc)
                err = exc if isinstance(exc, ProviderError) else ProviderError(str(exc))
                for key in missing:
                    key_errors.setdefault(key, []).append((provider.name, err))
                continue
            self._record_partial(provider, got)
            got = await self._retry_partial(provider, missing, got, call)
            for key, err in getattr(got, "errors", {}).items():
                key_errors.setdefault(key, []).append((provider.name, err))
            now = datetime.now(UTC)
            for key, value in got.items():
                if key not in missing:
                    continue
                item = missing[key]
                meta = self.make_meta(
                    provider,
                    asset,
                    value,
                    ttl=ttl,
                    attempts=attempts,
                    as_of=as_of(value) if as_of else None,
                    inst=item if isinstance(item, Instrument) else None,
                    fetched_at=now,
                )
                self.cache.set(f"{cap.value}:{key}", (value, meta), ttl)
                results[key] = (value, meta)
                del missing[key]
        for key in missing:
            errs = key_errors.get(key, [])
            real = [(n, e) for n, e in errs if not isinstance(e, NotSupported)]
            if not attempts or (errs and not real):
                results[key] = RouterError(
                    "no_provider", f"no enabled provider for {asset.value}", []
                )
            elif real:
                codes = {e.code for _, e in real}
                code = codes.pop() if len(codes) == 1 else "upstream"
                msg = "; ".join(f"{n}: {e}" for n, e in real)
                network = all(isinstance(e, NetworkError) for _, e in real)
                results[key] = RouterError(code, msg, list(attempts), network)
            else:
                results[key] = RouterError("not_found", f"no data for {key}", list(attempts))

    @staticmethod
    def _record_partial(provider: DataProvider, got: object) -> None:
        """A batch's real failures count in PROV/health once each (`PartialBatch.health`)."""
        for err in getattr(got, "health", []):
            provider.record_error(err)

    async def _retry_partial(
        self,
        provider: DataProvider,
        missing: dict[str, Any],
        got: dict[str, T],
        call: Callable[[DataProvider, list[Any]], Awaitable[dict[str, T]]],
    ) -> dict[str, T]:
        """Retries the keys of a batch whose own error was retryable (a transient 5xx on one
        symbol): one request, after the first back-off delay."""
        errs: dict[str, ProviderError] = getattr(got, "errors", {})
        again = [k for k, e in errs.items() if e.retryable and k in missing]
        if not again or not self.retry_delays:
            return got
        await asyncio.sleep(self.retry_delays[0])
        # One request, not a nested back-off loop (re-verify N3).
        if not await provider.rate.acquire(max_wait=3.0):
            return got
        t0 = time.perf_counter()
        try:
            more = await call(provider, [missing[k] for k in again])
        except Exception as exc:
            err = exc if isinstance(exc, ProviderError) else ProviderError(str(exc))
            provider.record_error(err, _ms(t0))
            for k in again:
                errs[k] = err
            return got
        if not (isinstance(more, PartialBatch) and not more and more.health):
            provider.record_ok(_ms(t0))
        self._record_partial(provider, more)
        merged = type(got)() if isinstance(got, PartialBatch) else {}
        merged.update(got)
        merged.update(more)
        if isinstance(merged, PartialBatch):
            merged.errors = {k: e for k, e in errs.items() if k not in more}
            merged.errors.update(getattr(more, "errors", {}))
        return merged

    @staticmethod
    def _patience(later: list[DataProvider]) -> float:
        """A busy plain budget falls through after 3 s when a later source without a tight
        budget can answer; otherwise the request waits its turn (up to PATIENCE_S) rather
        than fail or spend a scarce budget (real run 2026-11-10: WEI's 48 Yahoo index bar
        requests at once got 13 tokens and read N.A.)."""
        if any(not p.scarce for p in later):
            return ratelimit.FALL_THROUGH_S
        return ratelimit.PATIENCE_S

    async def _call_with_retry(
        self,
        provider: DataProvider,
        call: Callable[[DataProvider], Awaitable[T]],
        key: str | None = None,
        patience: float = 3.0,
    ) -> T:
        """`key`: the request may queue for the provider's budget under this key (it will be
        repeated by the caller) instead of failing when no token comes within 3 s.
        `patience`: how long to wait for a token before giving up (`_patience`)."""
        last: Exception | None = None
        attempts = 1 + len(self.retry_delays)
        for i in range(attempts):
            if i:
                if provider.breaker.state != "closed":
                    break  # the breaker opened (or a half-open probe failed): stop retrying
                await asyncio.sleep(self.retry_delays[i - 1] * jitter())
            turn = provider.rate.claim(key) if key is not None and not i else None
            if turn:  # queued earlier and its turn has not come yet
                raise RateQueued(provider.label, turn)
            # A scarce budget (keyed) holds a place in its queue after 3 s.
            wait_s = 3.0 if key is not None and not i else patience
            if turn is None and not await provider.rate.acquire(max_wait=wait_s):
                wait = (
                    provider.rate.reserve(key, QUEUE_MAX_S) if key is not None and not i else None
                )
                if wait is not None:
                    raise RateQueued(provider.label, wait)
                err = LocalRateLimited(f"{provider.name} local rate limit reached")
                provider.record_error(err)
                raise err
            t0 = time.perf_counter()
            try:
                value = await call(provider)
                if (
                    isinstance(value, PartialBatch)
                    and not value
                    and value.health
                    and all(isinstance(e, NetworkError) for e in value.health)
                ):
                    raise value.health[0]  # a batch that reached nobody: the network is down
            except NotSupported:
                raise
            except ProviderError as exc:
                provider.record_error(exc, _ms(t0))
                last = exc
                if isinstance(exc, NetworkError):
                    self.network.failure(exc)
                    if self.network.offline:
                        raise
                elif not isinstance(exc, LocalRateLimited):  # ours: nothing was sent
                    self.network.ok()  # the provider answered: the network works
                if not exc.retryable or i == attempts - 1:
                    raise
                continue
            except Exception as exc:  # unexpected adapter error: do not retry blindly
                provider.record_error(exc, _ms(t0))
                raise ProviderError(f"{type(exc).__name__}: {exc}") from exc
            # A batch that came back empty with real failures is not a success (re-verify N2).
            if not (isinstance(value, PartialBatch) and not value and value.health):
                provider.record_ok(_ms(t0))
                self.network.ok()
            return value
        assert last is not None
        raise last

    def stale_copy(self, full_key: str) -> tuple[Any, Meta] | None:
        """The last cached value for an offline answer, tagged STALE — unless its provider's
        storage rule forbids it (memory only: never served offline; CoinGecko: not older than
        24 h) or its source has been switched off."""
        entry = self.cache.peek(full_key)
        if entry is None:
            return None
        value, meta = entry.value
        owner = next((p for p in self.providers if p.label == meta.source), None)
        rule = rule_for(owner) if owner is not None else DEFAULT_RULE
        if rule.memory_only or (owner is not None and not self.available(owner)):
            return None
        age = (datetime.now(UTC) - meta.fetched_at).total_seconds()
        if rule.max_age_s is not None and age > rule.max_age_s:
            return None
        return value, meta.model_copy(update={"cached": True, "stale": True})

    def statuses(self) -> list[Any]:
        return [p.status(opt_in_on=p.name in self.opt_in_enabled) for p in self.providers]

    def set_opt_in(self, name: str, on: bool) -> None:
        if on:
            self.opt_in_enabled.add(name)
        else:
            self.opt_in_enabled.discard(name)
            # Values from a source the user just switched off must not linger in the cache.
            self.cache.invalidate()

    async def aclose(self) -> None:
        await self.network.stop()
        for p in self.providers:
            await p.aclose()
