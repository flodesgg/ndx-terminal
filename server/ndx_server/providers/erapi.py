"""open.er-api.com (keyless, daily reference rates): last-resort FX fallback, labelled EOD."""

from __future__ import annotations

import time
from datetime import UTC, datetime
from typing import Any, ClassVar

import httpx

from ..models import AssetClass, Instrument, Latency, Quote
from .base import Capability, DataProvider, NotFound, ProviderError
from .budgets import BUDGETS
from .http import get_json, make_client

URL = "https://open.er-api.com/v6/latest/USD"


def cross_rate(table: dict[str, Any], pair: str) -> float:
    rates = table.get("rates") or {}
    base, quote = pair[:3], pair[3:]
    rb = 1.0 if base == "USD" else rates.get(base)
    rq = 1.0 if quote == "USD" else rates.get(quote)
    if not rb or not rq:
        raise NotFound(f"no reference rate for {pair}")
    return float(rq) / float(rb)


class ErApiProvider(DataProvider):
    name = "erapi"
    label = "ExchangeRate-API (open)"
    capabilities: ClassVar[dict[Capability, frozenset[AssetClass]]] = {
        Capability.QUOTE: frozenset({AssetClass.FX}),
    }

    def __init__(self, client: httpx.AsyncClient | None = None) -> None:
        super().__init__(BUDGETS["erapi"].bucket())
        self.client = client or make_client()
        self._table: dict[str, Any] | None = None
        self._fetched = 0.0

    def latency(self, asset: AssetClass) -> tuple[Latency, int | None]:
        return Latency.EOD, None

    def result_meta(self, asset: AssetClass, value: Any) -> tuple[Latency, int | None, str | None]:
        return Latency.EOD, None, "Daily reference rate (no bid/ask, no change)"

    async def aclose(self) -> None:
        await self.client.aclose()

    async def table(self) -> dict[str, Any]:
        if self._table is None or time.time() - self._fetched > 3600:
            data = await get_json(self.client, URL, "ExchangeRate-API")
            if data.get("result") != "success":
                raise ProviderError(f"ExchangeRate-API: {data.get('error-type', 'error')}")
            self._table, self._fetched = data, time.time()
        return self._table

    async def quote(self, inst: Instrument) -> Quote:
        t = await self.table()
        ts = t.get("time_last_update_unix")
        return Quote(
            symbol=inst.symbol,
            price=cross_rate(t, inst.symbol),
            currency=inst.symbol[3:],
            ts=datetime.fromtimestamp(int(ts), UTC) if ts else None,
        )

    async def quotes(self, insts: list[Instrument]) -> dict[str, Quote]:
        out: dict[str, Quote] = {}
        for inst in insts:
            try:
                out[inst.symbol] = await self.quote(inst)
            except NotFound:
                continue
        return out
