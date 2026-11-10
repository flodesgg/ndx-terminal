"""CoinGecko (keyless public API; optional demo key): market caps and rankings."""

from __future__ import annotations

from datetime import datetime
from typing import Any, ClassVar

import httpx

from ..models import AssetClass, CryptoMarket, Latency
from .base import Capability, DataProvider
from .budgets import BUDGETS
from .http import get_json, make_client
from .ratelimit import TokenBucket

BASE = "https://api.coingecko.com/api/v3"


def _f(v: Any) -> float | None:
    try:
        return float(v) if v is not None else None
    except (TypeError, ValueError):
        return None


def parse_markets(rows: list[dict[str, Any]]) -> list[CryptoMarket]:
    out: list[CryptoMarket] = []
    for r in rows:
        if not r.get("id") or not r.get("symbol"):
            continue
        lu = r.get("last_updated")
        out.append(
            CryptoMarket(
                id=r["id"],
                symbol=str(r["symbol"]).upper(),
                name=r.get("name") or r["id"],
                rank=r.get("market_cap_rank"),
                price_usd=_f(r.get("current_price")),
                change_24h_pct=_f(
                    r.get("price_change_percentage_24h_in_currency")
                    or r.get("price_change_percentage_24h")
                ),
                change_7d_pct=_f(r.get("price_change_percentage_7d_in_currency")),
                market_cap=_f(r.get("market_cap")),
                volume_24h=_f(r.get("total_volume")),
                last_updated=datetime.fromisoformat(lu.replace("Z", "+00:00")) if lu else None,
            )
        )
    return out


class CoinGeckoProvider(DataProvider):
    name = "coingecko"
    label = "CoinGecko"
    capabilities: ClassVar[dict[Capability, frozenset[AssetClass]]] = {
        Capability.MARKETCAP: frozenset({AssetClass.CRYPTO}),
    }

    def __init__(
        self,
        api_key: str = "",
        client: httpx.AsyncClient | None = None,
        rate: TokenBucket | None = None,
    ) -> None:
        headers = {"x-cg-demo-api-key": api_key} if api_key else None
        super().__init__(rate or BUDGETS["coingecko"].bucket(), api_key=api_key)
        self.client = client or make_client(headers=headers)

    def latency(self, asset: AssetClass) -> tuple[Latency, int | None]:
        return Latency.STATIC, None

    def result_meta(self, asset: AssetClass, value: Any) -> tuple[Latency, int | None, str | None]:
        # Aggregated cached snapshot, not a venue feed -> CACHE hh:mm (PROVIDERS §2).
        return Latency.STATIC, None, "Data provided by CoinGecko (aggregated snapshot)"

    async def aclose(self) -> None:
        await self.client.aclose()

    async def markets(self, limit: int) -> list[CryptoMarket]:
        rows = await get_json(
            self.client,
            f"{BASE}/coins/markets",
            "CoinGecko",
            {
                "vs_currency": "usd",
                "order": "market_cap_desc",
                "per_page": min(250, limit),
                "page": 1,
                "price_change_percentage": "24h,7d",
            },
        )
        return parse_markets(rows if isinstance(rows, list) else [])
