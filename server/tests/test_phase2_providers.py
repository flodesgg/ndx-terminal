from __future__ import annotations

from typing import Any

import httpx
import pytest
import respx

from ndx_server.models import AssetClass, Latency
from ndx_server.providers.alphavantage import (
    AlphaVantageProvider,
    parse_fx,
    parse_global_quote,
    parse_overview,
)
from ndx_server.providers.base import NotFound, NotSupported, RateLimited
from ndx_server.providers.coingecko import CoinGeckoProvider, parse_markets
from ndx_server.providers.erapi import ErApiProvider, cross_rate
from ndx_server.providers.finnhub import FinnhubProvider, parse_news, parse_profile, parse_quote
from ndx_server.providers.rss import RssProvider, parse_feed
from ndx_server.providers.yahoo import parse_news as parse_yahoo_news
from ndx_server.symbols import classify

from .helpers import fixture, fixture_file


def test_finnhub_parsers() -> None:
    q = parse_quote("TEST", fixture("finnhub_quote.json"))
    assert q.price == 101.25 and q.prev_close == 100.0 and q.ts is not None
    with pytest.raises(NotFound):
        parse_quote("NOPE", fixture("finnhub_quote_unknown.json"))
    news = parse_news(fixture("finnhub_company_news.json"))
    assert [n.tickers for n in news] == [["TEST"], ["TEST"]]
    p = parse_profile(classify("TEST"), fixture("finnhub_profile.json"))
    assert p.market_cap == pytest.approx(1.5000005e12)  # millions -> units


@respx.mock
async def test_finnhub_provider_scope_and_key() -> None:
    route = respx.get("https://finnhub.io/api/v1/quote").mock(
        return_value=httpx.Response(200, json=fixture("finnhub_quote.json"))
    )
    fp = FinnhubProvider("k")
    assert fp.enabled and not FinnhubProvider("").enabled
    q = await fp.quote(classify("TEST"))
    assert q.price == 101.25 and route.calls[0].request.headers["x-finnhub-token"] == "k"
    assert "token" not in route.calls[0].request.url.params
    with pytest.raises(NotSupported):
        await fp.quote(classify("NOVO-B.CO"))
    await fp.aclose()


def test_alphavantage_parsers() -> None:
    q = parse_global_quote("TEST", fixture("alphavantage_global_quote.json"))
    assert q.price == 101.25 and q.change_pct == 1.25
    fx = parse_fx("EURDKK", fixture("alphavantage_fx.json"))
    assert fx.price == pytest.approx(7.4612) and fx.bid and fx.ask
    with pytest.raises(RateLimited):
        parse_global_quote("TEST", fixture("alphavantage_ratelimit.json"))
    p = parse_overview(classify("TEST"), fixture("alphavantage_overview.json"))
    assert p.dividend_yield == pytest.approx(1.25) and p.sector == "Technology"


@respx.mock
async def test_alphavantage_latency_and_rate_limit_payload() -> None:
    respx.get("https://www.alphavantage.co/query").mock(
        return_value=httpx.Response(200, json=fixture("alphavantage_ratelimit.json"))
    )
    av = AlphaVantageProvider("k")
    assert av.latency(AssetClass.EQUITY)[0] is Latency.EOD
    with pytest.raises(RateLimited):
        await av.quote(classify("TEST"))
    await av.aclose()


def test_coingecko_parser() -> None:
    rows = parse_markets(fixture("coingecko_markets.json"))
    assert rows[0].symbol == "BTC" and rows[0].rank == 1
    assert rows[0].market_cap and rows[0].market_cap > rows[1].market_cap  # type: ignore[operator]
    assert any(r.change_7d_pct is not None for r in rows)


@respx.mock
async def test_coingecko_provider() -> None:
    respx.get("https://api.coingecko.com/api/v3/coins/markets").mock(
        return_value=httpx.Response(200, json=fixture("coingecko_markets.json"))
    )
    cg = CoinGeckoProvider()
    rows = await cg.markets(10)
    assert len(rows) == 12
    assert cg.result_meta(AssetClass.CRYPTO, rows)[0] is Latency.STATIC  # -> CACHE hh:mm
    await cg.aclose()


def test_erapi_cross_rates() -> None:
    t = fixture("erapi_usd.json")
    eurdkk = cross_rate(t, "EURDKK")
    assert 7.3 < eurdkk < 7.6  # DKK is pegged to EUR
    assert cross_rate(t, "USDEUR") == pytest.approx(t["rates"]["EUR"])
    assert cross_rate(t, "EURUSD") == pytest.approx(1 / t["rates"]["EUR"])
    with pytest.raises(NotFound):
        cross_rate(t, "EURXXX")


@respx.mock
async def test_erapi_provider_is_eod() -> None:
    respx.get("https://open.er-api.com/v6/latest/USD").mock(
        return_value=httpx.Response(200, json=fixture("erapi_usd.json"))
    )
    ep = ErApiProvider()
    qs = await ep.quotes([classify("EURDKK"), classify("USDUAH")])
    assert set(qs) == {"EURDKK", "USDUAH"} and qs["EURDKK"].change is None
    assert ep.result_meta(AssetClass.FX, qs["EURDKK"])[0] is Latency.EOD
    await ep.aclose()


def test_rss_parser() -> None:
    items = parse_feed(fixture_file("rss_cnbc.xml").read_bytes(), "https://www.cnbc.com/x")
    assert len(items) > 5
    assert all(i.published and i.url.startswith("http") for i in items)
    assert "<" not in (items[0].summary or "")


@respx.mock
async def test_rss_provider_partial_failure() -> None:
    respx.get("https://ok.example/feed").mock(
        return_value=httpx.Response(200, content=fixture_file("rss_cnbc.xml").read_bytes())
    )
    respx.get("https://down.example/feed").mock(return_value=httpx.Response(503))
    rp = RssProvider(["https://ok.example/feed", "https://down.example/feed"])
    items = await rp.news(None, 5)
    assert len(items) == 5
    assert items == sorted(items, key=lambda n: n.published, reverse=True)
    with pytest.raises(NotSupported):
        await rp.news(classify("AAPL"), 5)
    assert not RssProvider([]).enabled
    await rp.aclose()


def test_yahoo_news_parser() -> None:
    items = parse_yahoo_news(fixture("yahoo_news_aapl.json"))
    assert items and all(i.provider == "Yahoo Finance" for i in items)


async def test_one_bad_symbol_never_blanks_the_batch() -> None:
    # Review 1a #0: NOVO-B.CO (unsupported by Finnhub) or an unknown ticker in the polled equity
    # batch turned every US quote into N.A.
    import time

    from ndx_server.market import MarketService
    from ndx_server.providers.registry import PREFERENCES
    from ndx_server.providers.router import ProviderRouter

    def handler(req: httpx.Request) -> httpx.Response:
        if req.url.params.get("symbol") == "ZZZZ":
            return httpx.Response(200, json={"c": 0, "t": 0})
        q = {"c": 100.0, "d": 1, "dp": 1, "h": 101, "l": 99, "o": 99.5, "pc": 99}
        return httpx.Response(200, json={**q, "t": int(time.time())})

    for syms, bad in ((["AAPL", "NOVO-B.CO"], "NOVO-B.CO"), (["MSFT", "ZZZZ"], "ZZZZ")):
        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        fh = FinnhubProvider("testkey", client=client)
        svc = MarketService(ProviderRouter([fh], preferences=PREFERENCES, retry_delays=()))
        items = {it.symbol: it for it in (await svc.quotes(syms)).items}
        good = next(s for s in syms if s != bad)
        assert items[good].data is not None and items[good].data.price == 100.0
        assert items[bad].data is None and items[bad].error


async def test_batch_quotes_take_one_rate_token_per_request() -> None:
    # Review 1a #4: a 20-symbol batch made 20 HTTP calls on one token (Finnhub 60/min breached).
    import time

    from ndx_server.providers.ratelimit import TokenBucket
    from ndx_server.providers.router import ProviderRouter

    calls = 0
    acquires = 0

    def handler(req: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        q = {"c": 1.0, "d": 0, "dp": 0, "h": 1, "l": 1, "o": 1, "pc": 1, "t": int(time.time())}
        return httpx.Response(200, json=q)

    class Counting(TokenBucket):
        async def acquire(self, max_wait: float = 5.0) -> bool:
            nonlocal acquires
            acquires += 1
            return await super().acquire(max_wait)

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    fh = FinnhubProvider("x", client=client, rate=Counting.per_minute(600, burst=50))
    router = ProviderRouter([fh], retry_delays=())
    syms = [classify(s) for s in ["AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "TSLA", "JPM"]]
    got = await router._call_with_retry(fh, lambda p: p.quotes(syms))
    assert len(got) == calls == acquires == 8


def _fh_service(
    handler: Any, retry_delays: tuple[float, ...] = ()
) -> tuple[FinnhubProvider, Any, list[str]]:
    from ndx_server.market import MarketService
    from ndx_server.providers.registry import PREFERENCES
    from ndx_server.providers.router import ProviderRouter

    seen: list[str] = []

    def wrapped(req: httpx.Request) -> httpx.Response:
        seen.append(str(req.url.params.get("symbol")))
        return handler(req)  # type: ignore[no-any-return]

    client = httpx.AsyncClient(transport=httpx.MockTransport(wrapped))
    fh = FinnhubProvider("testkey", client=client)
    router = ProviderRouter([fh], preferences=PREFERENCES, retry_delays=retry_delays)
    return fh, MarketService(router), seen


def _ok_quote() -> dict[str, Any]:
    import time

    q = {"c": 100.0, "d": 1, "dp": 1, "h": 101, "l": 99, "o": 99.5, "pc": 99}
    return {**q, "t": int(time.time())}


@pytest.mark.parametrize(("status", "code"), [(401, "upstream"), (429, "rate_limited")])
async def test_batch_stops_on_rate_limit_or_rejected_key(status: int, code: str) -> None:
    # Re-verify R1: a 429 or 401 kept the batch sending one doomed request per symbol.
    syms = [f"S{i}" for i in range(12)]
    fh, svc, seen = _fh_service(lambda req: httpx.Response(status, text="no"))
    items = (await svc.quotes(syms)).items
    assert len(seen) == 1
    assert all(it.error and it.error.startswith(f"[{code}]") for it in items)
    assert fh.errors == 1


async def test_batch_stops_mid_way_and_labels_the_rest() -> None:
    # 429 on the 2nd symbol: the 1st is kept, the rest are not requested, all labelled.
    def handler(req: httpx.Request) -> httpx.Response:
        if req.url.params.get("symbol") == "AAPL":
            return httpx.Response(200, json=_ok_quote())
        return httpx.Response(429, text="slow down")

    fh, svc, seen = _fh_service(handler)
    items = {it.symbol: it for it in (await svc.quotes(["AAPL", "MSFT", "NVDA", "AMZN"])).items}
    assert seen == ["AAPL", "MSFT"]
    assert items["AAPL"].data is not None
    for s in ("MSFT", "NVDA", "AMZN"):
        assert items[s].error is not None and items[s].error.startswith("[rate_limited]")
    assert fh.rate_limited >= 1


async def test_per_symbol_errors_keep_their_class_and_reach_health() -> None:
    # Re-verify R2: per-symbol failures became not_found, were never retried or counted.
    flaky = {"MSFT": 1}

    def handler(req: httpx.Request) -> httpx.Response:
        sym = str(req.url.params.get("symbol"))
        if flaky.get(sym):
            flaky[sym] -= 1
            return httpx.Response(503, text="busy")
        if sym == "TSLA":
            return httpx.Response(503, text="still busy")
        return httpx.Response(200, json=_ok_quote())

    fh, svc, _seen = _fh_service(handler, retry_delays=(0.0,))
    items = {
        it.symbol: it for it in (await svc.quotes(["AAPL", "MSFT", "TSLA", "NOVO-B.CO"])).items
    }
    assert items["MSFT"].data is not None  # transient error retried once
    assert items["TSLA"].error is not None and items["TSLA"].error.startswith("[upstream]")
    # Unsupported next to a supported symbol is still "no enabled provider", not not_found.
    assert items["NOVO-B.CO"].error is not None
    assert items["NOVO-B.CO"].error.startswith("[no_provider]")
    assert fh.errors >= 2  # MSFT's first 503 and TSLA's


async def test_all_failed_batch_keeps_each_symbols_error_and_retries_once() -> None:
    # Re-verify N1/N3: OLDCO (no quote) first, MSFT (503 once) second. MSFT must not show
    # OLDCO's not_found, and its transient error is retried exactly once.
    calls: dict[str, int] = {}

    def handler(req: httpx.Request) -> httpx.Response:
        s = str(req.url.params.get("symbol"))
        calls[s] = calls.get(s, 0) + 1
        if s == "OLDCO":
            return httpx.Response(200, json={**_ok_quote(), "c": 0})
        return httpx.Response(503, text="busy")

    _fh, svc, _seen = _fh_service(handler, retry_delays=(0.0, 0.0))
    items = {it.symbol: it for it in (await svc.quotes(["OLDCO", "MSFT"])).items}
    assert items["OLDCO"].error is not None and items["OLDCO"].error.startswith("[not_found]")
    msft = items["MSFT"].error
    assert msft is not None and msft.startswith("[upstream]") and "OLDCO" not in msft
    assert calls["MSFT"] == 2  # the batch request + one retry, never a nested back-off loop


async def test_health_counts_real_outcomes_once() -> None:
    # Re-verify N2: unknown symbols are answers, not provider errors; one 429 is one error.
    def unknown(req: httpx.Request) -> httpx.Response:
        if req.url.params.get("symbol") == "AAPL":
            return httpx.Response(200, json=_ok_quote())
        return httpx.Response(200, json={**_ok_quote(), "c": 0})

    fh, svc, _seen = _fh_service(unknown)
    await svc.quotes(["AAPL", "VFIAX", "OLDCO", "XYZQ"])
    assert (fh.errors, fh.consecutive_errors, fh.status().state.value) == (0, 0, "ok")

    def limited(req: httpx.Request) -> httpx.Response:
        if req.url.params.get("symbol") == "AAPL":
            return httpx.Response(200, json=_ok_quote())
        return httpx.Response(429, text="slow down")

    fh, svc, seen = _fh_service(limited)
    await svc.quotes(["AAPL", "MSFT", *[f"T{i}" for i in range(8)]])
    assert len(seen) == 2
    assert (fh.errors, fh.rate_limited) == (1, 1)
    assert fh.status().state.value != "down"


async def test_partial_retry_is_one_request() -> None:
    # Re-verify N3: a failing symbol inside a served batch got 1 + 3 requests (nested back-off).
    calls: dict[str, int] = {}

    def handler(req: httpx.Request) -> httpx.Response:
        s = str(req.url.params.get("symbol"))
        calls[s] = calls.get(s, 0) + 1
        return httpx.Response(200, json=_ok_quote()) if s == "AAPL" else httpx.Response(503)

    _fh, svc, _seen = _fh_service(handler, retry_delays=(0.0, 0.0))
    await svc.quotes(["AAPL", "MSFT"])
    assert calls == {"AAPL": 1, "MSFT": 2}
