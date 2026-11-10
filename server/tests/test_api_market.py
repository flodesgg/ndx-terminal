from __future__ import annotations

from fastapi.testclient import TestClient

from ndx_server.config import Settings

from .conftest import make_client
from .fakes import FakeCrypto, FakeEquity


def test_quote_envelope_has_provenance(settings: Settings) -> None:
    with make_client(settings, [FakeEquity(), FakeCrypto()]) as c:
        r = c.get("/quote/aapl").json()
        assert r["data"]["price"] == 200.0
        assert r["meta"]["source"] == "Fake Equities"
        assert r["meta"]["latency"] == "DELAYED" and r["meta"]["delay_minutes"] == 15
        assert r["meta"]["as_of"].startswith("2026-11-06")


def test_unknown_symbol_is_404_with_error_body(settings: Settings) -> None:
    with make_client(settings, [FakeEquity()]) as c:
        r = c.get("/quote/ZZZZ")
        assert r.status_code == 404
        assert r.json()["code"] == "not_found" and r.json()["attempts"] == ["fakeeq"]
        assert c.get("/quote/$$$").status_code == 400


def test_missing_provider_is_503(settings: Settings) -> None:
    with make_client(settings, [FakeEquity()]) as c:
        r = c.get("/quote/BTCUSDT")
        assert r.status_code == 503 and r.json()["code"] == "no_provider"


def test_batch_quotes_mixed_assets(settings: Settings) -> None:
    eq = FakeEquity()
    with make_client(settings, [eq, FakeCrypto()]) as c:
        r = c.get("/quotes", params={"symbols": "AAPL,BTCUSDT,MSFT,NOPE,EURUSD,$$"}).json()
        items = {i["symbol"]: i for i in r["items"]}
        assert list(items) == ["AAPL", "BTCUSDT", "MSFT", "NOPE", "EURUSD", "$$"]
        assert items["BTCUSDT"]["meta"]["latency"] == "REALTIME"
        assert items["AAPL"]["meta"]["latency"] == "DELAYED"
        assert items["NOPE"]["error"] and items["NOPE"]["data"] is None
        assert items["$$"]["error"]
        assert eq.batch_calls == 2  # one batch per asset class (equity, fx)
        # Second call is served from cache and marked as such.
        r2 = c.get("/quotes", params={"symbols": "AAPL"}).json()
        assert r2["items"][0]["meta"]["cached"] is True


def test_bars_and_search(settings: Settings) -> None:
    with make_client(settings, [FakeEquity()]) as c:
        r = c.get("/bars/AAPL", params={"interval": "1d"}).json()
        assert r["tz"] == "America/New_York" and len(r["data"]) == 60
        assert c.get("/bars/AAPL", params={"interval": "2h"}).status_code == 422
        # Persisted in DuckDB: a second request is served from the bar store.
        r2 = c.get("/bars/AAPL", params={"interval": "1d"}).json()
        assert r2["meta"]["cached"] is True and r2["meta"]["source"] == "Fake Equities"
        s = c.get("/search", params={"q": "app"}).json()
        assert s["data"][0]["symbol"] == "AAPL"


def test_watchlists_crud(client: TestClient) -> None:
    lists = client.get("/watchlists").json()
    assert [w["name"] for w in lists] == ["US CORE", "DENMARK C25", "CRYPTO", "FX"]
    new = client.post("/watchlists", json={"name": "tech"}).json()
    assert new["name"] == "TECH" and new["symbols"] == []
    assert client.post("/watchlists", json={"name": "TECH"}).status_code == 409
    upd = client.put(
        f"/watchlists/{new['id']}/items",
        json={"symbols": ["aapl", "AAPL US Equity", "eurusd", "BTCUSDT", "ENI.MI"]},
    ).json()
    # Stored as canonical IDs (SPEC §5); unmappable but valid symbols stay as typed.
    assert upd["symbols"] == ["AAPL US EQUITY", "EURUSD CURNCY", "BTCUSD CURNCY", "ENI.MI"]
    assert client.put(f"/watchlists/{new['id']}/items", json={"symbols": ["$$"]}).status_code == 400
    assert client.delete(f"/watchlists/{new['id']}").status_code == 204


def test_news_merges_and_dedupes(settings: Settings) -> None:
    from datetime import UTC, datetime
    from typing import ClassVar

    from ndx_server.models import AssetClass, Instrument, NewsItem
    from ndx_server.providers.base import Capability, DataProvider
    from ndx_server.providers.ratelimit import TokenBucket

    def item(url: str, title: str, hour: int, prov: str) -> NewsItem:
        return NewsItem(
            id=url,
            headline=title,
            url=url,
            source="Pub",
            provider=prov,
            published=datetime(2026, 11, 6, hour, tzinfo=UTC),
        )

    class NewsA(DataProvider):
        name = "newsa"
        label = "News A"
        capabilities: ClassVar = {Capability.NEWS: frozenset(AssetClass)}

        def __init__(self) -> None:
            super().__init__(TokenBucket(100, 100))

        async def news(self, inst: Instrument | None, limit: int) -> list[NewsItem]:
            return [item("u1", "Same story", 10, "A"), item("u2", "Other", 12, "A")]

    class NewsB(NewsA):
        name = "newsb"
        label = "News B"

        async def news(self, inst: Instrument | None, limit: int) -> list[NewsItem]:
            return [item("u3", "same  STORY", 11, "B"), item("u4", "Third", 9, "B")]

    with make_client(settings, [NewsA(), NewsB()]) as c:
        r = c.get("/news").json()
        assert [n["url"] for n in r["data"]] == ["u2", "u1", "u4"]  # newest first, deduped
        assert r["meta"]["source"] == "News A + News B" and r["errors"] == []
        assert r["meta"]["personal_use"] is False

    # Review 1a #7: an opt-in personal-use source marks the merged list; the CACHE time is
    # when the sources were fetched, not when the cached list was requested again.
    class NewsP(NewsB):
        name = "newsp"
        label = "News P"
        personal_use = True

    with make_client(settings, [NewsA(), NewsP()]) as c:
        first = c.get("/news").json()["meta"]
        again = c.get("/news").json()["meta"]
    assert first["personal_use"] is True
    assert again["cached"] is True and again["fetched_at"] == first["fetched_at"]


def test_crypto_markets_requires_provider(settings: Settings) -> None:
    with make_client(settings, [FakeEquity()]) as c:
        assert c.get("/crypto/markets").status_code == 503
