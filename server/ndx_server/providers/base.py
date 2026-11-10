"""The DataProvider interface every adapter implements."""

from __future__ import annotations

import logging
import math
from collections import deque
from dataclasses import dataclass
from datetime import UTC, datetime
from enum import StrEnum
from typing import Any, ClassVar

from ..models import (
    AssetClass,
    Bar,
    Instrument,
    Interval,
    Latency,
    Profile,
    ProviderState,
    ProviderStatus,
    Quote,
    SearchResult,
    freshness_tag,
)
from .breaker import CircuitBreaker
from .ratelimit import TokenBucket

log = logging.getLogger("ndx.providers")


class Capability(StrEnum):
    QUOTE = "quote"
    BARS = "bars"
    PROFILE = "profile"
    FUNDAMENTALS = "fundamentals"
    NEWS = "news"
    SEARCH = "search"
    MACRO = "macro"
    FILINGS = "filings"
    INSIDERS = "insiders"
    CALENDAR = "calendar"
    MARKETCAP = "marketcap"
    SCREENER = "screener"
    YIELDS = "yields"
    EARNINGS = "earnings"  # past earnings release dates (GP `E` markers)
    ACTIONS = "actions"  # dividends and splits (GP `D`/`S` markers)
    ECON = "econ"  # official release calendars and their series (ECO, SPEC §8)


@dataclass(slots=True)
class BarSeries:
    bars: list[Bar]
    tz: str
    utc_offset_s: int
    as_of: datetime | None = None
    note: str | None = None  # a caveat the provider states about this series (Meta.note)


class ProviderError(Exception):
    """Base error. `retryable` errors are retried with backoff before falling back."""

    retryable: bool = False
    code: str = "upstream"

    def __init__(self, message: str, *, retryable: bool | None = None) -> None:
        super().__init__(message)
        if retryable is not None:
            self.retryable = retryable


class TransientError(ProviderError):
    retryable = True


class NetworkError(TransientError):
    """The provider could not be reached at all (DNS, connect refused/timed out): to the
    backend this looks like the machine is offline (SPEC §6.3 offline)."""


class RateLimited(ProviderError):
    code = "rate_limited"


class LocalRateLimited(RateLimited):
    """Our own budget refused the request: the provider was not called (not its failure)."""


class RateQueued(LocalRateLimited):
    """Our own per-minute budget is spent for now: the request holds a place in the
    provider's queue and is to be repeated after `retry_after_s` (not a failure)."""

    def __init__(self, label: str, retry_after_s: float) -> None:
        self.label = label
        self.retry_after_s = round(retry_after_s, 1)
        super().__init__(f"{label} rate limit: queued, turn in {math.ceil(retry_after_s)} s")


class CircuitOpen(ProviderError):
    """The provider's circuit breaker is open: skipped without a request."""


class NotFound(ProviderError):
    code = "not_found"


class NotSupported(ProviderError):
    code = "no_provider"


class AuthError(ProviderError):
    """The provider rejected the key or the endpoint (HTTP 401/403): not about one symbol."""


def provider_wide(e: BaseException) -> bool:
    """A failure that is about the provider, not the symbol (rate limit, rejected key): a batch
    stops on it instead of repeating a request that is certain to fail."""
    return isinstance(e, RateLimited | AuthError | NetworkError)


class PartialBatch(dict[str, Any]):
    """A batch result plus the per-key errors of the keys it lacks (router labels/retries).

    `health` holds the failures to count in PROV/health, once per real outcome: a symbol's own
    failed request, or a provider-wide stop once (not once per symbol it stopped). NotFound and
    NotSupported answers are not provider errors (re-verify N2)."""

    def __init__(self) -> None:
        super().__init__()
        self.errors: dict[str, ProviderError] = {}
        self.health: list[ProviderError] = []


def _pct(sorted_samples: list[float], p: float) -> float | None:
    """Nearest-rank percentile of real samples; None (N.A.) without any."""
    if not sorted_samples:
        return None
    i = min(len(sorted_samples) - 1, max(0, round(p * len(sorted_samples) + 0.5) - 1))
    return round(sorted_samples[i], 1)


class DataProvider:
    """Base class. Subclasses override the methods for the capabilities they declare."""

    name: ClassVar[str]
    label: ClassVar[str]
    requires_key: ClassVar[bool] = False
    # Opt-in personal-use source (yfinance): off until the user enables it in PDF (SPEC §6.2).
    opt_in: ClassVar[bool] = False
    personal_use: ClassVar[bool] = False
    # Storage rule from PROVIDERS.md: "memory" = never written to disk, never served offline.
    storage: ClassVar[str] = "cache"
    demo: ClassVar[bool] = False  # DEMO fixtures (tests/screenshots only)
    capabilities: ClassVar[dict[Capability, frozenset[AssetClass]]] = {}
    # A tight budget (a few calls a minute, or a day): requests that can wait for the user
    # (a window not in focus) do not spend it (`ProviderRouter.fetch(defer=True)`).
    scarce: ClassVar[bool] = False

    def __init__(self, rate: TokenBucket, api_key: str = "") -> None:
        self.rate = rate
        self.api_key = api_key
        self.calls = 0
        self.errors = 0
        self.rate_limited = 0
        self.consecutive_errors = 0
        self.last_ok: datetime | None = None
        self.last_error: str | None = None
        self._limited = False  # the last outcome was the provider's own rate-limit answer
        self.last_error_at: datetime | None = None
        self.disabled_reason: str | None = None
        self.breaker = CircuitBreaker()
        # last 200 real requests: latency (ms) and outcome, for PROV p50/p95 and error rate
        self.latencies_ms: deque[float] = deque(maxlen=200)
        self.outcomes: deque[bool] = deque(maxlen=200)

    # ----- metadata -----

    @property
    def enabled(self) -> bool:
        if self.disabled_reason:
            return False
        return not (self.requires_key and not self.api_key)

    def supports(self, cap: Capability, asset: AssetClass) -> bool:
        return asset in self.capabilities.get(cap, frozenset())

    def latency(self, asset: AssetClass) -> tuple[Latency, int | None]:
        """Static latency class of this provider for an asset class."""
        return Latency.DELAYED, None

    def result_meta(self, asset: AssetClass, value: Any) -> tuple[Latency, int | None, str | None]:
        """Latency for a concrete result (providers may inspect it); plus an optional note."""
        lat, delay = self.latency(asset)
        return lat, delay, None

    def venue(self, asset: AssetClass, value: Any) -> str | None:
        """Real-time marker for `RT·<venue>` tags (TRD, REF, IEX...); None = plain `RT`."""
        return None

    def covers(self, inst: Instrument) -> bool:
        """Whether the user's switch for this source covers `inst` (a limited opt-in)."""
        return True

    def serves(self, cap: Capability, inst: Instrument | None) -> bool:
        """Whether this source can answer `cap` for `inst` at all, known without a request
        (Finnhub free: US listings only). The router skips a source that cannot, before it
        spends a token on it (review 2 B: refusals queued on Finnhub's 55/min budget)."""
        return inst is None or self.covers(inst)

    def limit_detail(self) -> str | None:
        """Why the source is at its plan's limit now (PROV/status LIMIT), or None. Default:
        a daily budget with nothing left, or the provider's own last refusal (HTTP 429/402)
        not yet followed by an answer."""
        q = self.quota_source().quota()
        if q.period == "day" and q.limit > 0 and q.left == 0:
            return f"daily budget used ({q.used}/{q.limit}); resets 00:00 UTC"
        if self._limited and self.last_error:
            return self.last_error
        return None

    def provider_symbol(self, inst: Instrument) -> str:
        return inst.symbol

    def quota_source(self) -> Any:
        """What PROV shows as this provider's quota (`.quota()` -> Quota): by default the
        router's token bucket. Providers whose real requests are fewer than the router's calls
        (one table serves every symbol; a daily allowance) report the counter they spend."""
        return self.rate

    def meta_overrides(self, inst: Instrument | None, value: Any) -> dict[str, Any]:
        """Meta fields this provider knows better than the router (e.g. an end-of-day close
        served from the provider's own daily store: its real `fetched_at`, `cached`, and a
        `stale_after_s` measured in sessions, not quote TTLs). Default: none."""
        return {}

    def cache_ttl(self, inst: Instrument | None, value: Any, ttl: float) -> float:
        """How long the router may cache this answer; default: the caller's TTL. A provider
        whose data cannot change before a known time (a previous-session plan) says so."""
        return ttl

    def daily_valid_until(
        self, inst: Instrument, fetched_at: datetime, series: BarSeries | None
    ) -> datetime | None:
        """How long a stored daily series from this provider is current; None = the default
        (next session close, SPEC §6.3)."""
        return None

    # ----- bookkeeping -----

    def record_ok(self, latency_ms: float | None = None) -> None:
        self._limited = False
        self.calls += 1
        self.consecutive_errors = 0
        self.last_ok = datetime.now(UTC)
        self.breaker.success()
        self.outcomes.append(True)
        if latency_ms is not None:
            self.latencies_ms.append(latency_ms)

    def record_error(self, exc: BaseException, latency_ms: float | None = None) -> None:
        if not isinstance(exc, LocalRateLimited | CircuitOpen):
            if latency_ms is not None:
                self.latencies_ms.append(latency_ms)
            if isinstance(exc, NetworkError):
                # our network, not the provider: never trips its breaker
                self.outcomes.append(False)
            elif isinstance(exc, NotFound | NotSupported):
                # the provider answered: alive for the breaker, not an error in the rate
                self.breaker.success()
                self.outcomes.append(True)
            else:
                self.breaker.failure()
                self.outcomes.append(False)
        if isinstance(exc, RateLimited):
            self.rate_limited += 1
        if isinstance(exc, LocalRateLimited):
            # Our own budget said no: no request was made, so it is neither a call nor an
            # error of the provider (review 2 A: a spent EODHD day read as DOWN).
            self.last_error = f"{type(exc).__name__}: {exc}"[:300]
            self.last_error_at = datetime.now(UTC)
            return
        self._limited = isinstance(exc, RateLimited)
        self.calls += 1
        self.errors += 1
        self.consecutive_errors += 1
        self.last_error = f"{type(exc).__name__}: {exc}"[:300]
        self.last_error_at = datetime.now(UTC)

    def status(self, opt_in_on: bool = False) -> ProviderStatus:
        from .domains import domains_of

        has_key = bool(self.api_key) or not self.requires_key
        if self.disabled_reason:
            state, detail = ProviderState.DISABLED, self.disabled_reason
        elif self.opt_in and not opt_in_on:
            state, detail = ProviderState.DISABLED, "opt-in, off (enable in PDF; personal use)"
        elif self.requires_key and not self.api_key:
            state, detail = ProviderState.DISABLED, "no API key"
        elif limit := self.limit_detail():
            state, detail = ProviderState.LIMIT, limit
            if self.breaker.state == "open":
                detail += f" — probe in {self.breaker.retry_in():.0f} s"
        elif self.breaker.state == "open":
            state = ProviderState.DOWN
            detail = f"circuit open, probe in {self.breaker.retry_in():.0f} s"
            if self.last_error:
                detail += f" — {self.last_error}"
        elif self.calls == 0:
            state, detail = ProviderState.IDLE, None
        elif self.consecutive_errors >= 3:
            state, detail = ProviderState.DOWN, self.last_error
        elif self.consecutive_errors > 0:
            state, detail = ProviderState.DEGRADED, self.last_error
        else:
            state, detail = ProviderState.OK, None
        asset = next(iter(AssetClass))
        lat, delay = self.latency(asset)
        q = self.quota_source().quota()
        samples = sorted(self.latencies_ms)
        n_out = len(self.outcomes)
        return ProviderStatus(
            tag=freshness_tag(lat, delay, self.venue(asset, None), demo=self.demo),
            name=self.name,
            label=self.label,
            state=state,
            detail=detail,
            requires_key=self.requires_key,
            has_key=has_key,
            latency=lat,
            calls=self.calls,
            errors=self.errors,
            rate_limited=self.rate_limited,
            last_ok=self.last_ok,
            last_error=self.last_error,
            last_error_at=self.last_error_at,
            capabilities=sorted(c.value for c in self.capabilities),
            domains=sorted(d.value for d in domains_of(self)),
            latency_p50_ms=_pct(samples, 0.50),
            latency_p95_ms=_pct(samples, 0.95),
            error_rate=(n_out - sum(self.outcomes)) / n_out if n_out else None,
            quota_limit=q.limit,
            quota_period=q.period,
            quota_used=q.used,
            quota_left=q.left,
            breaker=self.breaker.state,
            opt_in=self.opt_in,
            personal_use=self.personal_use,
        )

    async def aclose(self) -> None:  # pragma: no cover - default no-op
        return None

    # ----- data methods (override as needed) -----

    async def quote(self, inst: Instrument) -> Quote:
        raise NotSupported(f"{self.name} does not support quote")

    async def quotes(self, insts: list[Instrument]) -> dict[str, Quote]:
        """Batch quotes keyed by `Instrument.symbol`. A symbol this provider cannot serve
        (unsupported, unknown, or its own request failed) is absent from the result and its
        error is kept in `PartialBatch.errors`, so one bad symbol never blanks the rest and the
        router can label, retry and count it. A provider-wide failure (rate limit, rejected key)
        stops the batch at once: the remaining symbols get the same error, no further requests.
        Only a batch no symbol of which is supported raises (NotSupported)."""
        out = PartialBatch()
        for inst in insts:  # known without a request: no token spent on them (review 2 B)
            if not self.serves(Capability.QUOTE, inst):
                out.errors[inst.symbol] = NotSupported(f"{self.name} does not cover {inst.symbol}")
        insts = [i for i in insts if i.symbol not in out.errors]
        for i, inst in enumerate(insts):
            # One request per symbol: the router took the token for the first; the rest take
            # their own, so a batch never exceeds the provider's budget (§6.3 token buckets).
            if i and not await self.rate.acquire(max_wait=3.0):
                stop: ProviderError = LocalRateLimited(f"{self.name} local rate limit reached")
                out.errors.update({x.symbol: stop for x in insts[i:]})
                out.health.append(stop)
                break
            try:
                out[inst.symbol] = await self.quote(inst)
            except Exception as exc:  # isolated per symbol
                e = (
                    exc
                    if isinstance(exc, ProviderError)
                    else ProviderError(f"{type(exc).__name__}: {exc}")
                )
                out.errors[inst.symbol] = e
                if not isinstance(e, NotSupported | NotFound):
                    log.warning("%s quote %s failed: %s", self.name, inst.symbol, e)
                    out.health.append(e)
                if provider_wide(e):
                    out.errors.update({x.symbol: e for x in insts[i + 1 :]})
                    break
        if not out and out.errors and all(isinstance(e, NotSupported) for e in out.errors.values()):
            raise NotSupported(f"{self.name} supports none of these symbols")
        # Even when nothing came back, each symbol keeps its own error (re-verify N1).
        return out

    async def bars(self, inst: Instrument, interval: Interval, lookback_days: int) -> BarSeries:
        raise NotSupported(f"{self.name} does not support bars")

    async def profile(self, inst: Instrument) -> Profile:
        raise NotSupported(f"{self.name} does not support profile")

    async def search(self, query: str) -> list[SearchResult]:
        raise NotSupported(f"{self.name} does not support search")

    async def news(self, inst: Instrument | None, limit: int) -> list[Any]:
        raise NotSupported(f"{self.name} does not support news")

    async def fundamentals(self, inst: Instrument, period: str) -> Any:
        raise NotSupported(f"{self.name} does not support fundamentals")

    async def calendar(self, start: str, end: str) -> list[Any]:
        raise NotSupported(f"{self.name} does not support calendar")
