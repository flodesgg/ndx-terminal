"""ECB Data Portal: euro foreign exchange reference rates (EXR), keyless SDMX REST.

docs/PROVIDERS.md §3.7: one daily fixing per currency vs EUR (concertation at 2:15 pm CET,
published around 16:00 CET on TARGET days), 29 live currencies — no UAH (NBU) and no RUB.
"For information only": tag `EOD`, note "ECB euro reference rate"; an inverse (USD/EUR) or a
cross (USD/DKK) computed from two fixings is labelled as derived (ECB reuse policy: statistics
must not be modified).
"""

from __future__ import annotations

import csv
import io
from collections.abc import Callable
from datetime import date, datetime, time, timedelta
from typing import ClassVar
from zoneinfo import ZoneInfo

import httpx

from .base import NetworkError, ProviderError, TransientError
from .fxref import Fix, PairRate, ReferenceFxProvider, Table
from .http import check, make_client
from .quota import utc_now

URL = "https://data-api.ecb.europa.eu/service/data/EXR/D..EUR.SP00.A"
CET = ZoneInfo("Europe/Berlin")
FIXING_TIME = time(14, 15)  # "Indicative exchange rate ... 2:15 pm (C.E.T.)" (series title)
PUBLISHED = time(16, 15)  # published "around 16:00 CET"; a quarter of an hour of slack
LAST_TRY = time(20, 0)  # after this a missing fixing is a holiday, not a late one
RETRY = timedelta(hours=1)
# Series the ECB stopped (ARS since 2020, RUB since 2022-03-01, legacy euro-area currencies)
# still answer `lastNObservations`; anything not fixed for two weeks is not offered.
DISCONTINUED_AFTER = timedelta(days=14)


def parse_exr(text: str, now: datetime) -> dict[str, Fix]:
    """`format=csvdata&detail=dataonly` rows -> latest two fixings per live currency."""
    obs: dict[str, list[tuple[date, float]]] = {}
    for r in csv.DictReader(io.StringIO(text)):
        try:
            ccy = r["CURRENCY"]
            day = date.fromisoformat(r["TIME_PERIOD"])
            value = float(r["OBS_VALUE"])
        except (KeyError, TypeError, ValueError):
            continue  # a row without a value (NaN, empty) is skipped, never filled
        obs.setdefault(ccy, []).append((day, value))
    cutoff = (now - DISCONTINUED_AFTER).date()
    fixes: dict[str, Fix] = {}
    for ccy, rows in obs.items():
        rows.sort()
        day, value = rows[-1]
        if day < cutoff:
            continue
        prev = rows[-2] if len(rows) > 1 else None
        fixes[ccy] = Fix(
            day=day,
            value=value,
            prev_day=prev[0] if prev else None,
            prev=prev[1] if prev else None,
        )
    if not fixes:
        raise ProviderError("ECB: no current reference rates in the EXR answer")
    return fixes


def _next_weekday(d: date) -> date:
    d += timedelta(days=1)
    while d.weekday() >= 5:
        d += timedelta(days=1)
    return d


def valid_until(fetched_at: datetime, newest: date) -> datetime:
    """Next time a new fixing can be expected: today's publication, or (once it is in, or
    on a weekend/holiday evening) the next weekday's; a fixing late on a weekday is retried."""
    local = fetched_at.astimezone(CET)
    today_pub = datetime.combine(local.date(), PUBLISHED, CET)
    if local < today_pub:
        return today_pub
    if newest >= local.date() or local.weekday() >= 5 or local.time() >= LAST_TRY:
        return datetime.combine(_next_weekday(local.date()), PUBLISHED, CET)
    return fetched_at + RETRY


class EcbProvider(ReferenceFxProvider):
    name: ClassVar[str] = "ecb"
    label: ClassVar[str] = "ECB"
    source_note: ClassVar[str] = "ECB euro reference rate (2:15 pm CET)"
    derived_note: ClassVar[str] = "derived from ECB euro reference rates (2:15 pm CET)"

    def __init__(
        self,
        client: httpx.AsyncClient | None = None,
        clock: Callable[[], datetime] = utc_now,
    ) -> None:
        super().__init__(client or make_client(), clock)

    def handles(self, base: str, quote: str) -> bool:
        return "UAH" not in (base, quote) and "RUB" not in (base, quote)

    def as_of(self, day: date) -> datetime:
        return datetime.combine(day, FIXING_TIME, CET)

    def pair_rate(self, base: str, quote: str, fixes: dict[str, Fix]) -> PairRate | None:
        def leg(c: str) -> Fix | None:
            return Fix(day=date.max, value=1.0, prev=1.0) if c == "EUR" else fixes.get(c)

        b, q = leg(base), leg(quote)
        if b is None or q is None:
            return None
        prev = q.prev / b.prev if q.prev is not None and b.prev else None
        return PairRate(
            price=q.value / b.value,
            prev=prev,
            day=min(b.day, q.day),
            derived=base != "EUR",  # only EUR/xxx is published as is
        )

    async def load(self, now: datetime) -> Table:
        params = {"lastNObservations": "2", "format": "csvdata", "detail": "dataonly"}
        try:
            resp = await self._client.get(URL, params=params)
        except (httpx.ConnectError, httpx.ConnectTimeout) as exc:
            raise NetworkError(f"ECB: {type(exc).__name__}") from exc
        except (httpx.TimeoutException, httpx.NetworkError, httpx.RemoteProtocolError) as exc:
            raise TransientError(f"ECB: {type(exc).__name__}") from exc
        check(resp, "ECB")
        fixes = parse_exr(resp.text, now)
        newest = max(f.day for f in fixes.values())
        return Table(fixes=fixes, fetched_at=now, valid_until=valid_until(now, newest))
