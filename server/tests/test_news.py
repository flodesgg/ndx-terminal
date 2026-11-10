"""TOP / N / CN news (SPEC §8): clusters, tags, ranking, user feeds, keyword alerts, GDELT."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

import httpx
import pytest
import respx

from ndx_server.config import Settings
from ndx_server.demo import NOW, DemoProvider
from ndx_server.models import NewsAlertRule, NewsAlerts, NewsFeeds, NewsItem
from ndx_server.news import (
    SIMILARITY,
    cluster,
    keyword_pattern,
    norm_title,
    rank,
    rank_score,
    similarity,
    tag,
    valid_feed,
)
from ndx_server.providers.finnhub import FinnhubProvider
from ndx_server.providers.gdelt import GdeltProvider, company_query, parse_articles
from ndx_server.providers.http import DEFAULT_UA
from ndx_server.providers.rss import RssProvider
from ndx_server.symbols import classify

from .conftest import make_client
from .helpers import fixture

T0 = datetime(2026, 11, 9, 12, 0, tzinfo=UTC)


def item(i: int, title: str, minutes: int, provider: str = "Finnhub", **kw: Any) -> NewsItem:
    return NewsItem(
        id=f"n{i}",
        headline=title,
        url=f"https://example.com/{i}",
        source=f"Pub {i}",
        provider=provider,
        published=T0 + timedelta(minutes=minutes),
        **kw,
    )


# ---------------------------------------------------------------- clusters


def test_norm_title_drops_publisher_suffix_and_punctuation() -> None:
    assert norm_title("Fed holds rates — Example Wire") == "fed holds rates"
    assert norm_title("Fed holds  rates!! | Sample Daily") == "fed holds rates"
    assert norm_title("S&amp;P 500 rises") == "s p 500 rises"


def test_near_duplicates_within_two_hours_collapse_into_the_earliest() -> None:
    a = item(1, "Novo Nordisk raises full-year sales outlook on strong obesity drug demand", 0)
    b = item(
        2, "Novo Nordisk raises full-year sales outlook on strong demand for obesity drugs", 30
    )
    c = item(3, "Novo Nordisk raises full-year sales outlook on strong obesity drug demand", 121)
    d = item(4, "Maersk shares slip as freight rates ease", 10)
    assert similarity(norm_title(a.headline), norm_title(b.headline)) >= SIMILARITY
    out = cluster([b, c, d, a])
    by_id = {n.id: n for n in out}
    assert [n.id for n in out] == ["n3", "n4", "n1"]  # newest first
    assert [s.id for s in by_id["n1"].similar] == ["n2"]  # the earliest is kept
    assert by_id["n3"].similar == []  # 121 min after n1: outside the 2 h window
    assert by_id["n4"].similar == []


def test_cluster_drops_exact_url_repeats_and_merges_tickers_and_summary() -> None:
    a = item(1, "Apple supplier shares climb", 0, tickers=["AAPL"])
    b = item(2, "Apple supplier shares climb", 5, tickers=["TSM"], summary="Text")
    dup = item(1, "Anything", 7)  # same URL as a
    (head,) = cluster([a, b, dup])
    assert head.id == "n1" and head.tickers == ["AAPL", "TSM"] and head.summary == "Text"


def test_different_stories_stay_apart() -> None:
    a = item(1, "ECB holds rates steady, signals patience", 0)
    c = item(2, "Oil prices rise as OPEC+ signals output discipline", 2)
    assert similarity(norm_title(a.headline), norm_title(c.headline)) < SIMILARITY
    assert {n.id for n in cluster([a, c])} == {"n1", "n2"}


# ---------------------------------------------------------------- tags


def test_tags_from_tickers_and_keywords() -> None:
    n = tag(item(1, "Novo Nordisk raises outlook", 0, tickers=["NOVO-B.CO"]))
    assert n.tickers == ["NOVOB DC EQUITY"]
    assert n.regions == ["DK", "EU"] and n.asset_classes == ["EQUITY"] and "EARNINGS" in n.topics
    fed = tag(item(2, "Fed officials see room for one more rate cut", 0))
    assert fed.regions == ["US"] and "RATES" in fed.asset_classes and "CENTRAL BANKS" in fed.topics
    # acronyms only in capitals: "us" / "eu" in a sentence tag nothing
    plain = tag(item(3, "Analysts tell us the outlook is unclear", 0))
    assert plain.regions == []
    btc = tag(item(4, "Bitcoin steadies", 0))
    assert btc.asset_classes == ["CRYPTO"]


def test_finnhub_categories_tag_asset_class_and_topic() -> None:
    from ndx_server.providers.finnhub import parse_news

    rows = fixture("finnhub_general_news.json")
    fx = parse_news(rows, category="forex")
    mg = parse_news(rows, category="merger")
    assert fx and all(n.asset_classes == ["FX"] for n in fx)
    assert mg and all(n.topics == ["M&A"] for n in mg)


# ---------------------------------------------------------------- ranking


def test_rank_formula() -> None:
    now = T0 + timedelta(hours=6)
    base = item(1, "A", 0)  # 6 h old: half weight
    assert rank_score(base, now) == pytest.approx(1.0 * 0.5)
    watched = item(2, "B", 0, tickers=["AAPL US EQUITY"])
    watched.watch = True
    assert rank_score(watched, now) == pytest.approx(0.5 * 1.5)
    gd = item(3, "C", 0, provider="GDELT")
    assert rank_score(gd, now) == pytest.approx(0.6 * 0.5)
    big = cluster([item(4, "Same story here", 0), item(5, "Same story here!", 10)])[0]
    assert rank_score(big, now) == pytest.approx(0.5 * 1.5)  # 1 + 0.5*log2(2)


def test_rank_orders_by_score_with_watchlist_boost() -> None:
    now = T0 + timedelta(hours=1)
    a = item(1, "Older but on my list", 0, tickers=["AAPL US EQUITY"])
    b = item(2, "Newer, not on my list", 20)
    out = rank([a, b], now, {"AAPL US EQUITY"})
    assert [n.id for n in out] == ["n1", "n2"] and out[0].watch and not out[1].watch


# ---------------------------------------------------------------- service + API (DEMO)


@pytest.fixture
def demo_settings(settings: Settings) -> Settings:
    return settings.model_copy(update={"demo": True})


def test_api_top_news_in_demo(demo_settings: Settings) -> None:
    with make_client(demo_settings, [DemoProvider()]) as c:
        r = c.get("/news").json()
        assert r["sort"] == "rank" and r["now"].startswith("2026-11-09T14:30")
        assert r["meta"]["demo"] is True
        heads = [n["headline"] for n in r["data"]]
        assert len(heads) == len(set(heads))
        novo = next(n for n in r["data"] if n["tickers"] == ["NOVOB DC EQUITY"])
        assert len(novo["similar"]) == 1 and novo["watch"] is True  # DENMARK C25 seed list
        scores = [n["score"] for n in r["data"]]
        assert scores == sorted(scores, reverse=True)
        cn = c.get("/news", params={"symbol": "NOVOB DC EQUITY"}).json()
        assert cn["sort"] == "time" and all("NOVOB DC EQUITY" in n["tickers"] for n in cn["data"])
        assert c.get("/news", params={"sort": "time"}).json()["sort"] == "time"


def test_feeds_are_validated_and_reach_rss(settings: Settings) -> None:
    rss = RssProvider([])
    with make_client(settings, [rss]) as c:
        assert c.get("/news/feeds").json() == {"feeds": []}
        assert not rss.enabled and rss.disabled_reason == "no RSS feeds added (PDF NEWS)"
        r = c.put(
            "/news/feeds",
            json={
                "feeds": ["https://ok.example/rss", "javascript:alert(1)", "https://ok.example/rss"]
            },
        ).json()
        assert r == {"feeds": ["https://ok.example/rss"]}
        assert rss.feeds == ["https://ok.example/rss"] and rss.enabled
    assert valid_feed("http://x.example/f") and not valid_feed("ftp://x.example/f")


def test_rss_sends_an_honest_user_agent() -> None:
    rp = RssProvider(["https://ok.example/feed"])
    assert rp.client.headers["User-Agent"] == DEFAULT_UA
    assert "Mozilla" not in DEFAULT_UA


async def test_keyword_alerts_fire_once_per_new_headline(demo_settings: Settings) -> None:
    from ndx_server.news import NewsService

    with make_client(demo_settings, [DemoProvider()]) as c:
        svc: NewsService = c.app.state.ndx.services["news"]  # type: ignore[attr-defined]
        sent: list[str] = []
        svc.hub = type("Hub", (), {"broadcast_raw": lambda self, m: sent.append(m)})()
        saved = svc.set_alerts(NewsAlerts(rules=[NewsAlertRule(keyword="novo nordisk")]))
        assert saved.rules[0].created_at == NOW
        # Rules start at "now": move the watermark back 10 minutes so two fixtures are new.
        saved.rules[0].since = NOW - timedelta(minutes=10)
        svc.db.set_setting("news-alerts", saved.model_dump(mode="json"))
        fired = await svc.check_alerts()
        assert [f.keyword for f in fired] == ["novo nordisk"]  # one cluster, one alert
        assert fired[0].item.headline.startswith("Novo Nordisk raises")
        assert len(sent) == 1 and '"type":"news_alert"' in sent[0]
        assert await svc.check_alerts() == []  # the watermark moved: nothing fires twice
        assert svc.alerts().rules[0].fired == 1
        # PUT keeps an existing rule (its watermark), drops duplicates and blanks
        r = c.put(
            "/news/alerts",
            json={
                "rules": [
                    {"keyword": "Novo  Nordisk"},
                    {"keyword": "novo nordisk"},
                    {"keyword": "ECB"},
                ]
            },
        ).json()
        assert [x["keyword"] for x in r["rules"]] == ["novo nordisk", "ECB"]  # existing kept


def test_keyword_pattern_is_whole_word() -> None:
    rx = keyword_pattern("ECB")
    assert rx.search("The ECB holds") and not rx.search("TECBANK results")


# ---------------------------------------------------------------- GDELT


def test_gdelt_parse_and_query() -> None:
    items = parse_articles(fixture("gdelt_artlist_synthetic.json"), 10)
    assert [n.source for n in items] == ["example.com", "example.org"]  # undated row skipped
    assert items[1].headline == "Second synthetic headline"
    assert items[0].published == datetime(2026, 11, 9, 14, 15, tzinfo=UTC)
    assert items[0].summary is None and items[0].summary_note
    assert company_query("Novo Nordisk B") == '"Novo Nordisk" sourcelang:english'


@respx.mock
async def test_gdelt_serves_non_us_company_news_only() -> None:
    route = respx.get("https://api.gdeltproject.org/api/v2/doc/doc").mock(
        return_value=httpx.Response(200, json=fixture("gdelt_artlist_synthetic.json"))
    )
    g = GdeltProvider()
    from ndx_server.providers.base import Capability, NotSupported

    assert not g.serves(Capability.NEWS, None)
    assert not g.serves(Capability.NEWS, classify("AAPL"))
    novo = classify("NOVOB DC EQUITY")
    assert g.serves(Capability.NEWS, novo)
    items = await g.news(novo, 5)
    assert len(items) == 2
    assert route.calls[0].request.url.params["query"] == '"Novo Nordisk" sourcelang:english'
    with pytest.raises(NotSupported):
        await g.news(None, 5)
    await g.aclose()


@respx.mock
async def test_gdelt_429_is_rate_limited() -> None:
    from ndx_server.providers.base import RateLimited

    respx.get("https://api.gdeltproject.org/api/v2/doc/doc").mock(
        return_value=httpx.Response(429, text="Please limit requests to one every 5 seconds")
    )
    g = GdeltProvider()
    with pytest.raises(RateLimited):
        await g.news(classify("NOVOB DC EQUITY"), 5)
    await g.aclose()


# ---------------------------------------------------------------- Finnhub market news


async def test_finnhub_market_news_reads_every_category() -> None:
    cats: list[str] = []

    def handler(req: httpx.Request) -> httpx.Response:
        cats.append(req.url.params["category"])
        return httpx.Response(200, json=fixture("finnhub_general_news.json"))

    fh = FinnhubProvider("k", client=httpx.AsyncClient(transport=httpx.MockTransport(handler)))
    items = await fh.news(None, 10)
    assert cats == ["general", "forex", "crypto", "merger"]
    assert items == sorted(items, key=lambda n: n.published, reverse=True)
    assert fh.rate.quota().used == 3  # the router takes the first token
    await fh.aclose()


def test_news_feeds_model_caps_the_list() -> None:
    with pytest.raises(ValueError):
        NewsFeeds(feeds=[f"https://x{i}.example/f" for i in range(13)])
