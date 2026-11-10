"""National Bank of Ukraine: official hryvnia exchange rates, keyless JSON.

docs/PROVIDERS.md §3.8: the only official UAH source (ECB has none). One official rate per
currency per day, UAH per unit. After 15:30 Kyiv time the plain endpoint already answers with
the *next* day's rate (seen 2026-11-09: `exchangedate` 10.11.2026), so we ask by date for the
rate in effect today and the day before (two requests per day). Tag `EOD`, note "NBU official
rate"; UAH/xxx (an inverse) is labelled as derived (NBU terms: modifications need approval).
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import date, datetime, time, timedelta
from typing import Any, ClassVar
from zoneinfo import ZoneInfo

import httpx

from .base import LocalRateLimited, ProviderError
from .fxref import Fix, PairRate, ReferenceFxProvider, Table
from .http import get_json, make_client
from .quota import utc_now

URL = "https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange"
KYIV = ZoneInfo("Europe/Kyiv")


def parse_day(rows: Any) -> dict[str, tuple[date, float]]:
    """One date's answer -> currency -> (effective date, UAH per unit)."""
    if not isinstance(rows, list):
        raise ProviderError("NBU: unexpected payload")
    out: dict[str, tuple[date, float]] = {}
    for r in rows:
        try:
            d = datetime.strptime(str(r["exchangedate"]), "%d.%m.%Y").date()
            out[str(r["cc"])] = (d, float(r["rate"]))
        except (KeyError, TypeError, ValueError):
            continue
    return out


def merge(
    today: dict[str, tuple[date, float]], before: dict[str, tuple[date, float]]
) -> dict[str, Fix]:
    fixes: dict[str, Fix] = {}
    for ccy, (day, value) in today.items():
        prev = before.get(ccy)
        fixes[ccy] = Fix(
            day=day,
            value=value,
            prev_day=prev[0] if prev else None,
            prev=prev[1] if prev else None,
        )
    if not fixes:
        raise ProviderError("NBU: no official rates in the answer")
    return fixes


class NbuProvider(ReferenceFxProvider):
    name: ClassVar[str] = "nbu"
    label: ClassVar[str] = "NBU"
    source_note: ClassVar[str] = "NBU official rate"
    derived_note: ClassVar[str] = "derived from the NBU official rate (inverse)"

    def __init__(
        self,
        client: httpx.AsyncClient | None = None,
        clock: Callable[[], datetime] = utc_now,
    ) -> None:
        super().__init__(client or make_client(), clock)

    def handles(self, base: str, quote: str) -> bool:
        return (base == "UAH") != (quote == "UAH")

    def as_of(self, day: date) -> datetime:
        return datetime.combine(day, time(0, 0), KYIV)

    def pair_rate(self, base: str, quote: str, fixes: dict[str, Fix]) -> PairRate | None:
        if quote == "UAH":
            f = fixes.get(base)
            if f is None:
                return None
            return PairRate(price=f.value, prev=f.prev, day=f.day, derived=False)
        f = fixes.get(quote)
        if f is None or not f.value:
            return None
        return PairRate(
            price=1 / f.value,
            prev=1 / f.prev if f.prev else None,
            day=f.day,
            derived=True,
        )

    async def _day(self, d: date) -> dict[str, tuple[date, float]]:
        params = {"json": "", "date": d.strftime("%Y%m%d")}
        return parse_day(await get_json(self._client, URL, "NBU", params=params))

    async def load(self, now: datetime) -> Table:
        today = now.astimezone(KYIV).date()
        current = await self._day(today)
        if not await self.http.acquire(max_wait=3.0):  # the second request has its own token
            raise LocalRateLimited("nbu local rate limit reached")
        before = await self._day(today - timedelta(days=1))  # NBU sets a rate for every day
        midnight = datetime.combine(today + timedelta(days=1), time(0, 5), KYIV)
        return Table(fixes=merge(current, before), fetched_at=now, valid_until=midnight)
