"""SEC XBRL statement engine: synthetic edge cases + recorded real filers vs Yahoo reference."""

from __future__ import annotations

from typing import Any

import pytest

from ndx_server.providers.base import NotFound
from ndx_server.providers.sec_financials import (
    SPECS,
    _facts,
    build_statements,
    concept_series,
    pick_currency,
    split_events,
)


def f(start: str | None, end: str, val: float, filed: str, form: str = "10-K") -> dict[str, Any]:
    out: dict[str, Any] = {"end": end, "val": val, "filed": filed, "form": form}
    if start:
        out["start"] = start
    return out


def spec(key: str) -> Any:
    return next(s for s in SPECS if s.key == key)


def payload(concepts: dict[str, dict[str, list[dict[str, Any]]]]) -> dict[str, Any]:
    return {"facts": {"us-gaap": {c: {"units": u} for c, u in concepts.items()}}}


# A calendar fiscal year with 10-Q year-to-date cash flows and no 3-month Q4 (the usual case).
OCF = [
    f("2025-01-01", "2025-03-31", 10, "2025-05-01", "10-Q"),
    f("2025-01-01", "2025-06-30", 25, "2025-08-01", "10-Q"),
    f("2025-01-01", "2025-09-30", 45, "2025-11-01", "10-Q"),
    f("2025-01-01", "2025-12-31", 70, "2026-02-15", "10-K"),
]


def test_quarters_from_year_to_date_chain() -> None:
    out = concept_series({"USD": OCF}, spec("OperatingCashFlow"), "USD", "quarterly")
    assert [out[k] for k in sorted(out)] == [10, 15, 20, 25]  # Q4 = FY - 9M


def test_weighted_shares_are_time_weighted() -> None:
    shares = [
        f("2025-01-01", "2025-04-01", 100.0, "2025-05-01", "10-Q"),  # 90 days
        f("2025-01-01", "2025-09-30", 104.0, "2025-11-01", "10-Q"),  # 272 days
        f("2025-01-01", "2025-12-31", 110.0, "2026-02-15"),  # 364 days
    ]
    out = concept_series({"shares": shares}, spec("DilutedAverageShares"), "USD", "quarterly")
    q4 = out[max(out)]
    assert q4 == pytest.approx((110 * 364 - 104 * 272) / (364 - 272))
    # Per-share values are never derived by subtraction.
    eps = [
        f("2025-01-01", "2025-12-31", 2.0, "2026-02-15"),
        f("2025-01-01", "2025-09-30", 1.5, "2025-11-01", "10-Q"),
    ]
    assert concept_series({"USD/shares": eps}, spec("DilutedEPS"), "USD", "quarterly") == {}


def test_split_detected_and_old_values_adjusted() -> None:
    eps = [
        f("2021-02-01", "2022-01-30", 3.85, "2022-03-18"),
        f("2021-02-01", "2022-01-30", 3.85, "2024-02-21"),  # last filed before the split
        f("2022-01-31", "2023-01-29", 1.74, "2023-02-24"),
        f("2022-01-31", "2023-01-29", 0.174, "2025-02-26"),  # 10:1 split re-presented
        f("2023-01-30", "2024-01-28", 0.30, "2025-02-26"),
    ]
    facts = _facts({"USD/shares": eps}, "USD/shares")
    assert split_events(facts) == [("2025-02-26", 0.1)]
    out = concept_series({"USD/shares": eps}, spec("DilutedEPS"), "USD", "annual")
    assert [round(out[k], 3) for k in sorted(out)] == [0.385, 0.174, 0.30]


def test_restatement_is_not_a_split() -> None:
    eps = [
        f("2024-01-01", "2024-12-31", 2.00, "2025-02-01"),
        f("2024-01-01", "2024-12-31", 1.80, "2026-02-01"),
    ]  # restated, not an integer factor
    assert split_events(_facts({"USD/shares": eps}, "USD/shares")) == []


def test_proxy_and_ttm_facts_are_ignored() -> None:
    ni = [
        f("2024-01-01", "2024-12-31", 57048, "2025-02-14"),
        f("2024-01-01", "2024-12-31", 57000, "2026-04-01", "DEF 14A"),  # rounded pay-vs-perf
        f("2025-01-01", "2025-12-31", 60000, "2026-02-14"),
        f("2024-10-01", "2025-09-30", 59000, "2025-11-01", "10-Q"),  # trailing twelve months
    ]
    out = concept_series({"USD": ni}, spec("NetIncome"), "USD", "annual")
    assert sorted(out.values()) == [57048, 60000]


def test_eps_q4_derived_from_net_income_and_shares() -> None:
    p = payload(
        {
            "NetIncomeLoss": {"USD": [*[{**x, "val": x["val"] * 10} for x in OCF]]},
            "WeightedAverageNumberOfDilutedSharesOutstanding": {
                "shares": [
                    f("2025-01-01", "2025-03-31", 100.0, "2025-05-01", "10-Q"),
                    f("2025-01-01", "2025-06-30", 100.0, "2025-08-01", "10-Q"),
                    f("2025-01-01", "2025-09-30", 100.0, "2025-11-01", "10-Q"),
                    f("2025-01-01", "2025-12-31", 100.0, "2026-02-15"),
                ]
            },
            "EarningsPerShareDiluted": {
                "USD/shares": [
                    f("2025-01-01", "2025-03-31", 1.0, "2025-05-01", "10-Q"),
                    f("2025-04-01", "2025-06-30", 1.5, "2025-08-01", "10-Q"),
                    f("2025-07-01", "2025-09-30", 2.0, "2025-11-01", "10-Q"),
                ]
            },
        }
    )
    periods, ccy, sts = build_statements(p, "quarterly")
    income = {ln.key: ln.values for st in sts if st.name == "income" for ln in st.lines}
    assert ccy == "USD" and len(periods) == 4
    assert income["NetIncome"] == [100, 150, 200, 250]
    assert income["DilutedEPS"] == [1.0, 1.5, 2.0, 2.5]  # Q4 = 250 / 100


def test_insufficient_history_falls_back() -> None:
    p = payload(
        {"NetIncomeLoss": {"USD": [f("2026-04-01", "2026-06-30", 5, "2026-08-01", "10-Q")]}}
    )
    with pytest.raises(NotFound):
        build_statements(p, "annual")


def test_currency_ignores_convenience_translation() -> None:
    concepts = {
        "Revenue": {
            "units": {
                "TWD": [
                    f("2023-01-01", "2023-12-31", 1, "2024-04-01", "20-F"),
                    f("2024-01-01", "2024-12-31", 2, "2025-04-01", "20-F"),
                ],
                "USD": [f("2024-01-01", "2024-12-31", 0.06, "2025-04-01", "20-F")],
            }
        },
    }
    assert pick_currency(concepts) == "TWD"


# ---------- recorded real filers vs Yahoo reference ----------

from datetime import date  # noqa: E402

from .helpers import fixture  # noqa: E402

# Lines whose definitions legitimately differ from Yahoo (documented in docs/FUNCTIONS.md#fa).
DEFINITIONAL = {"TotalDebt", "EBITDA"}


def _grades(ticker: str, period: str) -> dict[str, list[str]]:
    periods, _, sts = build_statements(fixture(f"sec_companyfacts_{ticker}.json"), period)
    sec = {
        ln.key: dict(zip(periods, ln.values, strict=True))
        for st in sts
        if st.name != "ratios"
        for ln in st.lines
    }
    ref = fixture(f"yahoo_statements_{ticker}.json")[period]
    out: dict[str, list[str]] = {"exact": [], "close": [], "mismatch": [], "missing": []}
    for key, yvals in ref["lines"].items():
        if key in DEFINITIONAL:
            continue
        for yd, yv in zip(ref["periods"], yvals, strict=True):
            sd = min(
                periods, key=lambda p: abs((date.fromisoformat(p) - date.fromisoformat(yd)).days)
            )
            if yv is None or abs((date.fromisoformat(sd) - date.fromisoformat(yd)).days) > 7:
                continue
            sv = sec.get(key, {}).get(sd)
            tag = f"{key}@{yd}"
            if sv is None:
                out["missing"].append(tag)
                continue
            rel = abs(sv - yv) / max(abs(yv), 1e-9)
            out["exact" if rel <= 0.005 else "close" if rel <= 0.05 else "mismatch"].append(tag)
    return out


@pytest.mark.parametrize("period", ["annual", "quarterly"])
def test_aapl_matches_yahoo(period: str) -> None:
    g = _grades("aapl", period)
    assert not g["mismatch"] and not g["missing"], g
    assert len(g["exact"]) >= (100 if period == "annual" else 120)


@pytest.mark.parametrize("period", ["annual", "quarterly"])
def test_amzn_matches_yahoo(period: str) -> None:
    g = _grades("amzn", period)  # TTM columns in 10-Qs, no us-gaap:Liabilities, split 20:1
    assert not g["mismatch"] and not g["missing"], g
    assert len(g["exact"]) >= 90


def test_amzn_annual_periods_are_fiscal_years() -> None:
    periods, _, _ = build_statements(fixture("sec_companyfacts_amzn.json"), "annual")
    assert all(p.endswith("-12-31") for p in periods)


def test_nvo_ifrs_annual_and_no_quarters() -> None:
    periods, ccy, _ = build_statements(fixture("sec_companyfacts_nvo.json"), "annual")
    assert ccy == "DKK" and len(periods) >= 5
    g = _grades("nvo", "annual")
    assert len(g["exact"]) >= 60 and len(g["mismatch"]) <= 10, g
    with pytest.raises(NotFound):  # 20-F filers have no quarterly XBRL -> Yahoo fallback
        build_statements(fixture("sec_companyfacts_nvo.json"), "quarterly")
