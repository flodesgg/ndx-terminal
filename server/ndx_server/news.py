"""News for TOP / N / CN (SPEC §8): near-duplicate clusters, tags for the filters, ranking,
user RSS feeds and keyword alerts.

The provider merge (Finnhub, RSS, GDELT, opt-in Yahoo) stays in `MarketService.news`; this
module turns that list into what the screens show. Everything here is deterministic: the same
items and the same clock give the same clusters, tags and order.

- Clusters: headlines whose normalized titles are >= 0.85 similar (difflib ratio) and published
  within 2 h of the cluster's earliest item collapse into that earliest item ("+N similar").
- Tags (regions, asset classes, topics) come from the item's tickers (canonical IDs → venue)
  and from the keyword rules below. They are a filter aid, not a claim of the source, and the
  HELP text says so.
- Rank = source weight x recency decay x watchlist match x cluster size (all in `rank`).
"""

from __future__ import annotations

import asyncio
import contextlib
import html
import logging
import math
import re
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from difflib import SequenceMatcher
from functools import lru_cache
from typing import TYPE_CHECKING, Literal
from urllib.parse import urlparse

from .models import (
    AssetClass,
    LiveNewsAlert,
    NewsAlertRule,
    NewsAlerts,
    NewsAsset,
    NewsFeeds,
    NewsItem,
    NewsRegion,
    NewsResponse,
    NewsSimilar,
    NewsTopic,
)

if TYPE_CHECKING:  # pragma: no cover
    from .db import Database
    from .live import LiveHub
    from .market import MarketService
    from .providers.rss import RssProvider

log = logging.getLogger("ndx.news")

SIMILARITY = 0.85
CLUSTER_WINDOW = timedelta(hours=2)
HALF_LIFE_H = 6.0  # recency: a headline loses half its weight every 6 hours
WATCH_BOOST = 1.5
# Per provider: user-picked feeds and Finnhub carry summaries; GDELT gives headlines only.
SOURCE_WEIGHT: dict[str, float] = {
    "RSS": 1.0,
    "Finnhub": 1.0,
    "Yahoo": 0.9,
    "GDELT": 0.6,
    "DEMO": 1.0,
}
FEEDS_KEY = "news-feeds"
ALERTS_KEY = "news-alerts"
MAX_FEEDS = 12

# ---------------------------------------------------------------- normalizing & clustering

# A trailing " - Publisher" / " | Publisher" (hyphen, en dash or em dash).
_SUFFIX = re.compile(r"\s+[-|\u2013\u2014]\s+[^-|\u2013\u2014]{2,40}$")
_NON_WORD = re.compile(r"[^\w]+", re.UNICODE)


def norm_title(title: str) -> str:
    t = html.unescape(title).strip()
    t = _SUFFIX.sub("", t)
    return " ".join(_NON_WORD.sub(" ", t.lower()).split())


def similarity(a: str, b: str) -> float:
    """difflib ratio of two normalized titles (0..1)."""
    if a == b:
        return 1.0
    m = SequenceMatcher(None, a, b, autojunk=False)
    if m.real_quick_ratio() < SIMILARITY or m.quick_ratio() < SIMILARITY:
        return m.quick_ratio()
    return m.ratio()


def cluster(items: Iterable[NewsItem]) -> list[NewsItem]:
    """Collapse near-duplicates: each cluster keeps its earliest item, the others become its
    `similar` list (oldest first). Exact URL repeats are dropped. Output: newest first."""
    by_time = sorted(items, key=lambda n: (n.published, n.id))
    heads: list[tuple[NewsItem, str]] = []
    seen_urls: set[str] = set()
    for n in by_time:
        if n.url in seen_urls:
            continue
        seen_urls.add(n.url)
        key = norm_title(n.headline)
        target = None
        # Newest heads first: a repeat most likely belongs to a recent story.
        for head, hkey in reversed(heads):
            if n.published - head.published > CLUSTER_WINDOW:
                break
            if similarity(key, hkey) >= SIMILARITY:
                target = head
                break
        if target is None:
            heads.append((n.model_copy(update={"similar": []}), key))
            continue
        target.similar.append(
            NewsSimilar(
                id=n.id,
                headline=n.headline,
                url=n.url,
                source=n.source,
                provider=n.provider,
                published=n.published,
            )
        )
        for t in n.tickers:
            if t not in target.tickers:
                target.tickers.append(t)
        if not target.summary and n.summary:
            target.summary, target.summary_note = n.summary, None
    out = [h for h, _ in heads]
    out.sort(key=lambda n: (n.published, n.id), reverse=True)
    return out


# ---------------------------------------------------------------- tags for the filters


def _words(words: str, acronyms: str = "") -> re.Pattern[str]:
    """Whole words, case-insensitive ("|"-separated regex parts), plus acronyms matched in
    capitals only, so "us" or "eu" inside a sentence never tag a region."""
    parts = [f"(?i:{words})"] + ([f"(?:{acronyms})"] if acronyms else [])
    return re.compile(r"(?<![\w&])(?:" + "|".join(parts) + r")(?![\w&])")


# fmt: off
REGION_WORDS: dict[NewsRegion, re.Pattern[str]] = {
    "US": _words(r"Federal Reserve|Wall Street|Nasdaq|Dow Jones|S&P 500|Treasur(?:y|ies)|"
                 r"American|Washington|United States",
                 r"US|U\.S\.|Fed|FOMC"),
    "EU": _words(r"euro ?zone|euro area|Europe|European|Germany|German|France|French|Italy|"
                 r"Italian|Spain|Spanish|Netherlands|Dutch|Sweden|Swedish|Norway|Norwegian|"
                 r"Finland|Finnish|Bank of England|Britain|British|DAX|FTSE|Stoxx",
                 r"ECB|EU|UK"),
    "DK": _words(r"Denmark|Danish|Copenhagen|Nationalbanken|C25"),
    "APAC": _words(r"China|Chinese|Japan|Japanese|Bank of Japan|Hong Kong|Korea|Korean|India|"
                   r"Indian|Australia|Australian|Asia|Asian|Nikkei|Hang Seng|Taiwan",
                   r"BOJ|PBOC"),
}
ASSET_WORDS: dict[NewsAsset, re.Pattern[str]] = {
    "FX": _words(r"dollar|yen|yuan|sterling|forex|currenc(?:y|ies)|exchange rates?", r"FX"),
    "RATES": _words(r"yields?|bonds?|Treasur(?:y|ies)|Bunds?|gilts?|rate (?:cut|hike)s?|"
                    r"interest rates?"),
    "COMMODITIES": _words(r"oil|crude|Brent|natural gas|gold|silver|copper|commodit(?:y|ies)|"
                          r"wheat|corn", r"WTI|OPEC\+?"),
    "CRYPTO": _words(r"bitcoin|ether(?:eum)?|crypto(?:currenc(?:y|ies))?|stablecoins?|solana|"
                     r"blockchain", r"BTC|ETH"),
    "EQUITY": _words(r"stocks?|shares|equit(?:y|ies)|earnings|S&P 500|Nasdaq|Dow Jones|DAX|"
                     r"FTSE|Nikkei|C25", r"IPO"),
}
TOPIC_WORDS: dict[NewsTopic, re.Pattern[str]] = {
    "EARNINGS": _words(r"earnings|quarterly results?|results|profit|revenue|guidance|outlook",
                       r"EPS|Q[1-4]"),
    "M&A": _words(r"mergers?|acquisitions?|acquires?|acquired|takeover|buyout|deal to buy|"
                  r"agrees to buy|bid for", r"M&A"),
    "CENTRAL BANKS": _words(r"Federal Reserve|Bank of Japan|Bank of England|Nationalbanken|"
                            r"central banks?|Powell|Lagarde", r"Fed|FOMC|ECB|BOJ|PBOC"),
    "MACRO": _words(r"inflation|jobs report|payrolls|unemployment|retail sales|recession|"
                    r"economy|economic", r"CPI|GDP|PMI"),
    "IPO": _words(r"initial public offering|listing debut|goes public", r"IPO"),
}
# fmt: on

# Finnhub's general-news categories map straight onto the filters.
CATEGORY_TAGS: dict[str, tuple[list[NewsAsset], list[NewsTopic]]] = {
    "forex": (["FX"], []),
    "crypto": (["CRYPTO"], []),
    "merger": ([], ["M&A"]),
}

_ASSET_OF: dict[AssetClass, NewsAsset] = {
    AssetClass.EQUITY: "EQUITY",
    AssetClass.INDEX: "EQUITY",
    AssetClass.FX: "FX",
    AssetClass.CRYPTO: "CRYPTO",
}


@lru_cache(maxsize=4096)
def ticker_facts(raw: str) -> tuple[str, tuple[NewsRegion, ...], NewsAsset | None]:
    """A provider ticker → (canonical ID or the raw symbol, regions of its venue, asset)."""
    from .secmaster import symbology
    from .symbols import SymbolError, classify

    try:
        inst = classify(raw)
    except (SymbolError, ValueError):
        return raw, (), None
    cid = inst.id or inst.symbol
    regions: tuple[NewsRegion, ...] = ()
    parts = cid.split()
    if len(parts) == 3 and parts[2] == "EQUITY":
        ex = symbology().exchanges.get(parts[1])
        tz = ex.tz if ex else ""
        if parts[1] == "US":
            regions = ("US",)
        elif parts[1] == "DC":
            regions = ("DK", "EU")
        elif tz.startswith("Europe/"):
            regions = ("EU",)
        elif tz.startswith(("Asia/", "Australia/")):
            regions = ("APAC",)
    asset: NewsAsset | None = "COMMODITIES" if cid.endswith(" COMDTY") else None
    return cid, regions, asset or _ASSET_OF.get(inst.asset_class)


def _add[T](out: list[T], values: Iterable[T]) -> None:
    for v in values:
        if v not in out:
            out.append(v)


def tag(item: NewsItem, category: str | None = None) -> NewsItem:
    """Canonical tickers plus region / asset-class / topic tags (in place; returns the item)."""
    text = f"{item.headline} {item.summary or ''}"
    tickers: list[str] = []
    regions: list[NewsRegion] = list(item.regions)
    assets: list[NewsAsset] = list(item.asset_classes)
    topics: list[NewsTopic] = list(item.topics)
    for t in item.tickers:
        cid, regs, asset = ticker_facts(t.strip().upper())
        _add(tickers, [cid])
        _add(regions, regs)
        if asset:
            _add(assets, [asset])
    if category and category.lower() in CATEGORY_TAGS:
        a, tp = CATEGORY_TAGS[category.lower()]
        _add(assets, a)
        _add(topics, tp)
    _add(regions, [r for r, rx in REGION_WORDS.items() if rx.search(text)])
    if "DK" in regions and "EU" not in regions:
        regions.append("EU")
    _add(assets, [a for a, rx in ASSET_WORDS.items() if rx.search(text)])
    _add(topics, [t for t, rx in TOPIC_WORDS.items() if rx.search(text)])
    item.tickers, item.regions, item.asset_classes, item.topics = tickers, regions, assets, topics
    return item


# ---------------------------------------------------------------- ranking


def source_weight(item: NewsItem) -> float:
    return SOURCE_WEIGHT.get(item.provider.split()[0], 0.8)


def rank_score(item: NewsItem, now: datetime) -> float:
    age_h = max(0.0, (now - item.published).total_seconds() / 3600)
    recency = math.pow(0.5, age_h / HALF_LIFE_H)
    watch = WATCH_BOOST if item.watch else 1.0
    size = 1.0 + 0.5 * math.log2(1 + len(item.similar))
    return source_weight(item) * recency * watch * size


def rank(items: Sequence[NewsItem], now: datetime, watched: set[str]) -> list[NewsItem]:
    """Score every item (watchlist match from its tickers); highest first, newest on ties."""
    for n in items:
        n.watch = any(t in watched for t in n.tickers)
        n.score = rank_score(n, now)
    return sorted(items, key=lambda n: (n.score or 0.0, n.published), reverse=True)


# ---------------------------------------------------------------- keyword alerts


def keyword_pattern(keyword: str) -> re.Pattern[str]:
    return re.compile(r"(?<!\w)" + re.escape(keyword.strip()) + r"(?!\w)", re.IGNORECASE)


def matches(rule: NewsAlertRule, item: NewsItem) -> bool:
    return bool(keyword_pattern(rule.keyword).search(f"{item.headline} {item.summary or ''}"))


def valid_feed(url: str) -> bool:
    u = urlparse(url.strip())
    return u.scheme in ("http", "https") and bool(u.netloc) and len(url) <= 300


@dataclass
class _Clock:
    fixed: datetime | None = None

    def now(self) -> datetime:
        return self.fixed or datetime.now(UTC)


class NewsService:
    """TOP / N / CN data: merged provider news → clusters → tags → rank; user feeds; keyword
    alerts checked in the background while the app runs (the UI says so)."""

    def __init__(
        self,
        db: Database,
        market: MarketService,
        hub: LiveHub | None = None,
        rss: RssProvider | None = None,
        env_feeds: Sequence[str] = (),
        now: datetime | None = None,
        interval: float = 120.0,
    ) -> None:
        self.db = db
        self.market = market
        self.hub = hub
        self.rss = rss
        self.env_feeds = [f for f in env_feeds if valid_feed(f)]
        self.clock = _Clock(now)
        self.interval = interval
        self._task: asyncio.Task[None] | None = None
        self.apply_feeds(self.feeds())

    # ----- feeds

    def feeds(self) -> NewsFeeds:
        raw = self.db.get_setting(FEEDS_KEY)
        try:
            return NewsFeeds.model_validate(raw or {})
        except ValueError:
            return NewsFeeds()

    def set_feeds(self, value: NewsFeeds) -> NewsFeeds:
        clean = list(dict.fromkeys(f.strip() for f in value.feeds if valid_feed(f)))[:MAX_FEEDS]
        out = NewsFeeds(feeds=clean)
        self.db.set_setting(FEEDS_KEY, out.model_dump())
        self.apply_feeds(out)
        self.market.router.cache.invalidate()  # the merged lists named the old feeds
        return out

    def apply_feeds(self, value: NewsFeeds) -> None:
        if self.rss is not None:
            self.rss.set_feeds(list(dict.fromkeys([*self.env_feeds, *value.feeds])))

    # ----- lists

    def watched(self) -> set[str]:
        out: set[str] = set()
        for w in self.db.list_watchlists():
            for s in w.get("symbols", []):
                if isinstance(s, str) and not s.startswith("#"):
                    out.add(ticker_facts(s.strip().upper())[0])
        return out

    async def news(
        self, symbol: str | None, limit: int = 60, sort: Literal["rank", "time"] | None = None
    ) -> NewsResponse:
        res = await self.market.news(symbol, max(limit, 60))
        now = self.clock.now()
        items = cluster(tag(n.model_copy(), None) for n in res.data)
        if symbol:
            cid = ticker_facts(symbol.strip().upper())[0]
            for n in items:  # company news is about the security even when the source omits it
                if cid not in n.tickers:
                    n.tickers.insert(0, cid)
        order = sort or ("time" if symbol else "rank")
        ranked = rank(items, now, self.watched())
        if order == "time":
            ranked.sort(key=lambda n: (n.published, n.id), reverse=True)
        return res.model_copy(update={"data": ranked[:limit], "now": now, "sort": order})

    # ----- keyword alerts

    def alerts(self) -> NewsAlerts:
        try:
            return NewsAlerts.model_validate(self.db.get_setting(ALERTS_KEY) or {})
        except ValueError:
            return NewsAlerts()

    def set_alerts(self, value: NewsAlerts) -> NewsAlerts:
        old = {r.keyword.lower(): r for r in self.alerts().rules}
        now = self.clock.now()
        rules: list[NewsAlertRule] = []
        for r in value.rules:
            kw = " ".join(r.keyword.split())
            if len(kw) < 2 or kw.lower() in {x.keyword.lower() for x in rules}:
                continue
            prev = old.get(kw.lower())
            rules.append(prev or NewsAlertRule(keyword=kw, created_at=now, since=now))
        out = NewsAlerts(rules=rules)
        self.db.set_setting(ALERTS_KEY, out.model_dump(mode="json"))
        return out

    async def check_alerts(self) -> list[LiveNewsAlert]:
        """Fire each rule once per new matching headline published after its watermark."""
        state = self.alerts()
        if not state.rules:
            return []
        res = await self.news(None, 120, "time")
        fired: list[LiveNewsAlert] = []
        changed = False
        for rule in state.rules:
            since = rule.since or rule.created_at or self.clock.now()
            fresh = [n for n in res.data if n.published > since]
            for n in sorted(fresh, key=lambda n: n.published):
                if matches(rule, n):
                    msg = LiveNewsAlert(
                        type="news_alert", keyword=rule.keyword, item=n, meta=res.meta
                    )
                    fired.append(msg)
                    rule.fired += 1
                    log.info("news alert %r: %s (%s)", rule.keyword, n.headline, n.source)
                    if self.hub is not None:
                        self.hub.broadcast_raw(msg.model_dump_json())
            if fresh:
                rule.since = max(n.published for n in fresh)
                changed = True
        if changed:
            self.db.set_setting(ALERTS_KEY, state.model_dump(mode="json"))
        return fired

    async def start(self) -> None:
        self._task = asyncio.create_task(self._loop(), name="news-alerts")

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await self._task

    async def _loop(self) -> None:
        while True:
            try:
                await self.check_alerts()
            except Exception as exc:  # a failing source must not stop the loop
                log.warning("news alert check failed: %s", exc)
            await asyncio.sleep(self.interval)
