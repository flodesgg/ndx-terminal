"""GDELT DOC 2.0 article lists: company news where Finnhub's free tier has none (outside North
America, e.g. NOVOB DC). Keyless; headline + link + domain only (no summary field, PROVIDERS
§3.14); the time is when GDELT first saw the article ("seendate"), said so in the note.

Terms: cite and link the GDELT Project (HELP → Data sources). Limit: one request every 5 s per
the server's own 429 message, so the budget is 6/min with no burst and a long cache.
"""

from __future__ import annotations

import hashlib
import re
from datetime import UTC, datetime
from typing import Any, ClassVar

import httpx

from ..models import AssetClass, Instrument, Latency, NewsItem
from .base import Capability, DataProvider, NotSupported, TransientError
from .budgets import BUDGETS
from .http import check, make_client

URL = "https://api.gdeltproject.org/api/v2/doc/doc"
NOTE = "GDELT: headlines and links only; time = when GDELT first saw the article"
# Share-class and legal suffixes that make a quoted name query miss ("Novo Nordisk B").
_CLASS = re.compile(r"\s+(?:class\s+)?[A-C]$|\s+\((?:DEMO)\)$", re.IGNORECASE)


def company_query(name: str) -> str:
    base = _CLASS.sub("", name.strip()).replace('"', "")
    return f'"{base}" sourcelang:english'


def parse_articles(raw: Any, limit: int) -> list[NewsItem]:
    rows = raw.get("articles", []) if isinstance(raw, dict) else []
    out: list[NewsItem] = []
    for r in rows:
        url, title, seen = r.get("url"), r.get("title"), r.get("seendate")
        if not url or not title or not seen:
            continue
        try:
            ts = datetime.strptime(str(seen), "%Y%m%dT%H%M%SZ").replace(tzinfo=UTC)
        except ValueError:
            continue
        out.append(
            NewsItem(
                id=hashlib.sha1(str(url).encode()).hexdigest()[:16],
                headline=" ".join(str(title).split()),
                summary=None,
                summary_note="GDELT gives headlines and links only",
                url=str(url),
                source=str(r.get("domain") or "GDELT"),
                provider="GDELT",
                published=ts,
            )
        )
    out.sort(key=lambda n: n.published, reverse=True)
    return out[:limit]


class GdeltProvider(DataProvider):
    name = "gdelt"
    label = "GDELT Project"
    capabilities: ClassVar[dict[Capability, frozenset[AssetClass]]] = {
        Capability.NEWS: frozenset({AssetClass.EQUITY}),
    }

    def __init__(self, client: httpx.AsyncClient | None = None) -> None:
        super().__init__(BUDGETS["gdelt"].bucket())
        self.client = client or make_client(timeout=20.0)

    def latency(self, asset: AssetClass) -> tuple[Latency, int | None]:
        return Latency.STATIC, None

    def result_meta(self, asset: AssetClass, value: Any) -> tuple[Latency, int | None, str | None]:
        return Latency.STATIC, None, NOTE

    def cache_ttl(self, inst: Instrument | None, value: Any, ttl: float) -> float:
        return max(ttl, 900.0)  # 15 min: one request every 5 s is the whole budget

    def serves(self, cap: Capability, inst: Instrument | None) -> bool:
        # Company news outside North America only; Finnhub covers US listings.
        return inst is not None and inst.asset_class is AssetClass.EQUITY and "." in inst.symbol

    async def aclose(self) -> None:
        await self.client.aclose()

    async def news(self, inst: Instrument | None, limit: int) -> list[NewsItem]:
        if not self.serves(Capability.NEWS, inst):
            raise NotSupported("GDELT: company news outside North America only")
        assert inst is not None
        from ..secmaster import SymbologyError, symbology

        try:
            name = symbology().security(inst.id or inst.symbol).name
        except SymbologyError:
            name = None
        if not name:
            raise NotSupported(f"GDELT: no company name known for {inst.id or inst.symbol}")
        params = {
            "query": company_query(name),
            "mode": "artlist",
            "format": "json",
            "maxrecords": str(min(max(limit, 10), 75)),
            "sort": "datedesc",
            "timespan": "7d",
        }
        try:
            resp = await self.client.get(URL, params=params)
        except httpx.HTTPError as exc:
            raise TransientError(f"GDELT: {type(exc).__name__}") from exc
        check(resp, "GDELT")
        try:
            raw = resp.json()
        except ValueError as exc:  # GDELT answers plain text for a bad query
            raise TransientError(f"GDELT: {resp.text[:120]}") from exc
        return parse_articles(raw, limit)
