"""Pydantic models shared by the API. TypeScript types are generated from these."""

from __future__ import annotations

from datetime import date, datetime
from enum import StrEnum
from typing import Any, Literal

from pydantic import BaseModel as _PydanticBase
from pydantic import ConfigDict, Field, PrivateAttr, computed_field


class BaseModel(_PydanticBase):
    """Fields with defaults are still always present in responses (required in TS types)."""

    model_config = ConfigDict(json_schema_serialization_defaults_required=True)


class Latency(StrEnum):
    REALTIME = "REALTIME"
    DELAYED = "DELAYED"
    EOD = "EOD"
    STATIC = "STATIC"  # reference data that does not tick (profiles, filings)


class AssetClass(StrEnum):
    EQUITY = "equity"
    INDEX = "index"
    FX = "fx"
    CRYPTO = "crypto"


class Meta(BaseModel):
    """Provenance attached to every data payload (SPEC §1.3, §6.1)."""

    source: str
    latency: Latency
    delay_minutes: int | None = Field(
        default=None, description="Delay as stated by the source; never assumed"
    )
    venue: str | None = Field(
        default=None, description="Single-venue / derived real-time marker: TRD, REF, IEX..."
    )
    provider_symbol: str | None = Field(default=None, description="Symbol used at the provider")
    as_of: datetime | None = Field(default=None, description="Timestamp of the data itself")
    fetched_at: datetime
    cached: bool = False
    stale: bool = Field(
        default=False, description="Data older than 2x its expected refresh when fetched"
    )
    stale_after_s: float | None = Field(
        default=None,
        description="UI marks the value STALE when now - fetched_at exceeds this",
    )
    personal_use: bool = Field(
        default=False, description="Opt-in unofficial source (yfinance): show PERSONAL USE"
    )
    demo: bool = Field(default=False, description="DEMO fixture data")
    attempts: list[str] = Field(default_factory=list, description="Providers tried, in order")
    note: str | None = Field(default=None, description="Caveat shown next to the source label")

    @computed_field(  # type: ignore[prop-decorator]
        description="Freshness tag per SPEC §6.1: RT, RT·<venue>, D{n}, EOD, CACHE, STALE, DEMO "
        "(the UI appends hh:mm to CACHE and turns any tag into STALE by age)"
    )
    @property
    def tag(self) -> str:
        return freshness_tag(
            self.latency, self.delay_minutes, self.venue, self.stale, self.demo, self.cached
        )


def freshness_tag(
    latency: Latency,
    delay_minutes: int | None,
    venue: str | None = None,
    stale: bool = False,
    demo: bool = False,
    cached: bool = False,
) -> str:
    if stale:
        # A copy served because the network is down (§6.3 offline) says so even in DEMO,
        # where the screen-wide DEMO badge still marks the data as fixtures (§13 step 9).
        return "STALE"
    if demo:
        return "DEMO"
    if cached:
        # A stored copy, whatever its source's latency (§6.1 "CACHE hh:mm": served from cache).
        return "CACHE"
    if latency is Latency.REALTIME:
        return f"RT·{venue}" if venue else "RT"
    if latency is Latency.DELAYED:
        # Never assume a delay the source does not state: an unstated delay is just a
        # timestamped snapshot.
        return f"D{delay_minutes}" if delay_minutes is not None else "CACHE"
    if latency is Latency.EOD:
        return "EOD"
    return "CACHE"


class ErrorBody(BaseModel):
    error: str
    code: Literal["not_found", "upstream", "rate_limited", "no_provider", "bad_request", "deferred"]
    attempts: list[str] = Field(default_factory=list)
    # rate_limited: the request holds a place in the provider's queue; repeat after this long
    retry_after_s: float | None = None
    # the provider a queue (rate_limited) or a deferral (deferred) is about
    provider: str | None = None


# ---------- market data ----------


class Instrument(BaseModel):
    symbol: str
    asset_class: AssetClass
    display: str
    id: str | None = Field(default=None, description="Canonical ID (SPEC §5), e.g. AAPL US EQUITY")


class Quote(BaseModel):
    symbol: str
    name: str | None = None
    currency: str | None = None
    exchange: str | None = None
    price: float | None = None
    change: float | None = None
    change_pct: float | None = None
    prev_close: float | None = None
    open: float | None = None
    high: float | None = None
    low: float | None = None
    volume: float | None = None
    vwap: float | None = Field(default=None, description="Session VWAP as the source states it")
    bid: float | None = None
    ask: float | None = None
    bid_size: float | None = None
    ask_size: float | None = None
    market_state: str | None = None
    ts: datetime | None = Field(default=None, description="Time of the last trade/update")
    ext_price: float | None = Field(default=None, description="Pre/post-market price")
    ext_change_pct: float | None = None
    ext_session: Literal["PRE", "POST"] | None = None
    week52_high: float | None = None
    week52_low: float | None = None
    avg_volume: float | None = None
    market_cap: float | None = None
    # Provider-specific latency (label, delay minutes, note); not serialized.
    _latency: tuple[Latency, int | None, str | None] | None = PrivateAttr(default=None)


class QuoteResponse(BaseModel):
    meta: Meta
    data: Quote


class QuotesResponse(BaseModel):
    """Batch quotes; each item carries its own provenance or error."""

    items: list[QuoteItem]


class QuoteItem(BaseModel):
    symbol: str
    meta: Meta | None = None
    data: Quote | None = None
    error: str | None = None


Interval = Literal["1m", "5m", "15m", "30m", "1h", "4h", "1d", "1wk", "1mo"]


class Bar(BaseModel):
    t: int = Field(
        description="Bar open time as exchange-local wall-clock time encoded as unix seconds "
        "(daily+ bars: local date at 00:00). Charts display it as-is."
    )
    o: float
    h: float
    l: float  # noqa: E741
    c: float
    v: float | None = Field(description="Volume; null when the source has none (N.A.)")


class BarsResponse(BaseModel):
    meta: Meta
    symbol: str
    interval: Interval
    tz: str = Field(description="Exchange time zone (IANA)")
    utc_offset_s: int = Field(description="Current UTC offset of the exchange time zone")
    data: list[Bar]


class Profile(BaseModel):
    symbol: str
    name: str | None = None
    asset_class: AssetClass
    quote_type: str | None = None
    exchange: str | None = None
    currency: str | None = None
    country: str | None = None
    sector: str | None = None
    industry: str | None = None
    website: str | None = None
    employees: int | None = None
    description: str | None = None
    market_cap: float | None = None
    shares_outstanding: float | None = None
    pe_trailing: float | None = None
    pe_forward: float | None = None
    eps_trailing: float | None = None
    dividend_yield: float | None = Field(default=None, description="Percent, e.g. 0.32")
    beta: float | None = None
    week52_high: float | None = None
    week52_low: float | None = None
    avg_volume: float | None = None
    next_earnings: datetime | None = None
    earnings_estimate: bool | None = None
    ex_dividend_date: datetime | None = None
    extra: dict[str, Any] = Field(default_factory=dict)


class ProfileResponse(BaseModel):
    meta: Meta
    data: Profile


class SearchResult(BaseModel):
    symbol: str
    name: str | None = None
    exchange: str | None = None
    type: str | None = None
    asset_class: AssetClass


class SearchResponse(BaseModel):
    meta: Meta
    data: list[SearchResult]


NewsRegion = Literal["US", "EU", "DK", "APAC"]
NewsAsset = Literal["EQUITY", "FX", "RATES", "COMMODITIES", "CRYPTO"]
NewsTopic = Literal["EARNINGS", "M&A", "CENTRAL BANKS", "MACRO", "IPO"]


class NewsSimilar(BaseModel):
    """A near-duplicate collapsed into an earlier headline (SPEC §8 TOP/N/CN)."""

    id: str
    headline: str
    url: str
    source: str
    provider: str
    published: datetime


class NewsItem(BaseModel):
    id: str
    headline: str
    summary: str | None = None
    summary_note: str | None = Field(
        default=None, description="Why the summary is N.A. (e.g. the source gives headlines only)"
    )
    url: str
    source: str = Field(description="Publisher")
    provider: str = Field(description="Data provider the item came from")
    published: datetime
    tickers: list[str] = Field(
        default_factory=list, description="Canonical IDs where mappable, else provider symbols"
    )
    regions: list[NewsRegion] = Field(
        default_factory=list, description="From tickers and keyword rules (news.py), not the source"
    )
    asset_classes: list[NewsAsset] = Field(default_factory=list)
    topics: list[NewsTopic] = Field(default_factory=list)
    similar: list[NewsSimilar] = Field(
        default_factory=list, description="Near-duplicates (title similarity >= 0.85 within 2 h)"
    )
    watch: bool = Field(default=False, description="A ticker is on one of the user's watchlists")
    score: float | None = Field(
        default=None, description="Rank: source weight x recency x watchlist match x cluster"
    )


class NewsResponse(BaseModel):
    meta: Meta
    data: list[NewsItem]
    errors: list[str] = Field(default_factory=list, description="Providers that failed")
    now: datetime | None = Field(
        default=None, description="Server clock for recency and NEW (fixed in DEMO)"
    )
    sort: Literal["rank", "time"] = "time"


class NewsFeeds(BaseModel):
    """RSS/Atom feeds the user added in PDF (no defaults: publishers' terms are theirs)."""

    feeds: list[str] = Field(default_factory=list, max_length=12)


class NewsAlertRule(BaseModel):
    keyword: str = Field(min_length=2, max_length=40)
    created_at: datetime | None = None
    since: datetime | None = Field(
        default=None, description="Items published up to here were already checked"
    )
    fired: int = 0


class NewsAlerts(BaseModel):
    rules: list[NewsAlertRule] = Field(default_factory=list, max_length=30)


class LiveNewsAlert(BaseModel):
    type: Literal["news_alert"]
    keyword: str
    item: NewsItem
    meta: Meta


class CryptoMarket(BaseModel):
    id: str
    symbol: str = Field(description="Coin ticker, e.g. BTC")
    name: str
    rank: int | None = None
    price_usd: float | None = None
    change_24h_pct: float | None = None
    change_7d_pct: float | None = None
    market_cap: float | None = None
    volume_24h: float | None = None
    binance_symbol: str | None = Field(default=None, description="Live USDT pair on Binance")
    last_updated: datetime | None = None


class CryptoMarketsResponse(BaseModel):
    meta: Meta
    data: list[CryptoMarket]


# ---------- research (Phase 3) ----------


class StatementLine(BaseModel):
    key: str
    label: str
    values: list[float | None] = Field(description="Aligned with FinancialsResponse.periods")


class Statement(BaseModel):
    name: Literal["income", "balance", "cashflow", "ratios"]
    lines: list[StatementLine]


class FinancialsResponse(BaseModel):
    meta: Meta
    symbol: str
    period: Literal["annual", "quarterly"]
    currency: str | None = None
    periods: list[str] = Field(description="Period end dates, oldest first")
    statements: list[Statement]


class ExportResult(BaseModel):
    path: str
    rows: int


class Filing(BaseModel):
    date: str
    form: str
    title: str | None = None
    url: str


class ChartEvent(BaseModel):
    """A corporate event for GP markers (SPEC §8 `E/D/S`)."""

    kind: Literal["E", "D", "S"] = Field(description="E earnings, D dividend, S split")
    date: str = Field(description="Venue-local date YYYY-MM-DD (ex-date for a dividend)")
    title: str
    value: float | None = Field(
        default=None, description="Dividend cash per share; split ratio new/old shares"
    )
    currency: str | None = None
    url: str | None = None
    source: str


class EventsResponse(BaseModel):
    meta: Meta
    symbol: str
    data: list[ChartEvent]
    errors: list[str] = Field(default_factory=list, description="Sources that failed")
    uncovered: list[str] = Field(
        default_factory=list, description="Event kinds no enabled source covers here"
    )


class FilingsResponse(BaseModel):
    meta: Meta
    symbol: str
    data: list[Filing]


class InsiderTxn(BaseModel):
    date: str
    insider: str
    relation: str | None = None
    text: str | None = None
    shares: float | None = None
    value: float | None = None
    ownership: str | None = Field(default=None, description="D = direct, I = indirect")


class InsidersResponse(BaseModel):
    meta: Meta
    symbol: str
    data: list[InsiderTxn]


class EconEvent(BaseModel):
    event: str
    country: str | None = None
    time: datetime
    period: str | None = None
    actual: str | None = None
    expected: str | None = None
    prior: str | None = None
    revised: str | None = None


class EconCalendarResponse(BaseModel):
    meta: Meta
    data: list[EconEvent]


class MacroPoint(BaseModel):
    date: str
    value: float


class MacroSeries(BaseModel):
    id: str
    title: str
    units: str | None = None
    frequency: str | None = None
    data: list[MacroPoint]
    updated: datetime | None = Field(
        default=None, description="When the source last updated the series, if it says"
    )


EcoCountry = Literal["US", "EZ", "DE", "DK", "UK", "JP", "CN"]


class EcoEvent(BaseModel):
    """One line of the economic calendar (SPEC §8 `ECO`)."""

    id: str
    time: datetime = Field(description="Release time (UTC)")
    time_kind: Literal["calendar", "standard"] = Field(
        description="calendar: the time the calendar states; standard: the calendar gives the "
        "date only and the time is the issuer's standard release time"
    )
    country: str
    event: str
    period: str | None = Field(default=None, description="Reference period, when known")
    importance: int = Field(ge=1, le=3)
    actual: float | None = None
    survey: float | None = Field(
        default=None, description="Always None: no official source publishes consensus"
    )
    prior: float | None = None
    revised: float | None = Field(default=None, description="None: no vintages are kept")
    unit: str = ""
    digits: int = 1
    note: str | None = Field(default=None, description="Why actual or prior is N.A.")
    source: str = Field(description="Calendar the entry comes from")
    series: str | None = Field(default=None, description="provider:id of actual/prior")
    series_source: str | None = None
    indicator: str | None = Field(default=None, description="ECST key of this line's series")
    tentative: bool = False
    released: bool


class EcoSource(BaseModel):
    name: str
    label: str
    ok: bool
    count: int = 0
    detail: str | None = None
    fetched_at: datetime | None = None


class EcoResponse(BaseModel):
    meta: Meta
    now: datetime = Field(description="Server clock (DEMO: the fixed fixture clock)")
    start: date
    end: date
    data: list[EcoEvent]
    sources: list[EcoSource]
    no_source: list[str] = Field(
        default_factory=list, description="Filter countries without any calendar source"
    )


class EcoIndicator(BaseModel):
    """A mapped economic series (SPEC §8 `ECST`): one per country + event name."""

    key: str = Field(description="ECST argument, e.g. us-cpi-yoy")
    country: str
    event: str
    importance: int = Field(ge=1, le=3)
    series: str = Field(description="provider:id[?filters]")
    transform: Literal["level", "mom", "yoy", "diff"]
    transform_label: str = Field(description="What the values are: level, % m/m, % y/y, change")
    unit: str = ""
    digits: int = 1
    calendar: str = Field(description="Calendar that dates its releases")


class EcoIndicatorsResponse(BaseModel):
    data: list[EcoIndicator]


class EcoObservation(BaseModel):
    period: str = Field(description="YYYY-MM, YYYY-Qn, YYYY or YYYY-MM-DD")
    date: str = Field(description="First day of the period (chart x)")
    value: float


class EcoHistoryResponse(BaseModel):
    meta: Meta
    now: datetime
    indicator: EcoIndicator
    title: str = Field(description="The source's own series title")
    frequency: str | None = Field(default=None, description="D, W, M, Q or A")
    updated: datetime | None = Field(default=None, description="Source's last series update")
    data: list[EcoObservation] = Field(description="Values after the transform, oldest first")
    last_release: datetime | None = Field(default=None, description="From the calendars")
    next_release: datetime | None = Field(default=None, description="From the calendars")


class MacroResponse(BaseModel):
    meta: Meta
    data: MacroSeries


class YieldCurve(BaseModel):
    date: str
    yields: list[float | None] = Field(description="Aligned with YieldCurveResponse.tenors")


class YieldCurveResponse(BaseModel):
    meta: Meta
    tenors: list[str]
    current: YieldCurve
    month_ago: YieldCurve | None = None
    year_ago: YieldCurve | None = None


class ScreenRow(BaseModel):
    symbol: str
    name: str | None = None
    exchange: str | None = None
    currency: str | None = None
    price: float | None = None
    change_pct: float | None = None
    market_cap: float | None = None
    pe: float | None = None
    volume: float | None = None
    avg_volume: float | None = None
    dividend_yield: float | None = None


class ScreenResponse(BaseModel):
    meta: Meta
    total: int
    data: list[ScreenRow]


AlertKind = Literal["above", "below", "pct_above", "pct_below"]


class Alert(BaseModel):
    id: int
    symbol: str
    kind: AlertKind
    threshold: float
    note: str = ""
    active: bool
    created_at: str
    triggered_at: str | None = None
    triggered_price: float | None = None


class AlertCreate(BaseModel):
    symbol: str
    kind: AlertKind
    threshold: float
    note: str = Field(default="", max_length=200)


class LiveAlert(BaseModel):
    type: Literal["alert"]
    alert: Alert
    price: float | None = None
    change_pct: float | None = None
    meta: Meta


# ---------- portfolio & analytics (Phase 4) ----------


class Trade(BaseModel):
    id: int
    symbol: str
    qty: float = Field(description="Positive = buy, negative = sell")
    price: float
    ts: str
    note: str = ""


class TradeCreate(BaseModel):
    symbol: str
    qty: float
    price: float | None = Field(default=None, description="Omit to fill at the current quote")
    note: str = Field(default="", max_length=200)


class TradeImport(BaseModel):
    csv: str = Field(
        max_length=500_000,
        description="CSV with header date,security,side,qty,price[,fees][,note]",
    )


class TradeImportResult(BaseModel):
    imported: int
    errors: list[str] = Field(default_factory=list, description="Row errors; nothing imported")


class JournalEntryBody(BaseModel):
    symbol: str = Field(min_length=1, max_length=64)
    side: Literal["LONG", "SHORT"]
    qty: float = Field(gt=0)
    entry: float = Field(gt=0)
    exit: float | None = Field(default=None, gt=0)
    opened: str | None = Field(default=None, description="YYYY-MM-DD; default today")
    closed: str | None = Field(default=None, description="YYYY-MM-DD when exit is set")
    setup: str = Field(default="", max_length=200, description="Comma-separated tags")
    mistakes: str = Field(default="", max_length=200, description="Comma-separated tags")
    thesis: str = Field(default="", max_length=4000)
    review: str = Field(default="", max_length=4000, description="Post-mortem")


class JournalEntry(JournalEntryBody):
    id: int
    opened: str
    pnl: float | None = Field(
        default=None, description="(exit-entry)*qty, sign by side; trade currency"
    )
    ret_pct: float | None = Field(default=None, description="Return % on entry, sign by side")


class JournalTagStats(BaseModel):
    tag: str
    kind: Literal["setup", "mistake"]
    trades: int = Field(description="Closed trades with this tag")
    win_rate: float | None = Field(default=None, description="% of closed trades with ret > 0")
    avg_ret_pct: float | None = None


class JournalResponse(BaseModel):
    entries: list[JournalEntry] = Field(description="Newest first")
    closed: int
    open: int
    win_rate: float | None = None
    avg_ret_pct: float | None = None
    by_tag: list[JournalTagStats]


class Position(BaseModel):
    symbol: str
    asset_class: AssetClass
    qty: float
    avg_cost: float
    currency: str | None = None
    last: float | None = None
    fx_to_base: float | None = Field(default=None, description="1 unit of currency in base")
    market_value: float | None = Field(default=None, description="In base currency")
    cost_basis: float | None = Field(default=None, description="In base currency")
    unrealized_pnl: float | None = None
    unrealized_pct: float | None = None
    day_pnl: float | None = None
    weight: float | None = None
    sector: str | None = None
    quote_meta: Meta | None = None


class Exposure(BaseModel):
    name: str
    value: float
    weight: float


class RiskMetrics(BaseModel):
    days: int
    volatility_ann: float | None = None
    max_drawdown: float | None = None
    beta_vs_spy: float | None = None
    method: str


class PortfolioResponse(BaseModel):
    base_currency: str
    partial: bool = Field(
        default=False, description="Totals exclude positions without price or FX rate"
    )
    total_value: float | None
    total_cost: float | None
    unrealized_pnl: float | None
    realized_pnl: float
    day_pnl: float | None
    positions: list[Position]
    by_sector: list[Exposure]
    by_asset_class: list[Exposure]
    risk: RiskMetrics | None = None
    warnings: list[str] = Field(default_factory=list)
    as_of: datetime


class CorrelationResponse(BaseModel):
    symbols: list[str]
    matrix: list[list[float | None]]
    days: int = Field(description="Overlapping daily returns used")
    start: str | None = None
    end: str | None = None
    errors: list[str] = Field(default_factory=list)
    sources: list[str] = Field(default_factory=list)


class Note(BaseModel):
    symbol: str
    body: str
    updated_at: str | None = None


class NoteBody(BaseModel):
    body: str = Field(max_length=200_000)


class BtScript(BaseModel):
    name: str
    description: str | None = None
    modified: str


class BtScriptsResponse(BaseModel):
    directory: str | None
    configured: bool
    scripts: list[BtScript]


class BtRunRequest(BaseModel):
    script: str
    args: list[str] = Field(default_factory=list, max_length=20)


class BtPoint(BaseModel):
    t: str
    v: float


class BtRunResponse(BaseModel):
    ok: bool
    script: str
    duration_s: float
    exit_code: int | None
    equity: list[BtPoint] = Field(default_factory=list)
    benchmark: list[BtPoint] = Field(default_factory=list)
    stats: dict[str, float | str | None] = Field(default_factory=dict)
    error: str | None = None
    stdout_tail: list[str] = Field(default_factory=list)
    stderr_tail: list[str] = Field(default_factory=list)


class FieldInfo(BaseModel):
    """One entry of the normalized field dictionary (SPEC §6.3, FLDS)."""

    id: str = Field(description="Normalized field name, e.g. px_last")
    name: str
    definition: str
    domain: Literal["quotes", "reference", "fundamentals"]
    kind: Literal["price", "change", "pct", "volume", "money", "ratio", "time", "text"]
    attr: str = Field(description="Property of Quote (domain quotes) or Profile that carries it")
    sources: list[str] = Field(
        default_factory=list,
        description="Providers seen delivering a value for this field since launch",
    )


class FieldsResponse(BaseModel):
    fields: list[FieldInfo]


# ---------- live (WebSocket messages) ----------


class LiveQuote(BaseModel):
    type: Literal["quote"]
    symbol: str
    data: Quote
    meta: Meta


class TapePrint(BaseModel):
    seq: int = Field(description="Per-symbol sequence: a gap means prints the client missed")
    t: datetime = Field(description="Trade time")
    price: float
    size: float | None = None


class LiveTrades(BaseModel):
    """Time & sales: the newest prints of a real trade feed (up to TAPE_KEEP), oldest first.
    The whole window is resent on each print, so coalescing never loses one silently."""

    type: Literal["trades"]
    symbol: str
    prints: list[TapePrint]
    meta: Meta


class LiveBar(BaseModel):
    type: Literal["bar"]
    symbol: str
    interval: Interval
    bar: Bar
    closed: bool
    meta: Meta


class LiveFeedStatus(BaseModel):
    type: Literal["status"]
    feed: str
    state: Literal["connected", "connecting", "down"]
    detail: str | None = None


class LiveError(BaseModel):
    type: Literal["error"]
    symbol: str | None = None
    error: str


# ---------- user data ----------


class Watchlist(BaseModel):
    id: int
    name: str
    symbols: list[str] = Field(description="Symbols in list order, without group headers")
    rows: list[str] = Field(
        description='Display order: symbols and group headers written "#<name>"'
    )


class WatchlistCreate(BaseModel):
    name: str = Field(min_length=1, max_length=32)


class WatchlistItems(BaseModel):
    symbols: list[str] = Field(
        description='Rows in order: symbols, and group headers written "#<name>"'
    )


# ---------- system ----------


class ProviderState(StrEnum):
    OK = "ok"
    DEGRADED = "degraded"
    DOWN = "down"
    DISABLED = "disabled"
    IDLE = "idle"
    LIMIT = "limit"  # the plan's budget for the period is spent: an answer, not an outage


class ProviderStatus(BaseModel):
    name: str
    label: str
    state: ProviderState
    detail: str | None = None
    requires_key: bool
    has_key: bool
    latency: Latency
    tag: str = Field(
        default="CACHE",
        description="SPEC §6.1 freshness tag of this provider's market values (RT·TRD, D15, "
        "EOD, CACHE, DEMO...), shown next to its name in the status bar",
    )
    calls: int = 0
    errors: int = 0
    rate_limited: int = 0
    last_ok: datetime | None = None
    last_error: str | None = None
    last_error_at: datetime | None = None
    capabilities: list[str] = Field(default_factory=list)
    domains: list[str] = Field(
        default_factory=list,
        description="SPEC §6.3 domains served: quotes bars fundamentals news calendar "
        "reference stream",
    )
    opt_in: bool = Field(default=False, description="Off until the user enables it in PDF")
    personal_use: bool = Field(default=False, description="Unofficial source: PERSONAL USE")
    # PROV (SPEC §6.3): measured over the last 200 real requests; null = no sample yet (N.A.)
    latency_p50_ms: float | None = None
    latency_p95_ms: float | None = None
    error_rate: float | None = Field(default=None, description="0..1 over the last 200 requests")
    quota_limit: int | None = Field(default=None, description="Budget per window (PROVIDERS §6)")
    quota_period: str | None = Field(default=None, description="Window: s, min, hour, day")
    quota_used: int | None = Field(default=None, description="Requests taken this window")
    quota_left: int | None = None
    breaker: Literal["closed", "open", "half_open"] | None = None


class DemoNetwork(BaseModel):
    """DEMO only: the E2E switch that cuts the (fixture) providers' network."""

    up: bool


class OptInProviders(BaseModel):
    """Opt-in personal-use sources (SPEC §6.2). Off by default."""

    yfinance: bool = False
    yfinance_scope: Literal["all", "dk_indices"] = Field(
        default="all",
        description="What yfinance covers when on: every market, or Danish stocks and indices "
        "only (other markets keep their free sources)",
    )


class Health(BaseModel):
    status: Literal["ok"]
    demo: bool = Field(default=False, description="DEMO fixtures: UI shows a DEMO badge")
    app: str
    version: str
    started_at: datetime
    network: Literal["online", "offline"] = Field(
        default="online", description="Provider network reachability (SPEC §6.3 offline)"
    )
    offline_since: datetime | None = None
    reconnect_in_s: float | None = Field(
        default=None, description="Seconds to the next reconnect probe while offline"
    )


VenueState = Literal["OPEN", "CLOSED", "BREAK", "HOLIDAY"]


class SessionTimes(BaseModel):
    day: date = Field(description="Session date (venue calendar)")
    open: datetime
    close: datetime
    break_start: datetime | None = None
    break_end: datetime | None = None
    early_close: bool = False


class SpecialDay(BaseModel):
    day: date
    kind: Literal["holiday", "early_close"]
    name: str | None = Field(default=None, description="As the calendar names it; null if unnamed")
    close: datetime | None = Field(default=None, description="Early close time")


class VenueInfo(BaseModel):
    code: str
    name: str
    mic: str
    tz: str
    country: str
    state: VenueState | None = Field(
        default=None, description="null when the venue's calendar is unavailable"
    )
    next_change: datetime | None = None
    today: SessionTimes | None = Field(default=None, description="Today's session (venue date)")
    next_session: SessionTimes | None = None
    special: list[SpecialDay] = Field(default_factory=list)
    known_until: date | None = Field(
        default=None, description="Last session the calendar knows (holidays recorded to)"
    )
    utc_offset_s: int
    dst_change: datetime | None = Field(default=None, description="Next clock change")
    dst_offset_s: int | None = None


class CalendarResponse(BaseModel):
    meta: Meta
    venues: list[VenueInfo]


class SessionStateItem(BaseModel):
    symbol: str
    venue: str | None = None
    venue_name: str | None = None
    state: VenueState | None = None
    next_change: datetime | None = None
    error: str | None = None


class SessionStatesResponse(BaseModel):
    meta: Meta
    items: list[SessionStateItem]


class ExchangeStatus(BaseModel):
    code: str
    name: str
    tz: str
    is_open: bool | None = Field(description="null when the exchange calendar is unavailable")
    next_change: datetime | None = None
    holiday: bool = False


class LogResponse(BaseModel):
    path: str
    lines: list[str]


class ClientLog(BaseModel):
    level: Literal["debug", "info", "warn", "error"]
    message: str


class Layout(BaseModel):
    name: str
    tree: dict[str, Any]
    updated_at: datetime | None = None


class SessionState(BaseModel):
    """The UI session (windows, tabs, history, links); opaque to the server."""

    state: dict[str, Any] | None = None


class HistoryEntry(BaseModel):
    command: str
    ts: datetime | None = None


QuotesResponse.model_rebuild()


# ---------- security master (SPEC §5) ----------


class SeedStatus(BaseModel):
    name: str
    url: str
    present: bool
    fetched_at: str | None = None
    bytes: int | None = None
    ttl_hours: float
    terms: str
    error: str | None = None


class SecurityRecord(BaseModel):
    id: str = Field(description="Canonical ID, e.g. NOVOB DC EQUITY")
    sector: str
    ticker: str
    internal: str = Field(description="Symbol the data layer uses")
    exchange: str | None = None
    name: str | None = None
    currency: str | None = None
    country: str | None = None
    mic: str | None = None
    tz: str | None = None
    tick_size: float | None = None
    note: str | None = None
    providers: dict[str, str] = Field(description="Provider -> provider symbol")


class SecurityLookup(BaseModel):
    symbol: str = Field(description="As asked")
    record: SecurityRecord | None = None
    error: str | None = None


class YtdBase(BaseModel):
    """The last close of the previous calendar year: % YTD = last / close - 1."""

    symbol: str
    close: float | None = None
    day: date | None = Field(default=None, description="Date of that close (venue date)")
    meta: Meta | None = None
    error: str | None = Field(default=None, description="[code] message, as quotes carry it")


class YtdResponse(BaseModel):
    items: list[YtdBase]


class SecIndex(BaseModel):
    """Local security index for the command line (SPEC §4.3 rule 6, §4.7)."""

    complete: list[str] = Field(
        description="Universes listed exhaustively (exchange codes, CRYPTO, COMDTY, GOVT): "
        "a miss there is an unknown security; elsewhere it is unverified"
    )
    fiat: list[str] = Field(description="ISO codes that form PAIR CURNCY IDs")
    exchanges: list[str]
    sources: list[str]
    items: list[list[str]] = Field(description="[canonical ID, name, provider aliases...]")


class SecmasterStatus(BaseModel):
    tables_reviewed: dict[str, str | None]
    learned: int
    seeds: list[SeedStatus]
    migration: dict[str, Any] | None = None
