from __future__ import annotations

import httpx
import pytest
import respx

from ndx_server.models import AssetClass
from ndx_server.providers.base import NotFound
from ndx_server.providers.binance import BASES, BinanceProvider, parse_ws_kline, parse_ws_ticker
from ndx_server.symbols import classify

from .helpers import fixture

MAIN, MIRROR = BASES


@respx.mock
async def test_quote_and_batch() -> None:
    respx.get(f"{MAIN}/ticker/24hr", params={"symbol": "BTCUSDT"}).mock(
        return_value=httpx.Response(200, json=fixture("binance_ticker_btc.json"))
    )
    respx.get(f"{MAIN}/ticker/24hr", params__contains={"symbols": '["BTCUSDT","ETHUSDT"]'}).mock(
        return_value=httpx.Response(200, json=fixture("binance_tickers.json"))
    )
    bp = BinanceProvider()
    q = await bp.quote(classify("BTCUSDT"))
    assert q.price and q.bid and q.ask and q.ask >= q.bid and q.currency == "USDT"
    qs = await bp.quotes([classify("BTCUSDT"), classify("ETHUSDT")])
    assert set(qs) == {"BTCUSDT", "ETHUSDT"}
    assert bp.latency(AssetClass.CRYPTO)[0] == "REALTIME"
    await bp.aclose()


@respx.mock
async def test_falls_back_to_mirror_when_blocked() -> None:
    respx.get(f"{MAIN}/ticker/24hr").mock(return_value=httpx.Response(451, text="restricted"))
    respx.get(f"{MIRROR}/ticker/24hr").mock(
        return_value=httpx.Response(200, json=fixture("binance_ticker_btc.json"))
    )
    bp = BinanceProvider()
    q = await bp.quote(classify("BTCUSDT"))
    assert q.symbol == "BTCUSDT"
    await bp.aclose()


@respx.mock
async def test_invalid_symbol_is_not_found() -> None:
    respx.get(f"{MAIN}/ticker/24hr").mock(
        return_value=httpx.Response(400, json={"code": -1121, "msg": "Invalid symbol."})
    )
    bp = BinanceProvider()
    with pytest.raises(NotFound):
        await bp.quote(classify("NOPEUSDT"))
    await bp.aclose()


@respx.mock
async def test_klines_and_search() -> None:
    respx.get(f"{MAIN}/klines").mock(
        return_value=httpx.Response(200, json=fixture("binance_klines_btc_1h.json"))
    )
    respx.get(f"{MAIN}/exchangeInfo").mock(
        return_value=httpx.Response(200, json=fixture("binance_exchangeinfo.json"))
    )
    bp = BinanceProvider()
    s = await bp.bars(classify("BTCUSDT"), "1h", 2)
    assert s.tz == "UTC" and len(s.bars) == 50
    assert all(b2.t - b1.t == 3600 for b1, b2 in zip(s.bars, s.bars[1:], strict=False))
    res = await bp.search("btc")
    assert res[0].symbol == "BTCUSDT"  # USDT pair ranks first
    assert all(r.symbol.startswith("BTC") for r in res)
    await bp.aclose()


def test_ws_parsers() -> None:
    q = parse_ws_ticker(
        {
            "s": "BTCUSDT",
            "c": "100.5",
            "p": "1.5",
            "P": "1.5",
            "o": "99",
            "h": "101",
            "l": "98",
            "v": "10",
            "b": "100.4",
            "B": "2",
            "a": "100.6",
            "A": "3",
            "E": 1700000000000,
            "x": "99",
        }
    )
    assert q.price == 100.5 and q.bid == 100.4 and q.ts is not None
    b = parse_ws_kline({"t": 1700000000000, "o": "1", "h": "2", "l": "0.5", "c": "1.5", "v": "9"})
    assert (b.t, b.h, b.v) == (1700000000, 2.0, 9.0)
