"""Official FX reference rates served from one table per publication (SPEC §6.2 "FX reference").

ECB and NBU publish one fixing per currency per day. One request fetches the whole table, so
every pair a window asks for is answered from it until the next publication is due: the
router's calls are counted by a generous local bucket, and the documented/self-imposed budget
(docs/PROVIDERS.md §6) is spent only on real requests (`http`, shown in PROV). Values are `EOD`
with the fixing's own date as `as_of`; a rate computed from published ones (an inverse or a
cross) is labelled as derived, as both sources' terms ask.
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from dataclasses import dataclass
from datetime import date, datetime
from typing import Any, ClassVar

import httpx

from ..models import AssetClass, Instrument, Latency, Quote
from .base import (
    Capability,
    DataProvider,
    LocalRateLimited,
    NotFound,
    NotSupported,
    PartialBatch,
    ProviderError,
    provider_wide,
)
from .budgets import BUDGETS
from .quota import utc_now
from .ratelimit import TokenBucket

FX = frozenset({AssetClass.FX})


@dataclass(frozen=True)
class Fix:
    """One currency's latest fixing and the one before it (value per the table's base)."""

    day: date
    value: float
    prev_day: date | None = None
    prev: float | None = None


@dataclass
class Table:
    fixes: dict[str, Fix]
    fetched_at: datetime
    valid_until: datetime


@dataclass(frozen=True)
class PairRate:
    price: float
    prev: float | None
    day: date
    derived: bool


@dataclass
class Served:
    table: Table
    cached: bool
    note: str


def pair_of(inst: Instrument) -> tuple[str, str]:
    return inst.symbol[:3], inst.symbol[3:6]


class ReferenceFxProvider(DataProvider):
    """Base for ECB / NBU: subclasses fetch and parse the table and price a pair from it."""

    capabilities: ClassVar[dict[Capability, frozenset[AssetClass]]] = {Capability.QUOTE: FX}
    source_note: ClassVar[str]
    derived_note: ClassVar[str]

    def __init__(
        self,
        client: httpx.AsyncClient,
        clock: Callable[[], datetime] = utc_now,
    ) -> None:
        # Router calls are answered from the table (no request); real requests take `http`.
        super().__init__(TokenBucket.per_minute(600, 100))
        self.http = BUDGETS[self.name].bucket()
        self.clock = clock
        self._client = client
        self._table: Table | None = None
        self._lock = asyncio.Lock()
        self._served: dict[str, Served] = {}

    # ----- subclass hooks -----

    async def load(self, now: datetime) -> Table:  # pragma: no cover - abstract
        raise NotImplementedError

    def pair_rate(self, base: str, quote: str, fixes: dict[str, Fix]) -> PairRate | None:
        raise NotImplementedError  # pragma: no cover - abstract

    def handles(self, base: str, quote: str) -> bool:
        raise NotImplementedError  # pragma: no cover - abstract

    def as_of(self, day: date) -> datetime:
        raise NotImplementedError  # pragma: no cover - abstract

    # ----- metadata -----

    def latency(self, asset: AssetClass) -> tuple[Latency, int | None]:
        return Latency.EOD, None

    def quota_source(self) -> TokenBucket:
        return self.http

    def meta_overrides(self, inst: Instrument | None, value: Any) -> dict[str, Any]:
        served = self._served.get(inst.symbol) if inst is not None else None
        if served is None:
            return {}
        t = served.table
        life = (t.valid_until - t.fetched_at).total_seconds()
        return {
            "fetched_at": t.fetched_at,
            "cached": served.cached,
            "stale_after_s": 2 * max(3600.0, life),
            "note": served.note,
        }

    # ----- the table -----

    async def table(self) -> tuple[Table, bool]:
        async with self._lock:  # one request however many pairs ask at once
            now = self.clock()
            t = self._table
            if t is not None and t.valid_until > now:
                return t, True
            if not await self.http.acquire(max_wait=3.0):
                if t is not None:
                    return t, True  # past its refresh time; ages to STALE in the UI
                raise LocalRateLimited(f"{self.name} local rate limit reached")
            self._table = await self.load(now)
            return self._table, False

    # ----- data -----

    def _quote(self, inst: Instrument, t: Table, cached: bool) -> Quote:
        base, quote = pair_of(inst)
        r = self.pair_rate(base, quote, t.fixes)
        if r is None:
            raise NotFound(f"{self.label} publishes no rate for {base}/{quote}")
        change = r.price - r.prev if r.prev is not None else None
        pct = change / r.prev * 100 if change is not None and r.prev else None
        self._served[inst.symbol] = Served(
            t, cached, self.derived_note if r.derived else self.source_note
        )
        return Quote(
            symbol=inst.symbol,
            currency=quote,
            price=r.price,
            prev_close=r.prev,
            change=change,
            change_pct=pct,
            ts=self.as_of(r.day),
        )

    def _check(self, inst: Instrument) -> None:
        if inst.asset_class is not AssetClass.FX:
            raise NotSupported(f"{self.label}: FX pairs only")
        if not self.handles(*pair_of(inst)):
            raise NotSupported(f"{self.label} has no {inst.symbol}")

    async def quote(self, inst: Instrument) -> Quote:
        self._check(inst)
        t, cached = await self.table()
        return self._quote(inst, t, cached)

    async def quotes(self, insts: list[Instrument]) -> dict[str, Quote]:
        """Every pair from one table: no request per symbol."""
        out = PartialBatch()
        wanted: list[Instrument] = []
        for inst in insts:
            try:
                self._check(inst)
            except NotSupported as exc:
                out.errors[inst.symbol] = exc
            else:
                wanted.append(inst)
        if not wanted:
            raise NotSupported(f"{self.name} supports none of these symbols")
        try:
            t, cached = await self.table()
        except ProviderError as exc:
            if provider_wide(exc):
                raise
            out.errors.update({i.symbol: exc for i in wanted})
            out.health.append(exc)
            return out
        for inst in wanted:
            try:
                out[inst.symbol] = self._quote(inst, t, cached)
            except NotFound as exc:
                out.errors[inst.symbol] = exc
        return out

    async def aclose(self) -> None:
        await self._client.aclose()
