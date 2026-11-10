"""Normalized field dictionary (SPEC §6.3), served to the UI and listed by `FLDS`.

One name per value whatever the provider: `px_last` is the last price from Finnhub, Binance or
the opt-in yfinance alike. `sources` are only the providers seen delivering a non-null value
since launch — a real observation, never a claim about what a provider might return.
"""

from __future__ import annotations

import threading
from dataclasses import dataclass
from typing import Any, Literal

from .models import FieldInfo, Profile, Quote

Domain = Literal["quotes", "reference", "fundamentals"]
Kind = Literal["price", "change", "pct", "volume", "money", "ratio", "time", "text"]


@dataclass(frozen=True)
class FieldDef:
    id: str
    name: str
    definition: str
    domain: Domain
    kind: Kind
    attr: str  # attribute of Quote (domain quotes) or Profile (reference, fundamentals)


FIELDS: tuple[FieldDef, ...] = (
    FieldDef("px_last", "Last price", "Last trade or reference price.", "quotes", "price", "price"),
    FieldDef("px_open", "Open", "First price of the current session.", "quotes", "price", "open"),
    FieldDef("px_high", "High", "Highest price of the current session.", "quotes", "price", "high"),
    FieldDef("px_low", "Low", "Lowest price of the current session.", "quotes", "price", "low"),
    FieldDef(
        "px_close_1d",
        "Previous close",
        "Close of the previous session.",
        "quotes",
        "price",
        "prev_close",
    ),
    FieldDef(
        "chg_net_1d", "Net change", "px_last minus px_close_1d.", "quotes", "change", "change"
    ),
    FieldDef(
        "chg_pct_1d",
        "% change",
        "Net change as a percent of px_close_1d.",
        "quotes",
        "pct",
        "change_pct",
    ),
    FieldDef(
        "volume", "Volume", "Shares or units traded this session.", "quotes", "volume", "volume"
    ),
    FieldDef(
        "vwap",
        "VWAP",
        "Volume-weighted average price of the session, as the source states it.",
        "quotes",
        "price",
        "vwap",
    ),
    FieldDef(
        "px_bid",
        "Bid",
        "Best bid (single venue or estimated where the tag says so).",
        "quotes",
        "price",
        "bid",
    ),
    FieldDef(
        "px_ask",
        "Ask",
        "Best ask (single venue or estimated where the tag says so).",
        "quotes",
        "price",
        "ask",
    ),
    FieldDef("bid_size", "Bid size", "Size at the best bid.", "quotes", "volume", "bid_size"),
    FieldDef("ask_size", "Ask size", "Size at the best ask.", "quotes", "volume", "ask_size"),
    FieldDef(
        "px_ext",
        "Extended-hours price",
        "Pre- or post-market price.",
        "quotes",
        "price",
        "ext_price",
    ),
    FieldDef(
        "high_52w", "52-week high", "Highest price over 52 weeks.", "quotes", "price", "week52_high"
    ),
    FieldDef(
        "low_52w", "52-week low", "Lowest price over 52 weeks.", "quotes", "price", "week52_low"
    ),
    FieldDef(
        "volume_avg",
        "Average volume",
        "Average daily volume, period as the source states it.",
        "quotes",
        "volume",
        "avg_volume",
    ),
    FieldDef(
        "last_update", "Last update", "Time of the last trade or update.", "quotes", "time", "ts"
    ),
    FieldDef(
        "mkt_cap",
        "Market cap",
        "Market capitalisation in the trading currency.",
        "fundamentals",
        "money",
        "market_cap",
    ),
    FieldDef(
        "pe_ttm",
        "P/E (TTM)",
        "Price over trailing-twelve-month earnings per share.",
        "fundamentals",
        "ratio",
        "pe_trailing",
    ),
    FieldDef(
        "pe_fwd",
        "P/E (forward)",
        "Price over estimated next-year EPS.",
        "fundamentals",
        "ratio",
        "pe_forward",
    ),
    FieldDef(
        "eps_ttm",
        "EPS (TTM)",
        "Trailing-twelve-month earnings per share.",
        "fundamentals",
        "price",
        "eps_trailing",
    ),
    FieldDef(
        "div_yield",
        "Dividend yield",
        "Annual dividend as a percent of price.",
        "fundamentals",
        "pct",
        "dividend_yield",
    ),
    FieldDef("beta", "Beta", "Beta as the source computes it.", "fundamentals", "ratio", "beta"),
    FieldDef(
        "shares_out",
        "Shares outstanding",
        "Shares outstanding.",
        "fundamentals",
        "volume",
        "shares_outstanding",
    ),
    FieldDef("name", "Name", "Security name.", "reference", "text", "name"),
    FieldDef(
        "currency", "Currency", "Trading currency (ISO 4217).", "reference", "text", "currency"
    ),
    FieldDef(
        "exchange",
        "Exchange",
        "Listing exchange as the source names it.",
        "reference",
        "text",
        "exchange",
    ),
    FieldDef(
        "sector", "Sector", "Sector as the source classifies it.", "reference", "text", "sector"
    ),
    FieldDef(
        "industry",
        "Industry",
        "Industry as the source classifies it.",
        "reference",
        "text",
        "industry",
    ),
)

_QUOTE = tuple(f for f in FIELDS if f.domain == "quotes")
_PROFILE = tuple(f for f in FIELDS if f.domain != "quotes")


def normalize_quote(q: Quote) -> dict[str, Any]:
    """Quote -> {field id: value}; a value the source did not give is None (N.A.), never 0."""
    return {f.id: getattr(q, f.attr, None) for f in _QUOTE}


def normalize_profile(p: Profile) -> dict[str, Any]:
    return {f.id: getattr(p, f.attr, None) for f in _PROFILE}


class FieldRegistry:
    """Which providers delivered a value for each field since launch."""

    def __init__(self) -> None:
        self._seen: dict[str, set[str]] = {f.id: set() for f in FIELDS}
        self._lock = threading.Lock()

    def _observe(self, source: str, values: dict[str, Any]) -> None:
        with self._lock:
            for k, v in values.items():
                if v is not None:
                    self._seen[k].add(source)

    def observe_quote(self, source: str, q: Quote) -> None:
        self._observe(source, normalize_quote(q))

    def observe_profile(self, source: str, p: Profile) -> None:
        self._observe(source, normalize_profile(p))

    def rows(self) -> list[FieldInfo]:
        with self._lock:
            return [
                FieldInfo(
                    id=f.id,
                    name=f.name,
                    definition=f.definition,
                    domain=f.domain,
                    kind=f.kind,
                    attr=f.attr,
                    sources=sorted(self._seen[f.id]),
                )
                for f in FIELDS
            ]
