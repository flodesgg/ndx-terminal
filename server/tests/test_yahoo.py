from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

import pytest

from ndx_server.models import AssetClass, Latency
from ndx_server.providers.base import NotFound, NotSupported
from ndx_server.providers.yahoo import (
    OPT_IN_SCOPES,
    YahooProvider,
    from_yahoo_symbol,
    parse_chart,
    parse_profile,
    parse_quote,
    parse_search,
    quote_results,
)
from ndx_server.symbols import classify

from .helpers import fixture


def _quotes() -> dict[str, dict[str, Any]]:
    return {q["symbol"]: q for q in quote_results(fixture("yahoo_quote.json"))}


def test_quote_parsing_and_honest_latency() -> None:
    raw = _quotes()
    aapl = parse_quote(raw["AAPL"], "AAPL")
    assert aapl.price == pytest.approx(342.37)
    assert aapl.currency == "USD"
    # Yahoo bid/ask is neither a venue book nor consolidated -> N.A. (B3).
    assert aapl.bid is None and aapl.ask is None
    # Yahoo says "Nasdaq Real Time Price" but exchangeDataDelayedBy=15 -> we must say D15.
    assert aapl._latency is not None and aapl._latency[:2] == (Latency.DELAYED, 15)
    # Yahoo is never labelled RT, even when it states a 0-minute delay (B3).
    spy = parse_quote(raw["SPY"], "SPY")
    assert spy._latency is not None and spy._latency[:2] == (Latency.DELAYED, 0)
    novo = parse_quote(raw["NOVO-B.CO"], "NOVO-B.CO")
    assert novo._latency is not None and novo._latency[0] is Latency.DELAYED
    toyota = parse_quote(raw["7203.T"], "7203.T")
    assert toyota._latency is not None and toyota._latency[1] == 20


def test_symbol_mapping() -> None:
    assert from_yahoo_symbol("EURUSD=X") == "EURUSD"
    assert from_yahoo_symbol("JPY=X") == "USDJPY"
    assert from_yahoo_symbol("AAPL") == "AAPL"


def test_daily_chart_dates_and_adjustment() -> None:
    s = parse_chart(fixture("yahoo_chart_aapl_1d.json"), "1d")
    assert s.tz == "America/New_York" and len(s.bars) > 15
    for b in s.bars:
        assert b.t % 86400 == 0  # daily bars encoded as local dates at 00:00
        assert b.l <= min(b.o, b.c) + 1e-9 and b.h >= max(b.o, b.c) - 1e-9
    assert [b.t for b in s.bars] == sorted({b.t for b in s.bars})


def test_tokyo_daily_bars_keep_local_date() -> None:
    raw = fixture("yahoo_chart_7203_1d.json")
    first_ts = raw["chart"]["result"][0]["timestamp"][0]
    s = parse_chart(raw, "1d")
    local_date = datetime.fromtimestamp(first_ts + 9 * 3600, UTC).date()
    assert datetime.fromtimestamp(s.bars[0].t, UTC).date() == local_date


def test_intraday_chart_is_wall_clock_and_resamples() -> None:
    raw = fixture("yahoo_chart_aapl_5m.json")
    s5 = parse_chart(raw, "5m")
    first = datetime.fromtimestamp(s5.bars[0].t, UTC)
    assert (first.hour, first.minute) == (9, 30)  # NY session open in wall-clock time
    s4h = parse_chart(raw, "4h")
    assert s4h.bars[0].t == s5.bars[0].t
    assert len(s4h.bars) == 2  # 09:30-13:30 and 13:30-16:00
    assert s4h.bars[0].h == max(b.h for b in s5.bars if b.t < s4h.bars[1].t)
    assert sum(b.v for b in s4h.bars) == pytest.approx(sum(b.v for b in s5.bars))


def test_chart_error_maps_to_not_found() -> None:
    payload = {"chart": {"result": None, "error": {"code": "Not Found", "description": "x"}}}
    with pytest.raises(NotFound):
        parse_chart(payload, "1d")


def test_search_parsing() -> None:
    res = parse_search(fixture("yahoo_search_novo.json"))
    syms = [r.symbol for r in res]
    assert "NOVO-B.CO" in syms and "NVO" in syms
    assert all(r.asset_class is AssetClass.EQUITY for r in res)


def test_profile_parsing() -> None:
    p = parse_profile(classify("AAPL"), fixture("yahoo_summary_aapl.json"), _quotes()["AAPL"])
    assert p.sector == "Technology" and p.industry == "Consumer Electronics"
    assert p.employees == 167000 and p.market_cap and p.market_cap > 1e12
    assert p.week52_high and p.week52_low and p.week52_high > p.week52_low
    assert p.next_earnings is not None and p.earnings_estimate is True
    assert p.description and "Apple" in p.description
    assert p.dividend_yield == pytest.approx(0.32)  # percent, not fraction


async def test_provider_uses_transport(monkeypatch: pytest.MonkeyPatch) -> None:
    yp = YahooProvider()
    calls: list[str] = []

    def fake_get(url: str, params: dict[str, Any]) -> Any:
        calls.append(url)
        if "/v7/finance/quote" in url:
            return fixture("yahoo_quote.json")
        if "/v8/finance/chart/" in url:
            return fixture("yahoo_chart_aapl_1d.json")
        raise AssertionError(url)

    monkeypatch.setattr(yp, "_get_sync", fake_get)
    qs = await yp.quotes([classify("AAPL"), classify("EURUSD"), classify("NOVO-B.CO")])
    assert set(qs) == {"AAPL", "EURUSD", "NOVO-B.CO"}
    assert yp.result_meta(AssetClass.EQUITY, qs["AAPL"])[:2] == (Latency.DELAYED, 15)
    series = await yp.bars(classify("AAPL"), "1d", 30)
    assert series.bars and series.as_of is not None
    await yp.aclose()


@pytest.mark.parametrize(("kind", "want"), [("CURRENCY", None), ("INDEX", None), ("EQUITY", 0.0)])
def test_chart_volume_zero_is_na_for_fx_and_indices(kind: str, want: float | None) -> None:
    # Review 1a #21: the quote path mapped 0 -> None for FX/indices, the chart path did not.
    payload: dict[str, Any] = {
        "chart": {
            "result": [
                {
                    "meta": {"exchangeTimezoneName": "Europe/London", "instrumentType": kind},
                    "timestamp": [1762700000],
                    "indicators": {
                        "quote": [
                            {
                                "open": [1.15],
                                "high": [1.16],
                                "low": [1.14],
                                "close": [1.155],
                                "volume": [0],
                            }
                        ]
                    },
                }
            ]
        }
    }
    assert [b.v for b in parse_chart(payload, "1d").bars] == [want]


def test_yfinance_budget_matches_providers_md() -> None:
    # Review 1a #24: PROVIDERS.md §3.3 sets 60/min, burst 10 (v1 had 240/min).
    from ndx_server.providers.yahoo import YahooProvider

    p = YahooProvider()
    assert p.rate.capacity == 10
    assert abs(p.rate.rate * 60 - 60) < 1e-9


@pytest.mark.parametrize(
    ("ticker", "covered"),
    [
        ("NOVOB DC EQUITY", True),
        ("AAPL US EQUITY", False),
        ("SPX INDEX", True),
        ("OMXC25 INDEX", True),
        ("SHCOMP INDEX", True),  # 000001.SS: an index without the caret
        ("FTSEMIB.MI", True),
        ("CL1 COMDTY", False),  # a future, classified INDEX: not an index
        ("EURUSD CURNCY", False),
    ],
)
def test_dk_indices_scope(ticker: str, covered: bool) -> None:
    assert OPT_IN_SCOPES["dk_indices"].covers(classify(ticker)) is covered


async def test_scoped_opt_in_refuses_outside_unasked(monkeypatch: pytest.MonkeyPatch) -> None:
    yp = YahooProvider()
    yp.set_scope(OPT_IN_SCOPES["dk_indices"])
    calls: list[list[str]] = []

    def fake_get(url: str, params: dict[str, Any]) -> Any:
        calls.append(str(params.get("symbols", "")).split(","))
        return fixture("yahoo_quote.json")

    monkeypatch.setattr(yp, "_get_sync", fake_get)
    with pytest.raises(NotSupported):
        await yp.quote(classify("AAPL"))
    with pytest.raises(NotSupported):
        await yp.bars(classify("AAPL"), "1d", 30)
    with pytest.raises(NotSupported):
        await yp.quotes([classify("AAPL"), classify("EURUSD")])
    with pytest.raises(NotSupported):
        await yp.search("apple")
    assert calls == []
    # A mixed batch asks only for the covered symbol; the rest fall through to the next source.
    qs = await yp.quotes([classify("AAPL"), classify("NOVO-B.CO")])
    assert calls == [["NOVO-B.CO"]] and set(qs) <= {"NOVO-B.CO"}
    assert not yp.covers(classify("AAPL")) and yp.covers(classify("NOVO-B.CO"))
    yp.set_scope(None)
    assert yp.covers(classify("AAPL")) and yp.scope_label == "every market"
    await yp.aclose()
