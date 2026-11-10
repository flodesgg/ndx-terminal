"""Security master and symbology tables (SPEC §5)."""

from __future__ import annotations

import json
import re
from datetime import date
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from ndx_server.config import Settings
from ndx_server.live import Client
from ndx_server.secmaster import TABLES, Symbology, SymbologyError, symbology_dir
from ndx_server.symbols import SymbolError, classify, echo_key

from .conftest import make_client
from .fakes import FakeEquity


@pytest.fixture
def sm() -> Symbology:
    return Symbology.load()


def test_every_table_has_a_recent_last_reviewed_date(sm: Symbology) -> None:
    for name in TABLES:
        reviewed = sm.reviewed[name]
        assert reviewed is not None, f"{name}.csv has no last_reviewed line"
        assert reviewed <= date.today()
        assert (date.today() - reviewed).days < 400, f"{name}.csv review is over a year old"


def test_tables_are_well_formed(sm: Symbology) -> None:
    for code, ex in sm.exchanges.items():
        assert re.fullmatch(r"[A-Z]{2}", code)
        assert ex.mic == "" or re.fullmatch(r"X[A-Z]{3}", ex.mic), code
        assert re.fullmatch(r"[A-Z]{3}", ex.currency) and "/" in ex.tz
    suffixes = [e.yahoo_suffix for e in sm.exchanges.values() if e.yahoo_suffix]
    assert len(suffixes) == len(set(suffixes)), "a provider suffix maps to two exchanges"
    for k, r in sm.futures.items():
        assert re.fullmatch(r"[A-Z]{2}1", k) and r["yahoo"].endswith("=F")
        assert float(r["tick_size"]) > 0 and r["sector"] in ("COMDTY", "INDEX")
    for k, r in sm.indices.items():
        # Yahoo index symbols are `^XXX`, except a few listed with an exchange suffix
        # (FTSEMIB.MI, 000001.SS); every row must round-trip to its own INDEX ID.
        assert r["yahoo"].startswith("^") or "." in r["yahoo"], k
        assert sm.canonical(r["yahoo"]) == f"{k} INDEX", k
        assert sm.internal(f"{k} INDEX") == r["yahoo"], k
        assert "/" in r["tz"], k
    for code, r in sm.currencies.items():
        assert re.fullmatch(r"[A-Z]{3}", code) and r["reference"] in ("ECB", "NBU", "")
    assert sm.currencies["UAH"]["reference"] == "NBU"  # ECB has no UAH (PROVIDERS P6)
    for r in sm.rates.values():
        assert r["source"] == "treasury", "US yields come from Treasury, not FRED"
    # Canonical IDs are unique across tables that share a namespace.
    assert not set(sm.indices) & {k for k, r in sm.futures.items() if r["sector"] == "INDEX"}


# The §5 starting set, both directions.
SPEC_ROWS = [
    ("AAPL", "AAPL US EQUITY"),
    ("NOVO-B.CO", "NOVOB DC EQUITY"),
    ("VOLV-B.ST", "VOLVB SS EQUITY"),
    ("EQNR.OL", "EQNR NO EQUITY"),
    ("NOKIA.HE", "NOKIA FH EQUITY"),
    ("SAP.DE", "SAP GY EQUITY"),
    ("AZN.L", "AZN LN EQUITY"),
    ("MC.PA", "MC FP EQUITY"),
    ("ASML.AS", "ASML NA EQUITY"),
    ("NESN.SW", "NESN SW EQUITY"),
    ("7203.T", "7203 JT EQUITY"),
    ("0700.HK", "0700 HK EQUITY"),
    ("BRK-B", "BRK/B US EQUITY"),
    ("^GSPC", "SPX INDEX"),
    ("^NDX", "NDX INDEX"),
    ("^DJI", "INDU INDEX"),
    ("^RUT", "RTY INDEX"),
    ("^STOXX50E", "SX5E INDEX"),
    ("^GDAXI", "DAX INDEX"),
    ("^FTSE", "UKX INDEX"),
    ("^FCHI", "CAC INDEX"),
    ("^OMXC25", "OMXC25 INDEX"),
    ("^N225", "NKY INDEX"),
    ("^HSI", "HSI INDEX"),
    ("CL=F", "CL1 COMDTY"),
    ("BZ=F", "CO1 COMDTY"),
    ("NG=F", "NG1 COMDTY"),
    ("GC=F", "GC1 COMDTY"),
    ("SI=F", "SI1 COMDTY"),
    ("HG=F", "HG1 COMDTY"),
    ("ES=F", "ES1 INDEX"),
    ("NQ=F", "NQ1 INDEX"),
    ("YM=F", "YM1 INDEX"),
    ("EURUSD", "EURUSD CURNCY"),
    ("USDJPY", "USDJPY CURNCY"),
    ("BTCUSDT", "BTCUSD CURNCY"),
    ("ETHUSDT", "ETHUSD CURNCY"),
]


@pytest.mark.parametrize(("internal", "cid"), SPEC_ROWS)
def test_spec_starting_set_round_trips(sm: Symbology, internal: str, cid: str) -> None:
    assert sm.canonical(internal) == cid
    assert sm.internal(cid) == internal
    assert sm.canonical(cid) == cid  # idempotent


def test_parsing_is_forgiving_but_strict(sm: Symbology) -> None:
    assert sm.canonical("aapl us equity") == "AAPL US EQUITY"
    assert sm.canonical("AAPL US Equity") == "AAPL US EQUITY"
    assert sm.canonical("AAPL US") == "AAPL US EQUITY"  # equity is the default sector
    assert sm.canonical("  SPX   Index ") == "SPX INDEX"
    assert not sm.is_canonical("AAPL ZZ EQUITY")  # unknown exchange code
    assert not sm.is_canonical("AAPL")
    assert not sm.is_canonical("AAPL US EQUITY X")


def test_generic_rules_and_unmappable(sm: Symbology) -> None:
    assert sm.canonical("^OMXH25") == "OMXH25 INDEX"
    assert sm.internal("OMXH25 INDEX") == "^OMXH25"
    assert sm.canonical("SOLUSDT") == "SOLUSD CURNCY"
    assert sm.canonical("ETHUSDC") == "ETHUSDC CURNCY"
    assert sm.internal("ETHUSDC CURNCY") == "ETHUSDC"
    assert sm.canonical("ENI.MI") is None  # Borsa Italiana not in exchanges.csv
    assert sm.canonical("XX=F") is None  # unlisted future: no front-month code
    assert sm.canonical("$$") is None
    with pytest.raises(SymbologyError):
        sm.internal("ZZ1 COMDTY")
    with pytest.raises(SymbologyError):
        sm.internal("ABCDEF CURNCY")


def test_learned_share_class_round_trips(sm: Symbology) -> None:
    assert sm.internal("XYZB SS EQUITY") == "XYZB.ST"  # rule alone cannot restore the hyphen
    assert sm.learn("XYZ-B.ST") == {"XYZB SS": "XYZ-B.ST"}
    assert sm.internal("XYZB SS EQUITY") == "XYZ-B.ST"
    assert sm.learn("XYZ-B.ST") == {}  # already round-trips
    assert sm.learn("AAPL") == {}
    assert sm.learn("AAPL US EQUITY") == {}  # canonical input never teaches a mapping
    sm.add_learned({"BAD X": "BAD X EQUITY"})
    assert "BAD X" not in sm.learned


def test_security_record_and_provider_map(sm: Symbology) -> None:
    novo = sm.security("NOVO-B.CO")
    assert novo.id == "NOVOB DC EQUITY" and novo.mic == "XCSE" and novo.currency == "DKK"
    assert novo.tz == "Europe/Copenhagen" and novo.name == "Novo Nordisk B"
    assert novo.providers == {"yahoo": "NOVO-B.CO", "eodhd": "NOVO-B.CO"}
    aapl = sm.security("AAPL US EQUITY")
    assert aapl.providers["finnhub"] == "AAPL" and aapl.providers["eodhd"] == "AAPL.US"
    assert aapl.mic is None  # US composite: no single MIC, never invented
    cl = sm.security("CL1 COMDTY")
    assert cl.tick_size == 0.01 and cl.providers == {"yahoo": "CL=F"}
    eur = sm.security("EURUSD CURNCY")
    assert eur.providers == {"yahoo": "EURUSD=X", "ecb": "EXR/D.USD.EUR.SP00.A"}
    uah = sm.security("EURUAH CURNCY")
    assert uah.providers.get("nbu") == "UAH" and "ecb" not in uah.providers
    btc = sm.security("BTCUSD CURNCY")
    assert btc.providers == {"binance": "BTCUSDT"} and btc.note == "quoted in USDT, not USD"
    us10 = sm.security("US10Y GOVT")
    assert us10.providers == {"treasury": "US10Y"}


def test_classify_accepts_both_forms() -> None:
    a = classify("AAPL US Equity")
    assert a.symbol == "AAPL" and a.id == "AAPL US EQUITY"
    assert classify("AAPL").id == "AAPL US EQUITY"
    assert classify("NOVOB DC EQUITY").symbol == "NOVO-B.CO"
    assert classify("BTCUSD CURNCY").symbol == "BTCUSDT"
    assert classify("ENI.MI").id is None
    with pytest.raises(SymbolError, match="yield series"):
        classify("US10Y GOVT")
    assert echo_key("aapl us equity", a) == "AAPL US EQUITY"
    assert echo_key("aapl", a) == "AAPL"


def test_symbology_dir_points_at_repo_data() -> None:
    assert (symbology_dir() / "exchanges.csv").exists()


def test_batch_quotes_and_live_answer_in_callers_style(settings: Settings) -> None:
    with make_client(settings, [FakeEquity()]) as c:
        items = c.get("/quotes", params={"symbols": "AAPL US EQUITY,AAPL,MSFT"}).json()["items"]
        assert [i["symbol"] for i in items] == ["AAPL US EQUITY", "AAPL", "MSFT"]
        assert all(i["data"]["price"] for i in items)
        protos = ["ndx.v1", f"ndx-token.{settings.token}"]
        with c.websocket_connect("ws://127.0.0.1/ws", subprotocols=protos) as ws:
            ws.send_text(json.dumps({"op": "sub", "topics": ["quote:AAPL US Equity"]}))
            q = json.loads(ws.receive_text())
            assert q["type"] == "quote" and q["symbol"] == "AAPL US EQUITY"


def test_client_delivers_once_per_spelling() -> None:
    class WS:
        pass

    c = Client(WS())  # type: ignore[arg-type]
    c.aliases["quote:AAPL"] = {"AAPL", "AAPL US EQUITY"}
    c.deliver("quote:AAPL", json.dumps({"type": "quote", "symbol": "AAPL"}))
    got = sorted(json.loads(c.queue.get_nowait())["symbol"] for _ in range(2))
    assert got == ["AAPL", "AAPL US EQUITY"]


# ---------- local security index (SPEC §4.3 rule 6, §4.7) ----------

NASDAQ_LISTED = (
    "Symbol|Security Name|Market Category|Test Issue|Financial Status|Round Lot Size|ETF"
    "|NextShares\n"
    "AAPL|Apple Inc. - Common Stock|Q|N|N|100|N|N\n"
    "QQQ|Invesco QQQ Trust, Series 1|G|N|N|100|Y|N\n"
    "ZXZZT|NASDAQ TEST STOCK|G|Y|N|100|N|N\n"
    "File Creation Time: 1109202612:00|||||||\n"
)
OTHER_LISTED = (
    "ACT Symbol|Security Name|Exchange|CQS Symbol|ETF|Round Lot Size|Test Issue|NASDAQ Symbol\n"
    "BRK.B|Berkshire Hathaway Inc. Class B|N|BRK.B|N|100|N|BRK.B\n"
    "ABR$D|Arbor Realty Trust Pfd D|N|ABRpD|N|100|N|ABR-D\n"
    "File Creation Time: 1109202612:00|||||||\n"
)


def test_index_from_tables_and_seeds(sm: Symbology, tmp_path: Path) -> None:
    from ndx_server.secindex import build_index

    seeds = tmp_path / "seeds"
    seeds.mkdir()
    no_seeds = build_index(sm, seeds)
    assert no_seeds.complete == ["COMDTY", "GOVT"]  # US unknown until the lists are downloaded
    (seeds / "nasdaqlisted.txt").write_text(NASDAQ_LISTED)
    (seeds / "otherlisted.txt").write_text(OTHER_LISTED)
    (seeds / "binance_exchange_info.json").write_text(
        json.dumps(
            {
                "symbols": [
                    {"baseAsset": "SOL", "quoteAsset": "USDT", "status": "TRADING"},
                    {"baseAsset": "OLD", "quoteAsset": "USDT", "status": "BREAK"},
                ]
            }
        )
    )
    idx = build_index(sm, seeds)
    rows = {r[0]: r for r in idx.items}
    assert idx.complete == ["COMDTY", "CRYPTO", "GOVT", "US"]
    assert rows["AAPL US EQUITY"][1] == "Apple Inc. - Common Stock"
    assert rows["BRK/B US EQUITY"][2:] == ["BRK-B", "BRK.B"]  # Yahoo and Nasdaq/Finnhub forms
    assert "ZXZZT US EQUITY" not in rows and not any("ABR" in k for k in rows)
    assert rows["SOLUSD CURNCY"][2:] == ["SOLUSDT"] and "OLDUSD CURNCY" not in rows
    assert rows["NOVOB DC EQUITY"][2:] == ["NOVO-B.CO"]
    assert rows["SPX INDEX"][2:] == ["^GSPC"] and rows["CL1 COMDTY"][2:] == ["CL=F"]
    assert "US10Y GOVT" in rows and "DKK" in idx.fiat and "DC" in idx.exchanges


def test_batch_lookup_names_a_us_stock_from_the_listings_seed(settings: Settings) -> None:
    # Finnhub's /quote has no name and the tables list no US stocks: the index (seeds) does.
    seeds = settings.data_dir / "seeds"
    seeds.mkdir(parents=True)
    (seeds / "nasdaqlisted.txt").write_text(NASDAQ_LISTED)
    (seeds / "otherlisted.txt").write_text(OTHER_LISTED)
    with make_client(settings) as c:
        r = c.get("/secmaster/securities", params={"symbols": "AAPL US EQUITY,NOVOB DC EQUITY"})
        rec = {i["symbol"]: i["record"] for i in r.json()}
    assert rec["AAPL US EQUITY"]["name"] == "Apple Inc. - Common Stock"
    assert rec["NOVOB DC EQUITY"]["name"]  # from the tables, unchanged
    with make_client(settings) as c:  # a C25 line outside equities.csv: the curated list names it
        r = c.get("/secmaster/securities", params={"symbols": "DANSKE DC EQUITY"})
    assert r.json()[0]["record"]["name"] == "Danske Bank"


def test_index_endpoint_in_demo_is_the_fixture_world(settings: Settings) -> None:
    from fastapi.testclient import TestClient

    from ndx_server.main import create_app

    settings.demo = True
    app = create_app(settings, start_background=False)
    with TestClient(app, base_url="http://127.0.0.1", headers={"x-ndx-token": settings.token}) as c:
        idx = c.get("/secmaster/index").json()
    rows = {r[0]: r for r in idx["items"]}
    assert "US" in idx["complete"] and idx["sources"][-1] == "DEMO fixtures"
    assert rows["NOVOB DC EQUITY"][1] == "Novo Nordisk B (DEMO)"
    assert rows["BTCUSD CURNCY"][1:] == ["Bitcoin (DEMO, quoted in USDT)", "BTCUSDT"]


def test_nasdaq_share_class_form_is_one_way_to_canonical(sm: Symbology) -> None:
    assert sm.canonical("BRK.B") == "BRK/B US EQUITY"  # Nasdaq/Finnhub form in
    assert sm.internal("BRK/B US EQUITY") == "BRK-B"  # internal stays the Yahoo-form symbol
    assert sm.canonical("ENI.MI") is None  # an unlisted exchange is not a share class


def test_crypto_never_becomes_a_us_stock(sm: Symbology) -> None:
    # Review 1a #46: BTC-USD became `BTC/USD US EQUITY`, BTCUSD `BTCUSD US EQUITY`.
    for raw in ("BTC-USD", "BTCUSD", "BTCUSDT"):
        assert sm.canonical(raw) == "BTCUSD CURNCY", raw
    assert sm.canonical("DOGE-USD") == "DOGEUSD CURNCY"
    assert sm.canonical("BRK-B") == "BRK/B US EQUITY"  # a class letter is not a quote currency


@pytest.mark.parametrize(
    ("raw", "cid", "internal"),
    [
        ("BTC-USDT", "BTCUSD CURNCY", "BTCUSDT"),
        ("ETH-USD", "ETHUSD CURNCY", "ETHUSDT"),
        ("DOGEUSD", "DOGEUSD CURNCY", "DOGEUSDT"),
        ("PEPEUSD", "PEPEUSD CURNCY", "PEPEUSDT"),
        ("SOL-USDC", "SOLUSDC CURNCY", "SOLUSDC"),
    ],
)
def test_crypto_pairs_in_usd_are_curncy_both_ways(
    sm: Symbology, raw: str, cid: str, internal: str
) -> None:
    # Re-verify #46: the class, not two examples. canonical() and internal() agree.
    from ndx_server.models import AssetClass
    from ndx_server.symbols import classify

    assert sm.canonical(raw) == cid
    assert sm.internal(cid) == internal
    assert sm.canonical(internal) == cid
    inst = classify(raw)
    assert (inst.symbol, inst.asset_class, inst.id) == (internal, AssetClass.CRYPTO, cid)
    sec = sm.security(raw)
    assert sec.exchange is None and sec.tz is None and "eodhd" not in sec.providers


@pytest.mark.parametrize(
    "raw", ["BTC-EUR", "ETH-GBP", "ETH-BTC", "BTCEUR", "SOLJPY", "DOGE-BUSD", "btc-eur"]
)
def test_crypto_in_other_quotes_stays_unresolved(sm: Symbology, raw: str) -> None:
    # No provider serves these as CURNCY: unresolved with a clear error, never `… US EQUITY`
    # with an invented exchange, zone or provider codes (re-verify #46).
    from ndx_server.symbols import SymbolError, classify

    assert sm.canonical(raw) is None
    with pytest.raises(SymbologyError):
        sm.security(raw)
    with pytest.raises(SymbolError, match="not supported"):
        classify(raw)


@pytest.mark.parametrize(
    ("raw", "cid"),
    [
        ("BRK-B", "BRK/B US EQUITY"),
        ("BF-B", "BF/B US EQUITY"),
        ("GOOGL", "GOOGL US EQUITY"),
        ("EURUSD", "EURUSD CURNCY"),
        ("USDJPY", "USDJPY CURNCY"),
        ("NOVO-B.CO", "NOVOB DC EQUITY"),
    ],
)
def test_crypto_rule_leaves_stocks_and_fx_alone(sm: Symbology, raw: str, cid: str) -> None:
    assert sm.canonical(raw) == cid


def test_ids_with_a_slash_reach_symbol_routes(client: TestClient) -> None:
    # Share classes are `BRK/B US EQUITY`; the client sends `/` as %2F, which Starlette decodes
    # before routing, so symbol routes must take the rest of the path.
    from urllib.parse import quote

    sym = quote("BRK/B US EQUITY", safe="")
    put = client.put(f"/notes/{sym}", json={"body": "class B"})
    assert put.status_code == 200, put.text
    got = client.get(f"/notes/{sym}").json()
    assert got["symbol"] == "BRK/B US EQUITY" and got["body"] == "class B"
    assert client.get(f"/secmaster/security/{sym}").status_code == 200


def test_demo_never_uses_the_real_data_folder(
    settings: Settings, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # `make dev DEMO=1` sets no NDX_DATA_DIR: the default (real) folder must be swapped for a
    # temporary one, so DEMO never reads or writes the user's user.db (SPEC §1.2).
    import ndx_server.main as main_mod

    real = tmp_path / "real-data"
    monkeypatch.setattr(main_mod, "default_data_dir", lambda: real)
    settings.demo = True
    settings.data_dir = real
    main_mod.create_app(settings, start_background=False)
    assert settings.data_dir != real and "ndx-demo-" in settings.data_dir.name
    assert not real.exists()


def test_learn_never_maps_case_or_us_share_classes(sm: Symbology) -> None:
    # Review 1a #1 / #15: `aapl` taught `AAPL US` <-> `aapl`; `MOG.A` taught `MOG/A US` <-> `MOG.A`.
    for raw in ("aapl", "msft", "BRK.A", "MOG.A", "HEI.A", "LEN.B", "brk-b"):
        assert sm.learn(raw) == {}, raw
    assert sm.internal("AAPL US EQUITY") == "AAPL"
    assert sm.internal("MOG/A US EQUITY") == "MOG-A"
    assert sm.security("MOG/A US EQUITY").providers["yahoo"] == "MOG-A"
    # Non-US share classes still learn, in upper case.
    assert sm.learn("xyz-b.st") == {"XYZB SS": "XYZ-B.ST"}
    assert sm.internal("XYZB SS EQUITY") == "XYZ-B.ST"
    # Invalid rows stored by older builds are not loaded.
    sm.add_learned({"AAPL US": "aapl", "MOG/A US": "MOG.A"})
    assert sm.internal("AAPL US EQUITY") == "AAPL" and sm.internal("MOG/A US EQUITY") == "MOG-A"


def test_startup_drops_invalid_learned_rows(settings: Settings) -> None:
    from ndx_server.db import Database
    from ndx_server.main import create_app

    settings.ensure_dirs()
    Database(settings.data_dir / "user.db").save_symbol_map(
        {"AAPL US": "aapl", "XYZB SS": "XYZ-B.ST"}
    )
    create_app(settings, start_background=False)
    assert Database(settings.data_dir / "user.db").symbol_map() == {"XYZB SS": "XYZ-B.ST"}


def test_suffixed_index_symbols_classify_as_indices(sm: Symbology) -> None:
    """WEI rows FTSEMIB.MI / 000001.SS are indices with a venue zone, not IT/CN equities
    (re-verify R5)."""
    from ndx_server.models import AssetClass
    from ndx_server.symbols import classify

    for raw, cid, tz in (
        ("FTSEMIB.MI", "FTSEMIB INDEX", "Europe/Rome"),
        ("000001.SS", "SHCOMP INDEX", "Asia/Shanghai"),
        ("^KS11", "KS11 INDEX", "Asia/Seoul"),
    ):
        inst = classify(raw)
        assert (inst.id, inst.asset_class) == (cid, AssetClass.INDEX)
        assert classify(cid).asset_class is AssetClass.INDEX
        assert sm.security(raw).tz == tz


@pytest.mark.parametrize(
    "raw", ["XAUUSD", "XAGUSD", "XAU-USD", "XPTUSD", "XPDEUR", "XAUUSD CURNCY"]
)
def test_spot_metals_are_not_crypto(sm: Symbology, raw: str) -> None:
    # Re-verify N4: XAUUSD became Binance crypto `XAUUSD CURNCY` -> XAUUSDT.
    from ndx_server.symbols import SymbolError, classify

    with pytest.raises(SymbolError, match="metals"):
        classify(raw)
    if " " not in raw:
        assert sm.canonical(raw) is None


@pytest.mark.parametrize("raw", ["ETHBTC", "BNBETH", "SOLBTC"])
def test_bare_coin_quoted_pairs_are_never_stocks(sm: Symbology, raw: str) -> None:
    # Re-verify N5: ETHBTC became `ETHBTC US EQUITY` with an invented exchange and zone.
    from ndx_server.symbols import SymbolError, classify

    assert sm.canonical(raw) is None
    with pytest.raises(SymbolError, match="not supported"):
        classify(raw)


async def test_a_second_spelling_of_a_held_topic_gets_a_snapshot() -> None:
    """FXC holds USDJPY, then WFX asks for USDJPY CURNCY: WFX must not wait for the next poll."""
    import asyncio

    from ndx_server.live import LiveHub
    from ndx_server.market import MarketService
    from ndx_server.providers.cache import TTLCache
    from ndx_server.providers.router import ProviderRouter

    class WS:
        pass

    hub = LiveHub(
        MarketService(ProviderRouter([FakeEquity()], cache=TTLCache(), retry_delays=())),
        stream_crypto=False,
    )
    c = Client(WS())  # type: ignore[arg-type]

    async def symbols_sent() -> list[str]:
        await asyncio.gather(*list(hub._tasks))
        out: list[str] = []
        while not c.queue.empty():
            out.append(json.loads(c.queue.get_nowait())["symbol"])
        return out

    await hub._subscribe(c, ["quote:AAPL"])
    assert await symbols_sent() == ["AAPL"]
    await hub._subscribe(c, ["quote:AAPL US EQUITY"])
    assert "AAPL US EQUITY" in await symbols_sent()
    await hub._subscribe(c, ["quote:AAPL"])  # a spelling already held: nothing new to send
    assert await symbols_sent() == []
