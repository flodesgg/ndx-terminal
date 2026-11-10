"""Market data endpoints."""

from __future__ import annotations

from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Query

from ..market import MarketService
from ..models import (
    BarsResponse,
    CryptoMarketsResponse,
    EventsResponse,
    FieldsResponse,
    Interval,
    NewsAlerts,
    NewsFeeds,
    NewsResponse,
    ProfileResponse,
    QuoteResponse,
    QuotesResponse,
    SearchResponse,
    YtdResponse,
)
from ..news import NewsService
from ..state import AppState, get_state
from .errors import ERROR_RESPONSES

router = APIRouter(tags=["market"], responses=ERROR_RESPONSES)


def get_market(state: Annotated[AppState, Depends(get_state)]) -> MarketService:
    svc: MarketService = state.services["market"]
    return svc


MarketDep = Annotated[MarketService, Depends(get_market)]


def get_news(state: Annotated[AppState, Depends(get_state)]) -> NewsService:
    svc: NewsService = state.services["news"]
    return svc


NewsDep = Annotated[NewsService, Depends(get_news)]


@router.get("/fields", response_model=FieldsResponse)
def fields(market: MarketDep) -> FieldsResponse:
    """Normalized field dictionary (SPEC §6.3) with the providers seen delivering each field."""
    return FieldsResponse(fields=market.fields.rows())


@router.get("/quote/{symbol:path}", response_model=QuoteResponse)
async def quote(symbol: str, market: MarketDep) -> QuoteResponse:
    return await market.quote(symbol)


@router.get("/quotes", response_model=QuotesResponse)
async def quotes(
    market: MarketDep,
    symbols: Annotated[str, Query(description="Comma-separated symbols", max_length=4000)],
) -> QuotesResponse:
    syms = [s for s in (x.strip() for x in symbols.split(",")) if s][:200]
    return await market.quotes(syms)


@router.get("/bars/{symbol:path}", response_model=BarsResponse)
async def bars(
    symbol: str,
    market: MarketDep,
    interval: Interval = "1d",
    lookback: Annotated[int | None, Query(ge=1, le=365 * 60, description="Days")] = None,
    defer: Annotated[
        bool,
        Query(description="Asked by a window not in focus: leave tight-budget sources for later"),
    ] = False,
) -> BarsResponse:
    return await market.bars(symbol, interval, lookback, defer)


@router.get("/ytd", response_model=YtdResponse)
async def ytd(
    market: MarketDep,
    symbols: Annotated[str, Query(max_length=4000, description="Comma-separated symbols")],
    defer: Annotated[
        bool,
        Query(description="Asked by a window not in focus: leave tight-budget sources for later"),
    ] = False,
) -> YtdResponse:
    """Previous year's last close per symbol, for % YTD against the live price."""
    wanted = [s.strip() for s in symbols.split(",") if s.strip()][:60]
    return await market.ytd_bases(wanted, defer)


@router.get("/profile/{symbol:path}", response_model=ProfileResponse)
async def profile(symbol: str, market: MarketDep) -> ProfileResponse:
    return await market.profile(symbol)


@router.get("/search", response_model=SearchResponse)
async def search(market: MarketDep, q: Annotated[str, Query(max_length=40)] = "") -> SearchResponse:
    return await market.search(q)


@router.get("/news", response_model=NewsResponse)
async def news(
    svc: NewsDep,
    symbol: Annotated[str | None, Query(max_length=24)] = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 60,
    sort: Literal["rank", "time"] | None = None,
) -> NewsResponse:
    """Merged headlines, near-duplicates collapsed, tagged for the filters; ranked (TOP) or
    newest first (company news) unless `sort` says otherwise (SPEC §8)."""
    return await svc.news(symbol or None, limit, sort)


@router.get("/news/feeds", response_model=NewsFeeds)
def get_news_feeds(svc: NewsDep) -> NewsFeeds:
    return svc.feeds()


@router.put("/news/feeds", response_model=NewsFeeds)
def put_news_feeds(value: NewsFeeds, svc: NewsDep) -> NewsFeeds:
    """RSS/Atom feeds the user added (PDF NEWS); invalid URLs are dropped."""
    return svc.set_feeds(value)


@router.get("/news/alerts", response_model=NewsAlerts)
def get_news_alerts(svc: NewsDep) -> NewsAlerts:
    return svc.alerts()


@router.put("/news/alerts", response_model=NewsAlerts)
def put_news_alerts(value: NewsAlerts, svc: NewsDep) -> NewsAlerts:
    """Keyword alerts: a new headline containing the keyword fires a toast while the app runs."""
    return svc.set_alerts(value)


@router.get("/events/{symbol:path}", response_model=EventsResponse)
async def events(
    symbol: str, market: MarketDep, defer: Annotated[bool, Query()] = False
) -> EventsResponse:
    """Earnings releases, dividends and splits for chart markers (SPEC §8 GP `E/D/S`)."""
    return await market.events(symbol, defer=defer)


@router.get("/crypto/markets", response_model=CryptoMarketsResponse)
async def crypto_markets(
    market: MarketDep, limit: Annotated[int, Query(ge=1, le=250)] = 50
) -> CryptoMarketsResponse:
    return await market.crypto_markets(limit)
