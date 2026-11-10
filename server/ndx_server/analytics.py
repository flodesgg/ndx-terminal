"""Pure analytics: average-cost positions, returns, correlation, volatility, drawdown, beta."""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import UTC, datetime

from .models import Bar


@dataclass
class Holding:
    qty: float = 0.0
    avg_cost: float = 0.0
    realized: float = 0.0


class TradeError(ValueError):
    pass


def apply_trades(trades: list[tuple[str, float, float]]) -> dict[str, Holding]:
    """(symbol, signed qty, price) in time order -> holdings (average-cost method, no shorts)."""
    out: dict[str, Holding] = {}
    for symbol, qty, price in trades:
        h = out.setdefault(symbol, Holding())
        if qty > 0:
            total = h.qty + qty
            h.avg_cost = (h.qty * h.avg_cost + qty * price) / total
            h.qty = total
        elif qty < 0:
            sell = -qty
            if sell > h.qty + 1e-9:
                raise TradeError(f"cannot sell {sell:g} {symbol}: only {h.qty:g} held")
            h.realized += (price - h.avg_cost) * sell
            h.qty -= sell
            if h.qty < 1e-9:
                h.qty, h.avg_cost = 0.0, 0.0
    return out


def closes_by_date(bars: list[Bar]) -> dict[str, float]:
    """Daily bars are encoded as local dates at 00:00 -> 'YYYY-MM-DD' keys."""
    return {datetime.fromtimestamp(b.t, UTC).date().isoformat(): b.c for b in bars}


def returns_on(dates: list[str], closes: dict[str, float]) -> list[float]:
    return [closes[dates[i]] / closes[dates[i - 1]] - 1 for i in range(1, len(dates))]


def common_dates(series: list[dict[str, float]], max_days: int) -> list[str]:
    if not series:
        return []
    common = set(series[0])
    for s in series[1:]:
        common &= set(s)
    return sorted(common)[-(max_days + 1) :]


def mean(xs: list[float]) -> float:
    return sum(xs) / len(xs)


def stdev(xs: list[float]) -> float:
    m = mean(xs)
    return math.sqrt(sum((x - m) ** 2 for x in xs) / (len(xs) - 1))


def pearson(a: list[float], b: list[float]) -> float | None:
    if len(a) != len(b) or len(a) < 3:
        return None
    ma, mb = mean(a), mean(b)
    cov = sum((x - ma) * (y - mb) for x, y in zip(a, b, strict=True))
    va = sum((x - ma) ** 2 for x in a)
    vb = sum((y - mb) ** 2 for y in b)
    if va == 0 or vb == 0:
        return None
    return cov / math.sqrt(va * vb)


def correlation_matrix(returns: list[list[float]]) -> list[list[float | None]]:
    n = len(returns)
    m: list[list[float | None]] = [[None] * n for _ in range(n)]
    for i in range(n):
        for j in range(i, n):
            c = 1.0 if i == j else pearson(returns[i], returns[j])
            m[i][j] = m[j][i] = c
    return m


def max_drawdown(values: list[float]) -> float | None:
    """Most negative peak-to-trough change, e.g. -0.25 for -25%."""
    if len(values) < 2:
        return None
    peak = values[0]
    worst = 0.0
    for v in values:
        peak = max(peak, v)
        if peak > 0:
            worst = min(worst, v / peak - 1)
    return worst


def beta(asset: list[float], market: list[float]) -> float | None:
    if len(asset) != len(market) or len(asset) < 3:
        return None
    mm = mean(market)
    ma = mean(asset)
    var = sum((x - mm) ** 2 for x in market)
    if var == 0:
        return None
    cov = sum((y - ma) * (x - mm) for x, y in zip(market, asset, strict=True))
    return cov / var


def annualized_vol(returns: list[float], periods: int = 252) -> float | None:
    if len(returns) < 3:
        return None
    return stdev(returns) * math.sqrt(periods)
