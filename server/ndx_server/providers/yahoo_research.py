"""Yahoo Finance research endpoints: fundamentals, SEC filings list, insider transactions,
economic calendar and the equity screener. Pure parsers + a mixin used by YahooProvider."""

from __future__ import annotations

import json
import time
from collections.abc import Callable
from datetime import UTC, date, datetime
from typing import TYPE_CHECKING, Any

from ..models import (
    EconEvent,
    Filing,
    InsiderTxn,
    Instrument,
    ScreenRow,
    Statement,
    StatementLine,
)
from .base import NotFound, NotSupported, ProviderError

if TYPE_CHECKING:  # pragma: no cover
    from collections.abc import Awaitable

Q1 = "https://query1.finance.yahoo.com"
Q2 = "https://query2.finance.yahoo.com"

INCOME: list[tuple[str, str]] = [
    ("TotalRevenue", "Revenue"),
    ("CostOfRevenue", "Cost of revenue"),
    ("GrossProfit", "Gross profit"),
    ("ResearchAndDevelopment", "R&D"),
    ("SellingGeneralAndAdministration", "SG&A"),
    ("OperatingIncome", "Operating income"),
    ("EBITDA", "EBITDA"),
    ("PretaxIncome", "Pre-tax income"),
    ("TaxProvision", "Tax provision"),
    ("NetIncome", "Net income"),
    ("DilutedEPS", "EPS (diluted)"),
    ("DilutedAverageShares", "Diluted shares"),
]
BALANCE: list[tuple[str, str]] = [
    ("TotalAssets", "Total assets"),
    ("CurrentAssets", "Current assets"),
    ("CashAndCashEquivalents", "Cash & equivalents"),
    ("Inventory", "Inventory"),
    ("TotalLiabilitiesNetMinorityInterest", "Total liabilities"),
    ("CurrentLiabilities", "Current liabilities"),
    ("TotalDebt", "Total debt"),
    ("LongTermDebt", "Long-term debt"),
    ("StockholdersEquity", "Shareholders' equity"),
    ("WorkingCapital", "Working capital"),
]
CASHFLOW: list[tuple[str, str]] = [
    ("OperatingCashFlow", "Operating cash flow"),
    ("CapitalExpenditure", "Capital expenditure"),
    ("FreeCashFlow", "Free cash flow"),
    ("InvestingCashFlow", "Investing cash flow"),
    ("FinancingCashFlow", "Financing cash flow"),
    ("RepurchaseOfCapitalStock", "Share buybacks"),
    ("CashDividendsPaid", "Dividends paid"),
    ("StockBasedCompensation", "Stock-based compensation"),
]
STATEMENTS = {"income": INCOME, "balance": BALANCE, "cashflow": CASHFLOW}

SCREEN_SORT_FIELDS = {
    "mcap": "intradaymarketcap",
    "chg": "percentchange",
    "volume": "dayvolume",
    "pe": "peratio.lasttwelvemonths",
}
SCREEN_REGIONS = {
    "us",
    "dk",
    "se",
    "no",
    "fi",
    "de",
    "gb",
    "fr",
    "nl",
    "ch",
    "it",
    "es",
    "be",
    "at",
    "ie",
    "pl",
    "jp",
    "hk",
    "cn",
    "kr",
    "tw",
    "au",
    "in",
    "sg",
    "ca",
    "br",
    "mx",
}
SCREEN_SECTORS = {
    "Basic Materials",
    "Industrials",
    "Communication Services",
    "Healthcare",
    "Real Estate",
    "Technology",
    "Energy",
    "Utilities",
    "Financial Services",
    "Consumer Defensive",
    "Consumer Cyclical",
}


def _raw(v: Any) -> Any:
    if isinstance(v, dict):
        return v.get("raw")
    return v


def _num(v: Any) -> float | None:
    v = _raw(v)
    try:
        return float(v) if v is not None else None
    except (TypeError, ValueError):
        return None


# ------------------------------------------------------------------ fundamentals


def fundamentals_types(period: str) -> str:
    keys = [k for lines in STATEMENTS.values() for k, _ in lines]
    return ",".join(f"{period}{k}" for k in keys)


def parse_fundamentals(
    payload: dict[str, Any], period: str
) -> tuple[list[str], str | None, list[Statement]]:
    results = ((payload.get("timeseries") or {}).get("result")) or []
    series: dict[str, dict[str, float | None]] = {}
    currency: str | None = None
    dates: set[str] = set()
    for res in results:
        mtype = ((res.get("meta") or {}).get("type") or [""])[0]
        if not mtype.startswith(period):
            continue
        key = mtype[len(period) :]
        for pt in res.get(mtype) or []:
            if not pt:
                continue
            d = pt.get("asOfDate")
            if not d:
                continue
            dates.add(d)
            currency = currency or pt.get("currencyCode")
            series.setdefault(key, {})[d] = _num(pt.get("reportedValue"))
    if not dates:
        raise NotFound("no fundamentals")
    periods = sorted(dates)
    return periods, currency, assemble_statements(series, periods, period)


def assemble_statements(
    series: dict[str, dict[str, float | None]], periods: list[str], period: str
) -> list[Statement]:
    """Line series keyed by period-end date -> ordered statements + computed ratios.
    Shared by every fundamentals source so the FA panel looks the same for all of them."""
    statements: list[Statement] = []
    for name, lines in STATEMENTS.items():
        out_lines = [
            StatementLine(key=k, label=label, values=[series.get(k, {}).get(d) for d in periods])
            for k, label in lines
            if any(series.get(k, {}).get(d) is not None for d in periods)
        ]
        statements.append(Statement(name=name, lines=out_lines))
    statements.append(Statement(name="ratios", lines=compute_ratios(series, periods, period)))
    return statements


def _div(a: float | None, b: float | None) -> float | None:
    if a is None or b is None or b == 0:
        return None
    return a / b


def compute_ratios(
    series: dict[str, dict[str, float | None]], periods: list[str], period: str
) -> list[StatementLine]:
    def v(key: str, d: str) -> float | None:
        return series.get(key, {}).get(d)

    def pct(x: float | None) -> float | None:
        return x * 100 if x is not None else None

    def growth(i: int, d: str) -> float | None:
        """YoY growth vs the period ~1 year earlier (skips gaps in quarterly data)."""
        target = date.fromisoformat(d).toordinal() - 365
        prev = next(
            (p for p in periods[:i] if abs(date.fromisoformat(p).toordinal() - target) <= 40),
            None,
        )
        if prev is None:
            return None
        r = _div(v("TotalRevenue", d), v("TotalRevenue", prev))
        return pct(r - 1) if r is not None else None

    lines: dict[str, tuple[str, Callable[[int, str], float | None]]] = {
        "gross_margin": (
            "Gross margin %",
            lambda i, d: pct(_div(v("GrossProfit", d), v("TotalRevenue", d))),
        ),
        "operating_margin": (
            "Operating margin %",
            lambda i, d: pct(_div(v("OperatingIncome", d), v("TotalRevenue", d))),
        ),
        "net_margin": (
            "Net margin %",
            lambda i, d: pct(_div(v("NetIncome", d), v("TotalRevenue", d))),
        ),
        "fcf_margin": (
            "FCF margin %",
            lambda i, d: pct(_div(v("FreeCashFlow", d), v("TotalRevenue", d))),
        ),
        "roe": (
            "Return on equity %" + (" (quarter)" if period == "quarterly" else ""),
            lambda i, d: pct(_div(v("NetIncome", d), v("StockholdersEquity", d))),
        ),
        "debt_to_equity": (
            "Debt / equity",
            lambda i, d: _div(v("TotalDebt", d), v("StockholdersEquity", d)),
        ),
        "current_ratio": (
            "Current ratio",
            lambda i, d: _div(v("CurrentAssets", d), v("CurrentLiabilities", d)),
        ),
        "revenue_growth": ("Revenue growth % YoY", lambda i, d: growth(i, d)),
    }
    out: list[StatementLine] = []
    for key, (label, fn) in lines.items():
        values = [fn(i, d) for i, d in enumerate(periods)]
        if any(x is not None for x in values):
            out.append(StatementLine(key=key, label=label, values=values))
    return out


# ------------------------------------------------------------------ filings & insiders


def parse_filings(payload: dict[str, Any]) -> list[Filing]:
    res = ((payload.get("quoteSummary") or {}).get("result") or [{}])[0] or {}
    out: list[Filing] = []
    for f in (res.get("secFilings") or {}).get("filings") or []:
        form = f.get("type") or "?"
        exhibits = f.get("exhibits") or []
        main = next((e for e in exhibits if e.get("type") == form), None)
        url = (main or {}).get("url") or f.get("edgarUrl")
        if not url:
            continue
        out.append(Filing(date=str(f.get("date") or ""), form=form, title=f.get("title"), url=url))
    return out


def parse_insiders(payload: dict[str, Any]) -> list[InsiderTxn]:
    res = ((payload.get("quoteSummary") or {}).get("result") or [{}])[0] or {}
    out: list[InsiderTxn] = []
    for t in (res.get("insiderTransactions") or {}).get("transactions") or []:
        start = t.get("startDate") or {}
        d = start.get("fmt") if isinstance(start, dict) else None
        if not d and _num(start):
            d = datetime.fromtimestamp(_num(start) or 0, UTC).date().isoformat()
        out.append(
            InsiderTxn(
                date=d or "",
                insider=str(t.get("filerName") or "?").title(),
                relation=t.get("filerRelation") or None,
                text=t.get("transactionText") or None,
                shares=_num(t.get("shares")),
                value=_num(t.get("value")),
                ownership=t.get("ownership") or None,
            )
        )
    return out


# ------------------------------------------------------------------ calendar & screener


def econ_body(start: date, end: date, size: int = 100) -> dict[str, Any]:
    return {
        "sortType": "ASC",
        "entityIdType": "economic_event",
        "sortField": "startdatetime",
        "includeFields": [
            "econ_release",
            "country_code",
            "startdatetime",
            "period",
            "after_release_actual",
            "consensus_estimate",
            "prior_release_actual",
            "originally_reported_actual",
        ],
        "size": min(100, size),
        "offset": 0,
        "query": {
            "operator": "and",
            "operands": [
                {"operator": "gte", "operands": ["startdatetime", start.isoformat()]},
                {"operator": "lte", "operands": ["startdatetime", end.isoformat()]},
            ],
        },
    }


def parse_econ(payload: dict[str, Any]) -> list[EconEvent]:
    fin = payload.get("finance") or {}
    if fin.get("error"):
        raise ProviderError(f"Yahoo calendar error: {fin['error']}")
    res = (fin.get("result") or [{}])[0] or {}
    doc = (res.get("documents") or [{}])[0] or {}
    cols = [c.get("id") for c in doc.get("columns") or []]
    out: list[EconEvent] = []
    for row in doc.get("rows") or []:
        r = dict(zip(cols, row, strict=False))
        ts = r.get("startdatetime")
        if not ts or not r.get("econ_release"):
            continue

        def s(x: Any) -> str | None:
            return None if x in (None, "") else str(x)

        out.append(
            EconEvent(
                event=str(r["econ_release"]).rstrip("*").strip(),
                country=s(r.get("country_code")),
                time=datetime.fromisoformat(str(ts).replace("Z", "+00:00")),
                period=s(r.get("period")),
                actual=s(r.get("after_release_actual")),
                # No source publishes consensus for free under clean terms (PROVIDERS §2):
                # survey is N.A., never a Yahoo number presented as "expected".
                expected=None,
                prior=s(r.get("prior_release_actual")),
                revised=s(r.get("originally_reported_actual")),
            )
        )
    return out


def screen_body(
    region: str,
    sector: str | None,
    mcap_min: float | None,
    mcap_max: float | None,
    pe_max: float | None,
    chg_min: float | None,
    chg_max: float | None,
    vol_min: float | None,
    sort: str,
    desc: bool,
    size: int,
) -> dict[str, Any]:
    if region not in SCREEN_REGIONS:
        raise NotSupported(f"unsupported region {region}")
    ops: list[dict[str, Any]] = [{"operator": "eq", "operands": ["region", region]}]
    if sector:
        if sector not in SCREEN_SECTORS:
            raise NotSupported(f"unknown sector {sector}")
        ops.append({"operator": "eq", "operands": ["sector", sector]})
    rng = [
        ("gt", "intradaymarketcap", mcap_min),
        ("lt", "intradaymarketcap", mcap_max),
        ("lt", "peratio.lasttwelvemonths", pe_max),
        ("gt", "percentchange", chg_min),
        ("lt", "percentchange", chg_max),
        ("gt", "dayvolume", vol_min),
    ]
    for op, field, val in rng:
        if val is not None:
            ops.append({"operator": op, "operands": [field, val]})
    if pe_max is not None:
        ops.append({"operator": "gt", "operands": ["peratio.lasttwelvemonths", 0]})
    return {
        "size": min(100, size),
        "offset": 0,
        "sortField": SCREEN_SORT_FIELDS.get(sort, "intradaymarketcap"),
        "sortType": "DESC" if desc else "ASC",
        "quoteType": "EQUITY",
        "userId": "",
        "userIdType": "guid",
        "query": {"operator": "and", "operands": ops},
    }


def parse_screen(payload: dict[str, Any]) -> tuple[int, list[ScreenRow]]:
    fin = payload.get("finance") or {}
    if fin.get("error"):
        raise ProviderError(f"Yahoo screener error: {fin['error']}")
    res = (fin.get("result") or [{}])[0] or {}
    rows = [
        ScreenRow(
            symbol=q["symbol"],
            name=q.get("longName") or q.get("shortName"),
            exchange=q.get("fullExchangeName") or q.get("exchange"),
            currency=q.get("currency"),
            price=_num(q.get("regularMarketPrice")),
            change_pct=_num(q.get("regularMarketChangePercent")),
            market_cap=_num(q.get("marketCap")),
            pe=_num(q.get("trailingPE")),
            volume=_num(q.get("regularMarketVolume")),
            avg_volume=_num(q.get("averageDailyVolume3Month")),
            dividend_yield=_num(q.get("dividendYield")),
        )
        for q in res.get("quotes") or []
        if q.get("symbol")
    ]
    return int(res.get("total") or len(rows)), rows


class YahooResearchMixin:
    """Requires `_get(url, params)` and `_post(url, params, body)` from YahooProvider."""

    _get: Callable[[str, dict[str, Any]], Awaitable[Any]]
    _post: Callable[[str, dict[str, Any], dict[str, Any]], Awaitable[Any]]

    async def fundamentals(self, inst: Instrument, period: str) -> Any:
        from ..symbols import to_yahoo

        ys = to_yahoo(inst)
        payload = await self._get(
            f"{Q2}/ws/fundamentals-timeseries/v1/finance/timeseries/{ys}",
            {
                "symbol": ys,
                "type": fundamentals_types(period),
                "period1": 493590046,
                "period2": int(time.time()),
            },
        )
        return parse_fundamentals(payload, period)

    async def filings(self, inst: Instrument) -> list[Filing]:
        from ..symbols import to_yahoo

        payload = await self._get(
            f"{Q2}/v10/finance/quoteSummary/{to_yahoo(inst)}",
            {"modules": "secFilings", "formatted": "false"},
        )
        rows = parse_filings(payload)
        if not rows:
            raise NotFound(f"no SEC filings listed for {inst.symbol}")
        return rows

    async def insiders(self, inst: Instrument) -> list[InsiderTxn]:
        from ..symbols import to_yahoo

        payload = await self._get(
            f"{Q2}/v10/finance/quoteSummary/{to_yahoo(inst)}",
            {"modules": "insiderTransactions", "formatted": "false"},
        )
        rows = parse_insiders(payload)
        if not rows:
            raise NotFound(f"no insider transactions for {inst.symbol}")
        return rows

    async def econ_calendar(self, start: date, end: date) -> list[EconEvent]:
        """Yahoo caps pages at 100 events; a week has a few hundred worldwide."""
        out: list[EconEvent] = []
        for page in range(6):
            body = econ_body(start, end)
            body["offset"] = page * 100
            rows = parse_econ(
                await self._post(
                    f"{Q1}/v1/finance/visualization", {"lang": "en-US", "region": "US"}, body
                )
            )
            out.extend(rows)
            if len(rows) < 100:
                break
        return out

    async def screen(self, body: dict[str, Any]) -> tuple[int, list[ScreenRow]]:
        payload = await self._post(
            f"{Q1}/v1/finance/screener",
            {
                "lang": "en-US",
                "region": "US",
                "formatted": "false",
                "corsDomain": "finance.yahoo.com",
            },
            body,
        )
        return parse_screen(payload)


def dumps(body: dict[str, Any]) -> str:
    return json.dumps(body, separators=(",", ":"))
