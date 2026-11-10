"""Finnhub free tier (API key): US quotes, company and market news, company profile."""

from __future__ import annotations

import hashlib
from datetime import UTC, date, datetime, timedelta
from typing import Any, ClassVar

import httpx

from ..models import (
    AssetClass,
    Instrument,
    Latency,
    NewsAsset,
    NewsItem,
    NewsTopic,
    Profile,
    Quote,
)
from .base import AuthError, Capability, DataProvider, NotFound, NotSupported, ProviderError
from .budgets import BUDGETS
from .http import get_json, make_client
from .ratelimit import TokenBucket

BASE = "https://finnhub.io/api/v1"
EQ = frozenset({AssetClass.EQUITY})


def _us_symbol(inst: Instrument) -> bool:
    # The free tier covers US listings; exchange-suffixed symbols (NOVO-B.CO) are not supported.
    return inst.asset_class is AssetClass.EQUITY and "." not in inst.symbol


def parse_quote(symbol: str, raw: dict[str, Any]) -> Quote:
    if not raw or not raw.get("t") or not raw.get("c"):
        raise NotFound(f"Finnhub has no quote for {symbol}")
    return Quote(
        symbol=symbol,
        price=float(raw["c"]),
        change=raw.get("d"),
        change_pct=raw.get("dp"),
        prev_close=raw.get("pc") or None,
        open=raw.get("o") or None,
        high=raw.get("h") or None,
        low=raw.get("l") or None,
        ts=datetime.fromtimestamp(int(raw["t"]), UTC),
    )


# Finnhub's market-news categories (docs: general, forex, crypto, merger).
NEWS_CATEGORIES = ("general", "forex", "crypto", "merger")
_CATEGORY_ASSETS: dict[str, list[NewsAsset]] = {"forex": ["FX"], "crypto": ["CRYPTO"]}
_CATEGORY_TOPICS: dict[str, list[NewsTopic]] = {"merger": ["M&A"]}


def parse_news(
    rows: list[dict[str, Any]], provider: str = "Finnhub", category: str | None = None
) -> list[NewsItem]:
    out: list[NewsItem] = []
    for r in rows:
        url = r.get("url")
        headline = r.get("headline")
        ts = r.get("datetime")
        if not url or not headline or not ts:
            continue
        related = [t for t in str(r.get("related") or "").split(",") if t]
        out.append(
            NewsItem(
                id=hashlib.sha1(url.encode()).hexdigest()[:16],
                headline=headline.strip(),
                summary=(r.get("summary") or None),
                url=url,
                source=r.get("source") or "Finnhub",
                provider=provider,
                published=datetime.fromtimestamp(int(ts), UTC),
                tickers=related,
                summary_note=None if r.get("summary") else "Finnhub gave no summary",
                asset_classes=list(_CATEGORY_ASSETS.get(category or "", [])),
                topics=list(_CATEGORY_TOPICS.get(category or "", [])),
            )
        )
    return out


def parse_profile(inst: Instrument, raw: dict[str, Any]) -> Profile:
    if not raw or not raw.get("name"):
        raise NotFound(f"Finnhub has no profile for {inst.symbol}")
    mcap = raw.get("marketCapitalization")
    shares = raw.get("shareOutstanding")
    return Profile(
        symbol=inst.symbol,
        name=raw.get("name"),
        asset_class=inst.asset_class,
        quote_type="EQUITY",
        exchange=raw.get("exchange"),
        currency=raw.get("currency"),
        country=raw.get("country"),
        industry=raw.get("finnhubIndustry"),
        website=raw.get("weburl") or None,
        market_cap=float(mcap) * 1e6 if mcap else None,  # Finnhub reports millions
        shares_outstanding=float(shares) * 1e6 if shares else None,
        extra={"ipo": raw.get("ipo")} if raw.get("ipo") else {},
    )


class FinnhubProvider(DataProvider):
    name = "finnhub"
    label = "Finnhub"
    requires_key = True
    capabilities: ClassVar[dict[Capability, frozenset[AssetClass]]] = {
        Capability.QUOTE: EQ,
        Capability.PROFILE: EQ,
        Capability.NEWS: frozenset(AssetClass),
    }

    def __init__(
        self, api_key: str, client: httpx.AsyncClient | None = None, rate: TokenBucket | None = None
    ) -> None:
        super().__init__(rate or BUDGETS["finnhub"].bucket(), api_key=api_key)
        self.client = client or make_client()

    def latency(self, asset: AssetClass) -> tuple[Latency, int | None]:
        return Latency.REALTIME, None

    def result_meta(self, asset: AssetClass, value: Any) -> tuple[Latency, int | None, str | None]:
        if isinstance(value, Quote):
            return Latency.REALTIME, None, "Finnhub /quote: US last trade (bid/ask premium -> N.A.)"
        return Latency.STATIC, None, None  # profiles, news: record timestamps + CACHE

    def venue(self, asset: AssetClass, value: Any) -> str | None:
        return "TRD"  # last-trade print, not a consolidated quote -> RT·TRD (PROVIDERS §3.1)

    async def aclose(self) -> None:
        await self.client.aclose()

    async def _get(self, path: str, params: dict[str, Any]) -> Any:
        try:
            # Key in a header (documented alternative to `token=`) so it never sits in a URL.
            return await get_json(
                self.client,
                f"{BASE}{path}",
                "Finnhub",
                params,
                headers={"X-Finnhub-Token": self.api_key},
            )
        except ProviderError as exc:
            if " 401" in str(exc) or " 403" in str(exc):
                raise AuthError("Finnhub rejected the API key or endpoint (401/403)") from exc
            raise

    def serves(self, cap: Capability, inst: Instrument | None) -> bool:
        return inst is None or _us_symbol(inst)

    async def quote(self, inst: Instrument) -> Quote:
        if not _us_symbol(inst):
            raise NotSupported("Finnhub free tier: US equities only")
        return parse_quote(inst.symbol, await self._get("/quote", {"symbol": inst.symbol}))

    async def profile(self, inst: Instrument) -> Profile:
        if not _us_symbol(inst):
            raise NotSupported("Finnhub free tier: US equities only")
        return parse_profile(inst, await self._get("/stock/profile2", {"symbol": inst.symbol}))

    async def news(self, inst: Instrument | None, limit: int) -> list[NewsItem]:
        if inst is None:
            # Market news by category: the category names the asset class / topic (news.py
            # filters). One token per call: the router took the first, the rest wait briefly
            # and are skipped (not faked) when the budget has none.
            items: list[NewsItem] = []
            for i, cat in enumerate(NEWS_CATEGORIES):
                if i and not await self.rate.acquire(max_wait=3.0):
                    break
                rows = await self._get("/news", {"category": cat})
                items.extend(parse_news(rows if isinstance(rows, list) else [], category=cat))
            return sorted(items, key=lambda n: n.published, reverse=True)[: max(limit, 120)]
        else:
            if not _us_symbol(inst):
                raise NotSupported("Finnhub company news: North American equities only")
            to = date.today()
            rows = await self._get(
                "/company-news",
                {
                    "symbol": inst.symbol,
                    "from": (to - timedelta(days=10)).isoformat(),
                    "to": to.isoformat(),
                },
            )
        items = parse_news(rows if isinstance(rows, list) else [])
        return sorted(items, key=lambda n: n.published, reverse=True)[:limit]
