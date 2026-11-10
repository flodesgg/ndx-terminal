"""Financial statements from SEC XBRL "companyfacts" (10-K/10-Q US GAAP, 20-F IFRS).

Rules, validated line by line against Yahoo Finance on 16 filers (AAPL Sep/52-53 wk FY, MSFT Jun
FY, NVDA Jan FY, JPM/BAC banks, BRK-B insurer, XOM, CVX, KO, AMZN, GOOGL, WMT, NKE, LLY, NVO and
TSM on IFRS):

  * only statement filings count: 10-K, 10-Q, 20-F, 40-F, 6-K (and amendments). 8-K recasts,
    DEF 14A pay-vs-performance facts (rounded net income!) and 424B fee tables are ignored;
  * period classes by duration: annual 330-400 days (52/53-week years ok), quarter 75-105 days;
    fiscal-year ends are the ends of 12-month facts in annual reports, which drops the
    trailing-twelve-month columns some 10-Qs carry (Amazon);
  * several facts per period (comparatives, restatements): the latest filed wins;
  * 10-Qs report cash flows year-to-date and nobody files a 3-month fiscal Q4, so missing
    quarters are derived from the year-to-date chain (Q2 = 6M - Q1, ..., Q4 = FY - 9M);
    weighted-average share counts are derived time-weighted; per-share values never by
    subtraction (Q4 EPS = Q4 net income / Q4 diluted shares);
  * stock splits: a period re-filed with an integer-factor change in a per-share or share
    count value marks a split; values only ever filed before it are adjusted;
  * per period, the first concept in priority order with a value wins (companies switch
    concepts over time); derived lines use only values present for that same period.
"""

from __future__ import annotations

import itertools
from collections import Counter, defaultdict
from collections.abc import Callable
from dataclasses import dataclass, replace
from datetime import date
from typing import Any, Literal

from ..models import Statement
from .base import NotFound
from .yahoo_research import assemble_statements

Kind = Literal["duration", "instant"]
Unit = Literal["money", "per_share", "shares"]

ANNUAL_DAYS = (330, 400)
QUARTER_DAYS = (75, 105)
DATE_TOLERANCE = 3  # days, when matching period ends across concepts
STATEMENT_FORMS = ("10-K", "10-Q", "20-F", "40-F", "6-K")
ANNUAL_FORMS = ("10-K", "20-F", "40-F", "6-K")  # some foreign issuers file annuals as 6-K


@dataclass(frozen=True)
class Spec:
    key: str
    kind: Kind
    us_gaap: tuple[str, ...]
    ifrs: tuple[str, ...] = ()
    sign: int = 1  # -1: XBRL reports the outflow as positive; the FA panel shows it negative
    unit: Unit = "money"


# Keys starting with "_" are helpers for derivations and are not displayed.
SPECS: tuple[Spec, ...] = (
    # ---- income statement ----
    Spec(
        "TotalRevenue",
        "duration",
        (
            "RevenuesNetOfInterestExpense",
            "Revenues",
            "RevenueFromContractWithCustomerExcludingAssessedTax",
            "RevenueFromContractWithCustomerIncludingAssessedTax",
            "SalesRevenueNet",
            "SalesRevenueGoodsNet",
        ),
        ("Revenue", "RevenueFromContractsWithCustomers"),
    ),
    Spec(
        "CostOfRevenue",
        "duration",
        (
            "CostOfRevenue",
            "CostOfGoodsAndServicesSold",
            "CostOfGoodsSold",
            "CostOfGoodsAndServiceExcludingDepreciationDepletionAndAmortization",
        ),
        ("CostOfSales",),
    ),
    Spec("GrossProfit", "duration", ("GrossProfit",), ("GrossProfit",)),
    Spec(
        "ResearchAndDevelopment",
        "duration",
        (
            "ResearchAndDevelopmentExpense",
            "ResearchAndDevelopmentExpenseExcludingAcquiredInProcessCost",
        ),
        ("ResearchAndDevelopmentExpense",),
    ),
    Spec(
        "SellingGeneralAndAdministration",
        "duration",
        ("SellingGeneralAndAdministrativeExpense",),
        ("SellingGeneralAndAdministrativeExpense",),
    ),
    Spec(
        "_SalesMarketing",
        "duration",
        ("SellingAndMarketingExpense", "MarketingExpense"),
        ("SalesAndMarketingExpense", "SellingExpense", "DistributionCosts"),
    ),
    Spec(
        "_GeneralAdmin",
        "duration",
        ("GeneralAndAdministrativeExpense",),
        ("GeneralAndAdministrativeExpense", "AdministrativeExpense"),
    ),
    Spec(
        "OperatingIncome",
        "duration",
        ("OperatingIncomeLoss",),
        ("ProfitLossFromOperatingActivities",),
    ),
    Spec(
        "PretaxIncome",
        "duration",
        (
            "IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest",
            "IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments",
        ),
        ("ProfitLossBeforeTax",),
    ),
    Spec(
        "TaxProvision",
        "duration",
        ("IncomeTaxExpenseBenefit",),
        ("IncomeTaxExpenseContinuingOperations",),
    ),
    Spec(
        "NetIncome",
        "duration",
        ("NetIncomeLoss", "ProfitLoss"),
        ("ProfitLossAttributableToOwnersOfParent", "ProfitLoss"),
    ),
    Spec(
        "DilutedEPS",
        "duration",
        ("EarningsPerShareDiluted", "EarningsPerShareBasicAndDiluted"),
        ("DilutedEarningsLossPerShare",),
        unit="per_share",
    ),
    Spec(
        "DilutedAverageShares",
        "duration",
        (
            "WeightedAverageNumberOfDilutedSharesOutstanding",
            "WeightedAverageNumberOfShareOutstandingBasicAndDiluted",
        ),
        ("AdjustedWeightedAverageShares",),
        unit="shares",
    ),
    Spec(
        "_InterestExpense",
        "duration",
        ("InterestExpenseNonoperating", "InterestExpense", "InterestExpenseDebt"),
        ("FinanceCosts", "InterestExpense"),
    ),
    Spec(
        "_DA",
        "duration",
        (
            "DepreciationDepletionAndAmortization",
            "DepreciationAmortizationAndAccretionNet",
            "DepreciationAndAmortization",
        ),
        (
            "DepreciationAndAmortisationExpense",
            "DepreciationAmortisationAndImpairmentLossReversalOfImpairmentLossRecognisedInProfitOrLoss",
        ),
    ),
    Spec("_Depreciation", "duration", (), ("DepreciationExpense",)),
    Spec("_Amortisation", "duration", (), ("AmortisationExpense",)),
    # ---- balance sheet ----
    Spec("TotalAssets", "instant", ("Assets",), ("Assets",)),
    Spec("CurrentAssets", "instant", ("AssetsCurrent",), ("CurrentAssets",)),
    Spec(
        "CashAndCashEquivalents",
        "instant",
        (
            "CashAndCashEquivalentsAtCarryingValue",
            "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents",
        ),
        ("CashAndCashEquivalents",),
    ),
    Spec("Inventory", "instant", ("InventoryNet",), ("Inventories",)),
    Spec("TotalLiabilitiesNetMinorityInterest", "instant", ("Liabilities",), ("Liabilities",)),
    Spec("CurrentLiabilities", "instant", ("LiabilitiesCurrent",), ("CurrentLiabilities",)),
    Spec(
        "LongTermDebt",
        "instant",
        (
            "LongTermDebtNoncurrent",
            "LongTermDebtAndCapitalLeaseObligations",
            "LongTermDebtAndCapitalLeaseObligationsIncludingCurrentMaturities",
        ),
        ("NoncurrentPortionOfNoncurrentBorrowings", "LongtermBorrowings"),
    ),
    Spec("_LongTermDebtTotal", "instant", ("LongTermDebt",), ()),
    Spec("_DebtCurrent", "instant", ("DebtCurrent",), ()),
    Spec(
        "_LongTermDebtCurrent",
        "instant",
        ("LongTermDebtCurrent", "LongTermDebtAndCapitalLeaseObligationsCurrent"),
        ("CurrentPortionOfNoncurrentBorrowings", "CurrentPortionOfLongtermBorrowings"),
    ),
    Spec(
        "_ShortTermDebt",
        "instant",
        (
            "NotesAndLoansPayable",
            "ShortTermBorrowings",
            "CommercialPaper",
            "OtherShortTermBorrowings",
        ),
        ("ShorttermBorrowings",),
    ),
    Spec(
        "StockholdersEquity",
        "instant",
        ("StockholdersEquity",),
        ("EquityAttributableToOwnersOfParent", "Equity"),
    ),
    Spec(
        "_LiabilitiesAndEquity",
        "instant",
        ("LiabilitiesAndStockholdersEquity",),
        ("EquityAndLiabilities",),
    ),
    Spec(
        "_EquityInclNCI",
        "instant",
        ("StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest",),
        ("Equity",),
    ),
    # ---- cash flow ----
    Spec(
        "OperatingCashFlow",
        "duration",
        (
            "NetCashProvidedByUsedInOperatingActivities",
            "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations",
        ),
        ("CashFlowsFromUsedInOperatingActivities",),
    ),
    Spec(
        "CapitalExpenditure",
        "duration",
        ("PaymentsToAcquirePropertyPlantAndEquipment", "PaymentsToAcquireProductiveAssets"),
        ("PurchaseOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities",),
        sign=-1,
    ),
    Spec(
        "_IntangiblePurchases",
        "duration",
        (),
        ("PurchaseOfIntangibleAssetsClassifiedAsInvestingActivities",),
        sign=-1,
    ),
    Spec(
        "InvestingCashFlow",
        "duration",
        (
            "NetCashProvidedByUsedInInvestingActivities",
            "NetCashProvidedByUsedInInvestingActivitiesContinuingOperations",
        ),
        ("CashFlowsFromUsedInInvestingActivities",),
    ),
    Spec(
        "FinancingCashFlow",
        "duration",
        (
            "NetCashProvidedByUsedInFinancingActivities",
            "NetCashProvidedByUsedInFinancingActivitiesContinuingOperations",
        ),
        ("CashFlowsFromUsedInFinancingActivities",),
    ),
    Spec(
        "RepurchaseOfCapitalStock",
        "duration",
        ("PaymentsForRepurchaseOfCommonStock", "PaymentsForRepurchaseOfEquity"),
        ("PaymentsToAcquireOrRedeemEntitysShares", "PurchaseOfTreasuryShares"),
        sign=-1,
    ),
    Spec(
        "CashDividendsPaid",
        "duration",
        ("PaymentsOfDividends", "PaymentsOfDividendsCommonStock"),
        ("DividendsPaidClassifiedAsFinancingActivities", "DividendsPaid"),
        sign=-1,
    ),
    Spec(
        "StockBasedCompensation",
        "duration",
        ("ShareBasedCompensation", "AllocatedShareBasedCompensationExpense"),
        ("AdjustmentsForSharebasedPayments",),
    ),
)

# IFRS filers' capital expenditure includes intangible-asset purchases (as Yahoo reports it).
IFRS_ADD: dict[str, tuple[str, ...]] = {"CapitalExpenditure": ("_IntangiblePurchases",)}

Getter = Callable[[str], float | None]


def _sum(*xs: float | None) -> float | None:
    if any(x is None for x in xs):
        return None
    return float(sum(x for x in xs if x is not None))


def _diff(a: float | None, b: float | None) -> float | None:
    return None if a is None or b is None else a - b


def _ebitda(v: Getter) -> float | None:
    """Pretax income + interest expense + D&A (Yahoo's definition); operating income + D&A when
    no interest line is tagged. Only for companies that report an operating income line, so
    banks (whose interest expense is a cost of revenue) get no EBITDA."""
    if v("OperatingIncome") is None:
        return None
    da = v("_DA")
    if da is None:
        da = _sum(v("_Depreciation"), v("_Amortisation"))
    if da is None:
        return None
    if v("_InterestExpense") is not None and v("PretaxIncome") is not None:
        return _sum(v("PretaxIncome"), v("_InterestExpense"), da)
    return _sum(v("OperatingIncome"), da)


def _total_debt(v: Getter) -> float | None:
    """Financial debt excluding lease liabilities: current debt + long-term debt."""
    lt = v("LongTermDebt")
    if lt is None:
        return None
    current = v("_DebtCurrent")
    if current is None:
        parts = [x for x in (v("_ShortTermDebt"), v("_LongTermDebtCurrent")) if x is not None]
        if not parts:
            return None  # current portion not reported: unknown, not zero
        current = sum(parts)
    return lt + current


def _eps(v: Getter) -> float | None:
    ni, sh = v("NetIncome"), v("DilutedAverageShares")
    return round(ni / sh, 2) if ni is not None and sh else None


# Derived lines: filled only where no reported value exists for that period.
DERIVED: dict[str, Callable[[Getter], float | None]] = {
    "SellingGeneralAndAdministration": lambda v: _sum(v("_SalesMarketing"), v("_GeneralAdmin")),
    "GrossProfit": lambda v: _diff(v("TotalRevenue"), v("CostOfRevenue")),
    "EBITDA": _ebitda,
    "DilutedEPS": _eps,
    "TotalLiabilitiesNetMinorityInterest": lambda v: _diff(
        v("_LiabilitiesAndEquity"),
        v("_EquityInclNCI") if v("_EquityInclNCI") is not None else v("StockholdersEquity"),
    ),
    "LongTermDebt": lambda v: _diff(v("_LongTermDebtTotal"), v("_LongTermDebtCurrent")),
    "TotalDebt": _total_debt,
    "WorkingCapital": lambda v: _diff(v("CurrentAssets"), v("CurrentLiabilities")),
    "FreeCashFlow": lambda v: _sum(v("OperatingCashFlow"), v("CapitalExpenditure")),
}

# Period ends are discovered from these duration lines (instants exist at every quarter end).
CORE_KEYS = ("TotalRevenue", "NetIncome", "OperatingCashFlow")
MIN_PERIODS = 2


@dataclass(frozen=True)
class Fact:
    start: date | None
    end: date
    val: float
    filed: str
    frame: str | None
    form: str

    @property
    def annual_report(self) -> bool:
        return self.form.startswith(ANNUAL_FORMS)


def _d(s: str) -> date:
    return date.fromisoformat(s)


def _facts(units: dict[str, list[dict[str, Any]]], unit: str) -> list[Fact]:
    out: list[Fact] = []
    for f in units.get(unit, []):
        form = str(f.get("form") or "")
        if not form.startswith(STATEMENT_FORMS):
            continue
        try:
            out.append(
                Fact(
                    start=_d(f["start"]) if f.get("start") else None,
                    end=_d(f["end"]),
                    val=float(f["val"]),
                    filed=str(f.get("filed") or ""),
                    frame=f.get("frame"),
                    form=form,
                )
            )
        except (KeyError, TypeError, ValueError):
            continue
    return out


def split_events(facts: list[Fact]) -> list[tuple[str, float]]:
    """(first filing date showing adjusted values, value ratio new/old) per stock split, found
    from periods re-filed with an integer-factor change (shares x k, per-share / k)."""
    by_span: dict[tuple[date | None, date], list[Fact]] = defaultdict(list)
    for f in facts:
        by_span[(f.start, f.end)].append(f)
    raw: list[tuple[str, float]] = []
    for versions in by_span.values():
        versions.sort(key=lambda f: f.filed)
        for a, b in itertools.pairwise(versions):
            if not a.val or not b.val or a.filed == b.filed:
                continue
            r = b.val / a.val
            k = r if r >= 1 else 1 / r
            if k >= 1.5 and abs(k - round(k)) <= 0.03 * k:
                raw.append((b.filed, float(round(k)) if r >= 1 else 1 / round(k)))
    events: list[tuple[str, float]] = []
    for filed, ratio in sorted(raw):
        dup = next(
            (e for e in events if e[1] == ratio and abs((_d(filed) - _d(e[0])).days) <= 400),
            None,
        )
        if dup is None:
            events.append((filed, ratio))
    return events


def _split_adjust(facts: list[Fact]) -> list[Fact]:
    events = split_events(facts)
    if not events:
        return facts
    out = []
    for f in facts:
        factor = 1.0
        for filed, ratio in events:
            if f.filed < filed:
                factor *= ratio
        out.append(f if factor == 1.0 else replace(f, val=f.val * factor))
    return out


def _better(f: Fact, cur: Fact | None) -> bool:
    return cur is None or (f.filed, f.frame is not None) > (cur.filed, cur.frame is not None)


def _latest(facts: list[Fact]) -> dict[date, Fact]:
    """Latest-filed fact per period end (restatements and comparatives collapse)."""
    best: dict[date, Fact] = {}
    for f in facts:
        if _better(f, best.get(f.end)):
            best[f.end] = f
    return best


def _latest_by_span(facts: list[Fact]) -> dict[tuple[date, date], Fact]:
    best: dict[tuple[date, date], Fact] = {}
    for f in facts:
        if f.start is not None and _better(f, best.get((f.start, f.end))):
            best[(f.start, f.end)] = f
    return best


def _duration_class(f: Fact) -> str | None:
    if f.start is None:
        return None
    days = (f.end - f.start).days
    if ANNUAL_DAYS[0] <= days <= ANNUAL_DAYS[1]:
        return "annual"
    if QUARTER_DAYS[0] <= days <= QUARTER_DAYS[1]:
        return "quarter"
    return None


def _near(d: date, ends: list[date]) -> date | None:
    best = min(ends, key=lambda e: abs((e - d).days), default=None)
    return best if best is not None and abs((best - d).days) <= DATE_TOLERANCE else None


ANCHORS = (
    "Assets",
    "Revenues",
    "Revenue",
    "NetIncomeLoss",
    "ProfitLoss",
    "RevenueFromContractWithCustomerExcludingAssessedTax",
    "StockholdersEquity",
    "Equity",
)


def pick_taxonomy(payload: dict[str, Any]) -> str:
    facts = payload.get("facts") or {}

    def latest_end(tax: str) -> str:
        concepts = facts.get(tax) or {}
        return max(
            (
                f.get("end", "")
                for c in ANCHORS
                if c in concepts
                for u in concepts[c].get("units", {}).values()
                for f in u
            ),
            default="",
        )

    candidates = [t for t in ("us-gaap", "ifrs-full") if t in facts]
    if not candidates:
        raise NotFound("no us-gaap or ifrs-full facts")
    return max(candidates, key=latest_end)


def pick_currency(concepts: dict[str, Any]) -> str:
    """Reporting currency = the money unit with the most anchor facts (20-F filers also tag a
    one-year USD convenience translation, which must not win)."""
    counts: Counter[str] = Counter()
    for c in ANCHORS:
        for unit, facts in (concepts.get(c, {}).get("units") or {}).items():
            if len(unit) == 3 and unit.isalpha():
                counts[unit] += len(facts)
    if not counts:
        raise NotFound("cannot determine reporting currency")
    return counts.most_common(1)[0][0]


def _unit(spec: Spec, ccy: str) -> str:
    return {"money": ccy, "per_share": f"{ccy}/shares", "shares": "shares"}[spec.unit]


def concept_series(
    units: dict[str, list[dict[str, Any]]], spec: Spec, ccy: str, period: str
) -> dict[date, float]:
    """Values of one concept per period end (see the module docstring for the rules)."""
    facts = _facts(units, _unit(spec, ccy))
    if spec.unit != "money":
        facts = _split_adjust(facts)
    if spec.kind == "instant":
        return {e: f.val for e, f in _latest([f for f in facts if f.start is None]).items()}
    annual_facts = [f for f in facts if _duration_class(f) == "annual"]
    fy_ends = sorted({f.end for f in annual_facts if f.annual_report})
    if period == "annual":
        return {e: f.val for e, f in _latest(annual_facts).items() if _near(e, fy_ends) is not None}
    out = {
        e: f.val for e, f in _latest([f for f in facts if _duration_class(f) == "quarter"]).items()
    }
    if spec.unit == "per_share":
        return out  # never derived by subtraction
    chains: dict[date, dict[date, float]] = {}
    for (start, end), f in _latest_by_span(facts).items():
        if QUARTER_DAYS[0] <= (end - start).days <= ANNUAL_DAYS[1]:
            chains.setdefault(start, {})[end] = f.val
    for start, chain in chains.items():
        prev: date | None = None
        for e in sorted(chain):
            span = (e - (prev or start)).days
            if QUARTER_DAYS[0] <= span <= QUARTER_DAYS[1] and _near(e, list(out)) is None:
                if prev is None:
                    out[e] = chain[e]
                elif spec.unit == "shares":  # weighted averages: time-weighted difference
                    d_e, d_p = (e - start).days, (prev - start).days
                    out[e] = (chain[e] * d_e - chain[prev] * d_p) / (d_e - d_p)
                else:
                    out[e] = chain[e] - chain[prev]
            prev = e
    return out


def build_statements(
    payload: dict[str, Any], period: str, max_periods: int = 8
) -> tuple[list[str], str, list[Statement]]:
    taxonomy = pick_taxonomy(payload)
    concepts: dict[str, Any] = payload["facts"][taxonomy]
    ccy = pick_currency(concepts)

    # 1) Per line: merge concept series by priority, period by period.
    raw: dict[str, dict[date, float]] = {}
    for spec in SPECS:
        names = spec.us_gaap if taxonomy == "us-gaap" else spec.ifrs
        merged: dict[date, float] = {}
        for name in names:
            units = (concepts.get(name) or {}).get("units") or {}
            for end, val in concept_series(units, spec, ccy, period).items():
                if _near(end, list(merged)) is None:
                    merged[end] = val * spec.sign
        if merged:
            raw[spec.key] = merged
    if taxonomy == "ifrs-full":
        for key, extras in IFRS_ADD.items():
            for extra in extras:
                for end, val in raw.get(extra, {}).items():
                    hit = _near(end, list(raw.get(key, {})))
                    if hit is not None:
                        raw[key][hit] += val

    # 2) Period ends: where any core line has data; newest `max_periods`.
    ends: list[date] = []
    for key in CORE_KEYS:
        for e in raw.get(key, {}):
            if _near(e, ends) is None:
                ends.append(e)
    ends = sorted(ends)[-max_periods:]
    if len(ends) < MIN_PERIODS:
        raise NotFound(f"insufficient SEC XBRL {period} history ({len(ends)} periods)")

    # 3) Align every line to those ends (tolerating a few days' difference), then derive.
    series: dict[str, dict[str, float | None]] = {}
    for key, vals in raw.items():
        aligned: dict[str, float | None] = {}
        for e in ends:
            m = _near(e, list(vals))
            aligned[e.isoformat()] = vals[m] if m is not None else None
        series[key] = aligned
    for key, fn in DERIVED.items():
        line = series.setdefault(key, {})
        for e in ends:
            d = e.isoformat()
            if line.get(d) is None:
                line[d] = fn(lambda k, d=d: series.get(k, {}).get(d))  # type: ignore[misc]
    for key in [k for k in series if k.startswith("_")]:
        del series[key]

    periods = [e.isoformat() for e in ends]
    return periods, ccy, assemble_statements(series, periods, period)
