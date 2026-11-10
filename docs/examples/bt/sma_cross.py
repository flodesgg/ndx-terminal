# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""SMA crossover vs buy-and-hold on daily closes. Args: SYMBOL [FAST=50] [SLOW=200]."""

from __future__ import annotations

import json
import math
import os
import sys
import urllib.request
from datetime import UTC, datetime


def fetch_closes(symbol: str) -> list[tuple[str, float]]:
    """Daily closes from the running NDX Terminal (same sources/labels as the GP chart)."""
    api = os.environ["NDX_API_URL"]
    req = urllib.request.Request(
        f"{api}/bars/{symbol}?interval=1d",
        headers={"x-ndx-token": os.environ.get("NDX_API_TOKEN", "")},
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        payload = json.load(resp)
    print(f"data: {payload['meta']['source']} ({payload['meta']['latency']}), "
          f"{len(payload['data'])} bars", file=sys.stderr)
    return [(datetime.fromtimestamp(b["t"], UTC).date().isoformat(), b["c"])
            for b in payload["data"]]


def sma(xs: list[float], n: int) -> list[float | None]:
    out: list[float | None] = [None] * len(xs)
    s = 0.0
    for i, x in enumerate(xs):
        s += x
        if i >= n:
            s -= xs[i - n]
        if i >= n - 1:
            out[i] = s / n
    return out


def max_dd(values: list[float]) -> float:
    peak, worst = values[0], 0.0
    for v in values:
        peak = max(peak, v)
        worst = min(worst, v / peak - 1)
    return worst


def main() -> None:
    symbol = sys.argv[1] if len(sys.argv) > 1 else "SPY"
    fast = int(sys.argv[2]) if len(sys.argv) > 2 else 50
    slow = int(sys.argv[3]) if len(sys.argv) > 3 else 200
    rows = fetch_closes(symbol)
    dates = [d for d, _ in rows]
    closes = [c for _, c in rows]
    f, s = sma(closes, fast), sma(closes, slow)
    equity, bench = [10_000.0], [10_000.0]
    rets: list[float] = []
    in_market = 0
    trades = 0
    pos = 0
    for i in range(1, len(closes)):
        r = closes[i] / closes[i - 1] - 1
        strat_r = r if pos else 0.0
        rets.append(strat_r)
        equity.append(equity[-1] * (1 + strat_r))
        bench.append(bench[-1] * (1 + r))
        in_market += pos
        # Signal on today's close, position from tomorrow (no look-ahead).
        want = 1 if f[i] is not None and s[i] is not None and f[i] > s[i] else 0  # type: ignore[operator]
        trades += want != pos
        pos = want
    years = max(1e-9, (len(closes) - 1) / 252)
    mu = sum(rets) / len(rets)
    sd = math.sqrt(sum((x - mu) ** 2 for x in rets) / (len(rets) - 1)) if len(rets) > 1 else 0
    result = {
        "equity": [{"t": d, "v": round(v, 2)} for d, v in zip(dates, equity, strict=True)],
        "benchmark": [{"t": d, "v": round(v, 2)} for d, v in zip(dates, bench, strict=True)],
        "stats": {
            "Strategy": f"SMA {fast}/{slow} on {symbol}",
            "CAGR %": round(((equity[-1] / equity[0]) ** (1 / years) - 1) * 100, 2),
            "Buy&hold CAGR %": round(((bench[-1] / bench[0]) ** (1 / years) - 1) * 100, 2),
            "Sharpe (rf=0)": round(mu / sd * math.sqrt(252), 2) if sd else None,
            "Max drawdown %": round(max_dd(equity) * 100, 2),
            "Buy&hold max DD %": round(max_dd(bench) * 100, 2),
            "Trades": trades,
            "Exposure %": round(in_market / (len(closes) - 1) * 100, 1),
        },
    }
    with open(os.environ["NDX_BT_OUTPUT"], "w") as fh:
        json.dump(result, fh)
    print(f"done: final equity {equity[-1]:.2f}")


if __name__ == "__main__":
    main()
