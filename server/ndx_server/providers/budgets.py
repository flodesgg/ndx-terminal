"""Request budgets per provider: docs/PROVIDERS.md §6 ("Budget we use"), one token bucket each.

`limit` requests per `period_s`, bursting up to `burst`. PROV shows the used/left counters of
the current window. Budgets for providers without a documented limit are self-imposed and say
so in `note`.
"""

from __future__ import annotations

from dataclasses import dataclass

from .ratelimit import TokenBucket

MIN, HOUR, DAY = 60.0, 3600.0, 86400.0


@dataclass(frozen=True)
class Budget:
    limit: float
    period_s: float
    burst: float | None = None
    note: str = ""

    def bucket(self) -> TokenBucket:
        return TokenBucket.from_budget(self.limit, self.period_s, self.burst)


BUDGETS: dict[str, Budget] = {
    "finnhub": Budget(55, MIN, 10),
    "tiingo": Budget(40, HOUR),
    "massive": Budget(4, MIN, 1),
    "eodhd": Budget(18, DAY, note="one EOD call per symbol after the close"),
    "wikipedia": Budget(1, MIN, 1, note="serial; at most one refresh a day per list"),
    "yahoo": Budget(60, MIN, 10, note="self-imposed (not documented)"),
    # 3000 weight/min budget; ticker/klines weigh 2, exchangeInfo 20 (rare)
    "binance": Budget(600, MIN, 40),
    "coinbase": Budget(4, 1.0, 4),
    "coingecko": Budget(30, MIN, 5, note="plus 10,000 calls/month (Demo plan)"),
    "ecb": Budget(30, MIN, note="self-imposed (not documented)"),
    "ecbstat": Budget(20, MIN, note="self-imposed (not documented); ECO calendars + SDMX"),
    "nbu": Budget(10, MIN, note="self-imposed (not documented)"),
    "fred": Budget(100, MIN, 10),
    "fredcsv": Budget(30, MIN, 8, note="not in any live chain"),
    "treasury": Budget(10, MIN, 4, note="self-imposed (not documented)"),
    "eurostat": Budget(10, MIN, 1, note="fair use, concurrency 1"),
    "dst": Budget(30, MIN, note="self-imposed (not documented)"),
    "worldbank": Budget(30, MIN, note="self-imposed (not documented)"),
    "bls": Budget(400, DAY, 10),
    "bea": Budget(60, MIN, 10),
    "fed": Budget(10, MIN, 2, note="self-imposed (not documented)"),
    "sec": Budget(5, 1.0, 5),
    "gdelt": Budget(6, MIN, 1),
    "alphavantage": Budget(20, DAY, 5, note="rare backfills only, never live"),
    "rss": Budget(30, MIN, 10, note="self-imposed (publishers' feeds)"),
    "erapi": Budget(6, MIN, 2, note="not in any live chain"),
}


def budget(name: str) -> Budget | None:
    return BUDGETS.get(name)
