"""The seven data domains of SPEC §6.3 and the interface each one exposes.

A provider is a plug-in: it declares capabilities (finer-grained, per asset class) and the
router picks providers by priority with automatic fallback. Each capability belongs to exactly
one domain; PROV shows the domains a provider serves.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from enum import StrEnum
from typing import TYPE_CHECKING, Any, Protocol

from .base import Capability

if TYPE_CHECKING:
    from ..models import Instrument, Interval, Profile, Quote, SearchResult
    from .base import BarSeries, DataProvider


class Domain(StrEnum):
    QUOTES = "quotes"
    BARS = "bars"
    FUNDAMENTALS = "fundamentals"
    NEWS = "news"
    CALENDAR = "calendar"
    REFERENCE = "reference"
    STREAM = "stream"


C = Capability
DOMAIN_OF: dict[Capability, Domain] = {
    C.QUOTE: Domain.QUOTES,
    C.MARKETCAP: Domain.QUOTES,  # aggregated snapshots (CoinGecko)
    C.YIELDS: Domain.QUOTES,  # official end-of-day curve points
    C.BARS: Domain.BARS,
    C.MACRO: Domain.BARS,  # observation time series
    C.FUNDAMENTALS: Domain.FUNDAMENTALS,
    C.FILINGS: Domain.FUNDAMENTALS,
    C.INSIDERS: Domain.FUNDAMENTALS,
    C.NEWS: Domain.NEWS,
    C.CALENDAR: Domain.CALENDAR,
    C.EARNINGS: Domain.CALENDAR,  # earnings release dates (GP E markers)
    C.ACTIONS: Domain.CALENDAR,  # dividends and splits (GP D/S markers)
    C.ECON: Domain.CALENDAR,  # official release calendars and their series (ECO)
    C.PROFILE: Domain.REFERENCE,
    C.SEARCH: Domain.REFERENCE,
    C.SCREENER: Domain.REFERENCE,
}


def domains_of(p: DataProvider) -> set[Domain]:
    out = {DOMAIN_OF[c] for c in p.capabilities}
    if getattr(p, "stream_feed", None) is not None:
        out.add(Domain.STREAM)
    return out


class QuotesSource(Protocol):
    async def quotes(self, insts: list[Instrument]) -> dict[str, Quote]: ...


class BarsSource(Protocol):
    async def bars(self, inst: Instrument, interval: Interval, lookback_days: int) -> BarSeries: ...


class FundamentalsSource(Protocol):
    async def fundamentals(self, inst: Instrument, period: str) -> Any: ...


class NewsSource(Protocol):
    async def news(self, inst: Instrument | None, limit: int) -> list[Any]: ...


class CalendarSource(Protocol):
    async def calendar(self, start: str, end: str) -> list[Any]: ...


class ReferenceSource(Protocol):
    async def profile(self, inst: Instrument) -> Profile: ...

    async def search(self, query: str) -> list[SearchResult]: ...


class StreamSource(Protocol):
    """Backend-owned provider WebSocket (see `stream.SymbolFeed`)."""

    name: str
    cap: int

    def set_symbols(self, symbols: set[str]) -> None: ...

    on_tick: Callable[[str, Quote], Awaitable[None] | None] | None
