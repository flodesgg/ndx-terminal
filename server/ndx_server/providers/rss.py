"""RSS/Atom news feeds (keyless, configurable via RSS_FEEDS)."""

from __future__ import annotations

import asyncio
import calendar
import hashlib
import html
import re
from datetime import UTC, datetime
from typing import Any, ClassVar
from urllib.parse import urlparse

import feedparser
import httpx

from ..models import AssetClass, Instrument, Latency, NewsItem
from .base import Capability, DataProvider, NotSupported, TransientError
from .budgets import BUDGETS
from .http import check, make_client

_TAG = re.compile(r"<[^>]+>")


def _clean(text: str | None) -> str | None:
    if not text:
        return None
    t = html.unescape(_TAG.sub("", text)).strip()
    return t[:600] or None


def parse_feed(content: bytes, feed_url: str) -> list[NewsItem]:
    parsed: Any = feedparser.parse(content)
    feed_title = (parsed.feed.get("title") if parsed.get("feed") else None) or urlparse(
        feed_url
    ).netloc
    out: list[NewsItem] = []
    for e in parsed.entries:
        url = e.get("link")
        title = _clean(e.get("title"))
        st = e.get("published_parsed") or e.get("updated_parsed")
        if not url or not title or not st:
            continue  # items without a timestamp can't be ordered honestly
        out.append(
            NewsItem(
                id=hashlib.sha1(url.encode()).hexdigest()[:16],
                headline=title,
                summary=(summary := _clean(e.get("summary"))),
                summary_note=None if summary else "the feed gave no summary",
                url=url,
                source=str(feed_title).strip(),
                provider="RSS",
                published=datetime.fromtimestamp(calendar.timegm(st), UTC),
            )
        )
    return out


class RssProvider(DataProvider):
    name = "rss"
    label = "RSS feeds"
    capabilities: ClassVar[dict[Capability, frozenset[AssetClass]]] = {
        Capability.NEWS: frozenset(AssetClass),
    }

    def __init__(self, feeds: list[str], client: httpx.AsyncClient | None = None) -> None:
        super().__init__(BUDGETS["rss"].bucket())
        # An honest User-Agent (make_client's): a publisher that refuses it is not worked
        # around (PROVIDERS §3.14, SPEC §1.7).
        self.client = client or make_client()
        self.feeds: list[str] = []
        self.set_feeds(feeds)

    def set_feeds(self, feeds: list[str]) -> None:
        """The feeds the user added in PDF (plus RSS_FEEDS); no defaults, since the terms of
        publishers' feeds are unverified (PROVIDERS §3.14)."""
        self.feeds = list(feeds)
        self.disabled_reason = None if self.feeds else "no RSS feeds added (PDF NEWS)"

    def latency(self, asset: AssetClass) -> tuple[Latency, int | None]:
        return Latency.STATIC, None

    def result_meta(self, asset: AssetClass, value: Any) -> tuple[Latency, int | None, str | None]:
        return Latency.STATIC, None, "feeds polled; times are publisher timestamps"

    async def aclose(self) -> None:
        await self.client.aclose()

    async def _fetch(self, url: str) -> list[NewsItem]:
        try:
            resp = await self.client.get(url)
        except httpx.HTTPError as exc:
            raise TransientError(f"{urlparse(url).netloc}: {type(exc).__name__}") from exc
        check(resp, urlparse(url).netloc)
        return parse_feed(resp.content, url)

    async def news(self, inst: Instrument | None, limit: int) -> list[NewsItem]:
        if inst is not None:
            raise NotSupported("RSS feeds are general market news")
        results = await asyncio.gather(
            *(self._fetch(u) for u in self.feeds), return_exceptions=True
        )
        items: list[NewsItem] = []
        failures: list[str] = []
        for r in results:
            if isinstance(r, BaseException):
                failures.append(str(r))
            else:
                items.extend(r)
        if not items and failures:
            raise TransientError("; ".join(failures))
        items.sort(key=lambda n: n.published, reverse=True)
        return items[:limit]
