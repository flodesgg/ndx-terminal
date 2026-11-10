"""Paper portfolio valuation, exposure and risk; correlation matrix."""

from __future__ import annotations

import asyncio
import logging
from datetime import UTC, datetime
from typing import Any

from .analytics import (
    TradeError,
    annualized_vol,
    apply_trades,
    beta,
    closes_by_date,
    common_dates,
    correlation_matrix,
    max_drawdown,
    returns_on,
)
from .db import Database
from .market import MarketService
from .models import (
    AssetClass,
    CorrelationResponse,
    Exposure,
    PortfolioResponse,
    Position,
    Quote,
    RiskMetrics,
)
from .providers.router import RouterError
from .symbols import classify

log = logging.getLogger("ndx.portfolio")

DEFAULT_BASE = "DKK"  # SPEC §8 PORT: base currency DKK by default, configurable in PDF
BASE_SETTING = "pdf.base_currency"
# Yahoo quotes some markets in minor units.
MINOR_UNITS = {
    "GBp": ("GBP", 100.0),
    "GBX": ("GBP", 100.0),
    "ZAc": ("ZAR", 100.0),
    "ILA": ("ILS", 100.0),
}
RISK_DAYS = 252


def normalize_ccy(ccy: str | None) -> tuple[str | None, float]:
    if ccy in MINOR_UNITS:
        major, div = MINOR_UNITS[ccy]
        return major, div
    return ccy, 1.0


class PortfolioService:
    def __init__(self, db: Database, market: MarketService) -> None:
        self.db = db
        self.market = market

    def holdings(self) -> tuple[dict[str, Any], float]:
        trades = self.db.list_trades()
        hs = apply_trades([(t["symbol"], t["qty"], t["price"]) for t in trades])
        realized = sum(h.realized for h in hs.values())
        return {s: h for s, h in hs.items() if h.qty > 0}, realized

    def validate_trade(self, symbol: str, qty: float) -> None:
        trades = [(t["symbol"], t["qty"], t["price"]) for t in self.db.list_trades()]
        apply_trades([*trades, (symbol, qty, 1.0)])  # raises TradeError

    def base_currency(self) -> str:
        raw = self.db.get_setting(BASE_SETTING)
        value = raw.get("value") if isinstance(raw, dict) else raw
        return str(value).upper() if isinstance(value, str) and len(value) == 3 else DEFAULT_BASE

    async def _fx(self, currencies: set[str], base: str) -> tuple[dict[str, float], list[str]]:
        """Units of `base` per 1 unit of each currency, from FX quotes only. No assumed rates:
        stablecoins (USDT...) are not treated as USD, and a missing rate excludes the position
        from totals with a warning (SPEC §1.2, B8)."""
        rates: dict[str, float] = {base: 1.0} if base in currencies else {}
        need = sorted(c for c in currencies if c != base)
        warnings: list[str] = []
        if need:
            res = await self.market.quotes([f"{c}{base}" for c in need])
            got = {i.symbol: i for i in res.items}
            for c in need:
                item = got.get(f"{c}{base}")
                if item and item.data and item.data.price:
                    rates[c] = item.data.price
                else:
                    warnings.append(f"no {c}→{base} rate: positions in {c} excluded from totals")
        return rates, warnings

    async def _sector(self, symbol: str, asset: AssetClass) -> str:
        if asset is not AssetClass.EQUITY:
            return {
                AssetClass.CRYPTO: "Crypto",
                AssetClass.FX: "FX",
                AssetClass.INDEX: "Index/Futures",
            }[asset]
        try:
            p = await self.market.profile(symbol)
        except Exception:
            return "Unknown"
        if p.data.quote_type == "ETF":
            return "ETF"
        return p.data.sector or "Unknown"

    async def summary(self, with_risk: bool = True) -> PortfolioResponse:
        holdings, realized = self.holdings()
        symbols = sorted(holdings)
        quotes: dict[str, Any] = {}
        if symbols:
            res = await self.market.quotes(symbols)
            quotes = {i.symbol: i for i in res.items}
        ccys: dict[str, tuple[str | None, float]] = {}
        for s in symbols:
            qi = quotes.get(s)
            ccys[s] = normalize_ccy(qi.data.currency if qi and qi.data else None)
        base = self.base_currency()
        fx, warnings = await self._fx({c for c, _ in ccys.values() if c}, base)
        sectors = await asyncio.gather(*(self._sector(s, classify(s).asset_class) for s in symbols))
        positions: list[Position] = []
        for s, sector in zip(symbols, sectors, strict=True):
            h = holdings[s]
            item = quotes.get(s)
            q: Quote | None = item.data if item else None
            ccy, div = ccys[s]
            rate = fx.get(ccy) if ccy else None
            last = q.price / div if q and q.price is not None else None
            avg = h.avg_cost  # trades are recorded in the instrument's quote units
            mv = h.qty * last * rate if last is not None and rate is not None else None
            cost = h.qty * (avg / div) * rate if rate is not None else None
            prev = q.prev_close / div if q and q.prev_close else None
            day = h.qty * (last - prev) * rate if last and prev and rate else None
            if item is not None and item.error:
                warnings.append(f"{s}: {item.error}")
            elif q is not None and not ccy:
                warnings.append(f"{s}: source reports no currency; excluded from totals")
            positions.append(
                Position(
                    symbol=s,
                    asset_class=classify(s).asset_class,
                    qty=h.qty,
                    avg_cost=avg,
                    currency=ccy,
                    last=last,
                    fx_to_base=rate,
                    market_value=mv,
                    cost_basis=cost,
                    unrealized_pnl=mv - cost if mv is not None and cost is not None else None,
                    unrealized_pct=(mv / cost - 1) * 100 if mv is not None and cost else None,
                    day_pnl=day,
                    sector=sector,
                    quote_meta=item.meta if item else None,
                )
            )
        valued = [p for p in positions if p.market_value is not None]
        total = sum(p.market_value or 0 for p in valued) if valued else None
        total_cost = sum(p.cost_basis or 0 for p in valued) if valued else None
        for p in positions:
            p.weight = (p.market_value / total * 100) if total and p.market_value else None

        def exposure(key: str) -> list[Exposure]:
            agg: dict[str, float] = {}
            for p in valued:
                k = str(getattr(p, key) or "Unknown")
                agg[k] = agg.get(k, 0.0) + (p.market_value or 0.0)
            return sorted(
                (
                    Exposure(name=k, value=v, weight=v / total * 100 if total else 0.0)
                    for k, v in agg.items()
                ),
                key=lambda e: -e.value,
            )

        divisors = {sym: ccys[sym][1] for sym in symbols}
        risk = await self._risk(valued, divisors) if with_risk and valued else None
        days = [p.day_pnl for p in valued if p.day_pnl is not None]
        partial = len(valued) < len(positions)
        if partial:
            warnings.append(f"PARTIAL: totals cover {len(valued)} of {len(positions)} positions")
        return PortfolioResponse(
            base_currency=base,
            partial=partial,
            total_value=total,
            total_cost=total_cost,
            unrealized_pnl=total - total_cost
            if total is not None and total_cost is not None
            else None,
            realized_pnl=realized,
            day_pnl=sum(days) if days else None,
            positions=positions,
            by_sector=exposure("sector"),
            by_asset_class=exposure("asset_class"),
            risk=risk,
            warnings=list(dict.fromkeys(warnings)),
            as_of=datetime.now(UTC),
        )

    async def _daily(self, symbol: str) -> dict[str, float]:
        res = await self.market.bars(symbol, "1d", None)
        return closes_by_date(res.data)

    async def _risk(
        self, positions: list[Position], divisors: dict[str, float]
    ) -> RiskMetrics | None:
        syms = [p.symbol for p in positions]
        try:
            series = await asyncio.gather(*(self._daily(s) for s in [*syms, "SPY"]))
        except RouterError as exc:
            return RiskMetrics(days=0, method=f"unavailable: {exc}")
        dates = common_dates(list(series), RISK_DAYS)
        if len(dates) < 30:
            return RiskMetrics(days=len(dates), method="not enough overlapping history")
        values = []
        for d in dates:
            v = 0.0
            for p, closes in zip(positions, series[:-1], strict=True):
                v += p.qty * closes[d] / divisors.get(p.symbol, 1.0) * (p.fx_to_base or 0.0)
            values.append(v)
        port_ret = [values[i] / values[i - 1] - 1 for i in range(1, len(values))]
        spy_ret = returns_on(dates, series[-1])
        return RiskMetrics(
            days=len(port_ret),
            volatility_ann=annualized_vol(port_ret),
            max_drawdown=max_drawdown(values),
            beta_vs_spy=beta(port_ret, spy_ret),
            method=f"current holdings over the last {len(port_ret)} common trading days; "
            "FX at today's rate; daily closes",
        )

    async def correlation(self, symbols: list[str], days: int) -> CorrelationResponse:
        syms: list[str] = []
        for s in symbols:
            c = classify(s).symbol
            if c not in syms:
                syms.append(c)
        results = await asyncio.gather(
            *(self.market.bars(s, "1d", None) for s in syms), return_exceptions=True
        )
        ok_syms: list[str] = []
        series: list[dict[str, float]] = []
        errors: list[str] = []
        sources: set[str] = set()
        for s, r in zip(syms, results, strict=True):
            if isinstance(r, BaseException):
                errors.append(f"{s}: {r}")
                continue
            ok_syms.append(s)
            series.append(closes_by_date(r.data))
            sources.add(r.meta.source)
        dates = common_dates(series, days)
        rets = [returns_on(dates, s) for s in series] if len(dates) > 3 else []
        matrix = correlation_matrix(rets) if rets else [[None] * len(ok_syms) for _ in ok_syms]
        return CorrelationResponse(
            symbols=ok_syms,
            matrix=matrix,
            days=max(0, len(dates) - 1),
            start=dates[0] if dates else None,
            end=dates[-1] if dates else None,
            errors=errors,
            sources=sorted(sources),
        )


__all__ = ["PortfolioService", "TradeError"]
