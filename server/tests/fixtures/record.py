"""Re-record provider fixtures from live endpoints (run manually, never in CI).

uv run python tests/fixtures/record.py
"""

from __future__ import annotations

import json
from pathlib import Path

import httpx
from yfinance.data import YfData

HERE = Path(__file__).parent
Q1 = "https://query1.finance.yahoo.com"
Q2 = "https://query2.finance.yahoo.com"


def save(name: str, data: object) -> None:
    (HERE / name).write_text(json.dumps(data, indent=1, sort_keys=True))
    print("saved", name)


def main() -> None:
    yd = YfData()
    save(
        "yahoo_quote.json",
        yd.get_raw_json(
            f"{Q1}/v7/finance/quote",
            params={
                "symbols": "AAPL,NOVO-B.CO,^GSPC,EURUSD=X,7203.T,SPY,BTC-USD",
                "formatted": "false",
            },
        ),
    )
    save(
        "yahoo_chart_aapl_1d.json",
        yd.get_raw_json(
            f"{Q2}/v8/finance/chart/AAPL",
            params={
                "range": "1mo",
                "interval": "1d",
                "events": "div,splits",
                "includeAdjustedClose": "true",
            },
        ),
    )
    save(
        "yahoo_chart_aapl_5m.json",
        yd.get_raw_json(
            f"{Q2}/v8/finance/chart/AAPL",
            params={"range": "1d", "interval": "5m", "includePrePost": "false"},
        ),
    )
    save(
        "yahoo_chart_7203_1d.json",
        yd.get_raw_json(
            f"{Q2}/v8/finance/chart/7203.T",
            params={"range": "5d", "interval": "1d", "includeAdjustedClose": "true"},
        ),
    )
    save(
        "yahoo_search_novo.json",
        yd.get_raw_json(
            f"{Q2}/v1/finance/search",
            params={"q": "novo", "quotesCount": 8, "newsCount": 0, "enableFuzzyQuery": "false"},
        ),
    )
    save(
        "yahoo_summary_aapl.json",
        yd.get_raw_json(
            f"{Q2}/v10/finance/quoteSummary/AAPL",
            params={
                "modules": "assetProfile,summaryDetail,defaultKeyStatistics,price,calendarEvents",
                "formatted": "false",
            },
        ),
    )
    b = "https://data-api.binance.vision/api/v3"
    save(
        "binance_ticker_btc.json",
        httpx.get(f"{b}/ticker/24hr", params={"symbol": "BTCUSDT"}).json(),
    )
    save(
        "binance_tickers.json",
        httpx.get(
            f"{b}/ticker/24hr",
            params={"symbols": json.dumps(["BTCUSDT", "ETHUSDT"], separators=(",", ":"))},
        ).json(),
    )
    save(
        "binance_klines_btc_1h.json",
        httpx.get(
            f"{b}/klines", params={"symbol": "BTCUSDT", "interval": "1h", "limit": 50}
        ).json(),
    )
    info = httpx.get(f"{b}/exchangeInfo", params={"permissions": "SPOT"}).json()
    keep = {"BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBBTC", "ETHBTC", "DOGEUSDT", "BTCUSDC"}
    info["symbols"] = [
        {k: s[k] for k in ("symbol", "status", "baseAsset", "quoteAsset")}
        for s in info["symbols"]
        if s["symbol"] in keep
    ]
    save("binance_exchangeinfo.json", {"symbols": info["symbols"]})
    save(
        "yahoo_news_aapl.json",
        yd.get_raw_json(
            f"{Q2}/v1/finance/search", params={"q": "AAPL", "quotesCount": 0, "newsCount": 8}
        ),
    )
    cg = httpx.get(
        "https://api.coingecko.com/api/v3/coins/markets",
        params={
            "vs_currency": "usd",
            "order": "market_cap_desc",
            "per_page": 12,
            "page": 1,
            "price_change_percentage": "24h,7d",
        },
        timeout=20,
    ).json()
    save("coingecko_markets.json", cg)
    save("erapi_usd.json", httpx.get("https://open.er-api.com/v6/latest/USD", timeout=20).json())
    rss = httpx.get(
        "https://www.cnbc.com/id/100003114/device/rss/rss.html",
        timeout=20,
        headers={"User-Agent": "Mozilla/5.0 NDXTerminal"},
    ).content
    (HERE / "rss_cnbc.xml").write_bytes(rss)
    print("saved rss_cnbc.xml")


def sec() -> None:
    """Needs EDGAR_USER_AGENT (SEC requires a contact in the User-Agent)."""
    from ndx_server.config import get_settings

    ua = get_settings().edgar_user_agent
    assert ua, "set EDGAR_USER_AGENT in .env"
    with httpx.Client(headers={"User-Agent": ua}, timeout=60) as c:
        tick = c.get("https://www.sec.gov/files/company_tickers.json").json()
        keep = {"AAPL", "MSFT", "BRK-B", "NVO", "JPM"}
        save("sec_company_tickers.json", {k: v for k, v in tick.items() if v["ticker"] in keep})
        subs = c.get("https://data.sec.gov/submissions/CIK0000320193.json").json()
        recent = subs["filings"]["recent"]
        n = len(recent["accessionNumber"])
        # Newest 40 filings plus every 10-K/10-Q, arrays kept aligned.
        idx = [i for i in range(n) if i < 40 or recent["form"][i] in ("10-K", "10-Q")]
        subs["filings"]["recent"] = {
            k: [v[i] for i in idx] for k, v in recent.items() if isinstance(v, list)
        }
        subs["filings"]["files"] = []
        save("sec_submissions_aapl.json", {k: subs[k] for k in ("cik", "name", "filings")})


def trim_companyfacts(payload: dict, concepts: set[str], since: str = "2017-01-01") -> dict:
    """Keep only mapped concepts and recent facts so fixtures stay small."""
    facts = {}
    for tax, cs in payload["facts"].items():
        kept = {}
        for name, c in cs.items():
            if name not in concepts:
                continue
            units = {
                u: [f for f in fs if f.get("end", "") >= since] for u, fs in c["units"].items()
            }
            kept[name] = {
                "label": c.get("label"),
                "units": {u: fs for u, fs in units.items() if fs},
            }
        if kept:
            facts[tax] = kept
    return {"cik": payload.get("cik"), "entityName": payload.get("entityName"), "facts": facts}


def sec_companyfacts(tickers: tuple[str, ...] = ("AAPL", "AMZN", "NVO")) -> None:
    """Trimmed companyfacts + Yahoo reference statements for the SEC financials tests."""
    import asyncio

    from ndx_server.config import get_settings
    from ndx_server.providers.sec import parse_ticker_map
    from ndx_server.providers.sec_financials import SPECS
    from ndx_server.providers.yahoo import YahooProvider
    from ndx_server.symbols import classify

    concepts = {c for s in SPECS for c in (*s.us_gaap, *s.ifrs)}
    ua = get_settings().edgar_user_agent
    assert ua, "set EDGAR_USER_AGENT in .env"
    with httpx.Client(headers={"User-Agent": ua}, timeout=90) as c:
        ciks = parse_ticker_map(c.get("https://www.sec.gov/files/company_tickers.json").json())
        for t in tickers:
            url = f"https://data.sec.gov/api/xbrl/companyfacts/CIK{ciks[t]:010d}.json"
            save(
                f"sec_companyfacts_{t.lower()}.json", trim_companyfacts(c.get(url).json(), concepts)
            )

    async def yahoo() -> None:
        yp = YahooProvider()
        for t in tickers:
            ref = {}
            for period in ("annual", "quarterly"):
                periods, ccy, sts = await yp.fundamentals(classify(t), period)
                ref[period] = {
                    "currency": ccy,
                    "periods": periods,
                    "lines": {
                        ln.key: ln.values for st in sts if st.name != "ratios" for ln in st.lines
                    },
                }
            save(f"yahoo_statements_{t.lower()}.json", ref)
        await yp.aclose()

    asyncio.run(yahoo())


def phase3() -> None:
    import time

    yd = YfData()
    now = int(time.time())
    types = ",".join(
        f"{p}{t}"
        for p in ("annual", "quarterly")
        for t in (
            "TotalRevenue",
            "GrossProfit",
            "OperatingIncome",
            "NetIncome",
            "DilutedEPS",
            "TotalAssets",
            "TotalLiabilitiesNetMinorityInterest",
            "StockholdersEquity",
            "CashAndCashEquivalents",
            "TotalDebt",
            "OperatingCashFlow",
            "CapitalExpenditure",
            "FreeCashFlow",
        )
    )
    save(
        "yahoo_fundamentals_aapl.json",
        yd.get_raw_json(
            f"{Q2}/ws/fundamentals-timeseries/v1/finance/timeseries/AAPL",
            params={"symbol": "AAPL", "type": types, "period1": 493590046, "period2": now},
        ),
    )
    save(
        "yahoo_filings_insiders_aapl.json",
        yd.get_raw_json(
            f"{Q2}/v10/finance/quoteSummary/AAPL",
            params={"modules": "secFilings,insiderTransactions", "formatted": "false"},
        ),
    )
    body = {
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
        "size": 25,
        "offset": 0,
        "query": {
            "operator": "and",
            "operands": [
                {"operator": "gte", "operands": ["startdatetime", "2026-11-09"]},
                {"operator": "lte", "operands": ["startdatetime", "2026-11-13"]},
            ],
        },
    }
    resp = yd.post(
        f"{Q1}/v1/finance/visualization", params={"lang": "en-US", "region": "US"}, body=body
    )
    save("yahoo_econ_calendar.json", resp.json())
    scr = {
        "size": 10,
        "offset": 0,
        "sortField": "intradaymarketcap",
        "sortType": "DESC",
        "quoteType": "EQUITY",
        "userId": "",
        "userIdType": "guid",
        "query": {
            "operator": "and",
            "operands": [
                {"operator": "eq", "operands": ["region", "dk"]},
                {"operator": "gt", "operands": ["intradaymarketcap", 10_000_000_000]},
            ],
        },
    }
    import json as _json

    resp = yd.post(
        f"{Q1}/v1/finance/screener",
        params={
            "lang": "en-US",
            "region": "US",
            "formatted": "false",
            "corsDomain": "finance.yahoo.com",
        },
        data=_json.dumps(scr, separators=(",", ":")),
    )
    save("yahoo_screener_dk.json", resp.json())
    tr = httpx.get(
        "https://home.treasury.gov/resource-center/data-chart-center/interest-rates/"
        "daily-treasury-rates.csv/2026/all",
        params={
            "type": "daily_treasury_yield_curve",
            "field_tdr_date_value": "2026",
            "page": "",
            "_format": "csv",
        },
        timeout=30,
        follow_redirects=True,
    ).text
    (HERE / "treasury_2026.csv").write_text("\n".join(tr.splitlines()[:30]))
    print("saved treasury_2026.csv")
    fc = httpx.get(
        "https://fred.stlouisfed.org/graph/fredgraph.csv",
        params={"id": "UNRATE"},
        timeout=30,
        follow_redirects=True,
    ).text
    # FRED's site terms forbid storing its content (docs/PROVIDERS.md P3): keep the recorded
    # layout (header, dates, unpublished-period markers) and replace every value.
    (HERE / "fred_unrate.csv").write_text(synthetic_fred_csv(fc, 36))
    print("saved fred_unrate.csv (synthetic values)")


def synthetic_fred_csv(text: str, rows: int) -> str:
    """The last `rows` rows of a FRED CSV with each published value replaced by 5.00, 5.01, ...
    (empty or "." markers kept: they are FRED's way of saying "not published")."""
    lines = text.strip().splitlines()
    out = [lines[0]]
    for i, line in enumerate(lines[-rows:]):
        day, _, value = line.partition(",")
        out.append(f"{day},{value if value in ('', '.') else f'{5 + i / 100:.2f}'}")
    return "\n".join(out)


EODHD = "https://eodhd.com/api"
# /api/user also returns the account holder's name and email: keep only the counters.
EODHD_USER_FIELDS = ("apiRequests", "apiRequestsDate", "dailyRateLimit", "extraLimit")


def eodhd() -> None:
    """EODHD Free fixtures (needs EODHD_API_KEY). Spends 3 of the 20 daily calls; /api/user
    is free. Never prints the key; error bodies are saved with their status."""
    from datetime import date, timedelta

    from ndx_server.config import get_settings

    key = get_settings().eodhd_api_key
    assert key, "set EODHD_API_KEY (Keychain or .env)"
    p = {"api_token": key, "fmt": "json"}
    since = (date.today() - timedelta(days=14)).isoformat()
    with httpx.Client(timeout=30) as c:

        def user(name: str) -> None:
            r = c.get(f"{EODHD}/user", params=p)
            print("user", r.status_code)
            raw = r.json()
            save(name, {k: raw.get(k) for k in EODHD_USER_FIELDS})

        def eod(name: str, symbol: str) -> None:
            r = c.get(f"{EODHD}/eod/{symbol}", params={**p, "from": since})
            print("eod", symbol, r.status_code)
            try:
                body: object = r.json()
            except ValueError:
                body = r.text[:300]
            save(name, {"status": r.status_code, "body": body})

        user("eodhd_user.json")
        eod("eodhd_eod_novo.json", "NOVO-B.CO")
        eod("eodhd_eod_unknown.json", "NOSUCHTICKERX.CO")
        eod("eodhd_eod_index.json", "OMXC25.INDX")
        user("eodhd_user_after.json")


ECB_EXR = "https://data-api.ecb.europa.eu/service/data/EXR/D..EUR.SP00.A"
NBU = "https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange"


def fx() -> None:
    """ECB EXR (all currencies, last two observations) and NBU official UAH rates."""
    from ndx_server.providers.http import DEFAULT_UA

    with httpx.Client(timeout=30, headers={"User-Agent": DEFAULT_UA}) as c:
        r = c.get(
            ECB_EXR,
            params={"lastNObservations": "2", "format": "csvdata", "detail": "dataonly"},
        )
        r.raise_for_status()
        (HERE / "ecb_exr_last2.csv").write_text(r.text)
        print("saved ecb_exr_last2.csv")
        for day in ("20261109", "20261108"):
            r = c.get(NBU, params={"json": "", "date": day})
            r.raise_for_status()
            save(f"nbu_{day}.json", r.json())


MASSIVE = "https://api.massive.com"


def massive() -> None:
    """Massive Stocks Basic fixtures (needs MASSIVE_API_KEY; Bearer header, never in a URL or
    on screen). 5 calls, 16 s apart (plan: 5/min). Results are trimmed: the plan's terms allow
    storing for personal use but the tests need only the shape and a few bars."""
    import time
    from datetime import datetime, timedelta
    from zoneinfo import ZoneInfo

    from ndx_server.config import get_settings

    key = get_settings().massive_api_key
    assert key, "set MASSIVE_API_KEY (Keychain or .env)"
    et_today = datetime.now(ZoneInfo("America/New_York")).date()
    prev = (et_today - timedelta(days=1)).isoformat()
    two_years = (et_today - timedelta(days=730)).isoformat()
    week_ago = (et_today - timedelta(days=7)).isoformat()
    q = {"adjusted": "true", "sort": "asc", "limit": "50000"}

    def keep(body: object, head: int, tail: int) -> object:
        if isinstance(body, dict) and isinstance(body.get("results"), list):
            r = body["results"]
            body = {**body, "results": r[:head] + r[-tail:] if len(r) > head + tail else r}
            body["_recorded_results"] = len(r)  # how many the full answer had
        return body

    with httpx.Client(timeout=30, headers={"Authorization": f"Bearer {key}"}) as c:

        def get(name: str, path: str, head: int = 3, tail: int = 7) -> None:
            r = c.get(f"{MASSIVE}{path}", params=q)
            try:
                body: object = r.json()
            except ValueError:
                body = r.text[:300]
            text = json.dumps(body)
            assert key not in text, "the key came back in a response"
            n = body.get("resultsCount") if isinstance(body, dict) else None
            ticker, _, span = path.removeprefix("/v2/aggs/ticker/").partition("/range/")
            print(ticker, span, r.status_code, "results", n)
            save(name, {"status": r.status_code, "body": keep(body, head, tail)})
            time.sleep(16)

        get("massive_aapl_1d.json", f"/v2/aggs/ticker/AAPL/range/1/day/{two_years}/{prev}")
        get("massive_aapl_5m.json", f"/v2/aggs/ticker/AAPL/range/5/minute/{week_ago}/{prev}", 4, 12)
        get("massive_brkb_1d.json", f"/v2/aggs/ticker/BRK.B/range/1/day/{week_ago}/{prev}", 2, 3)
        get("massive_today_403.json", f"/v2/aggs/ticker/AAPL/range/1/day/{et_today}/{et_today}")
        get("massive_unknown.json", f"/v2/aggs/ticker/ZZZZQX/range/1/day/{week_ago}/{prev}")


if __name__ == "__main__":
    import sys

    if "eodhd" in sys.argv:
        eodhd()
    elif "massive" in sys.argv:
        massive()
    elif "fx" in sys.argv:
        fx()
    elif "sec-facts" in sys.argv:
        sec_companyfacts()
    elif "sec" in sys.argv:
        sec()
    elif "phase3" in sys.argv:
        phase3()
    else:
        main()
