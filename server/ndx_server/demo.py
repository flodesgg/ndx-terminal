"""DEMO mode fixtures (SPEC §1.2): deterministic values for tests and screenshots only.

Active only when the server starts with `NDX_DEMO=1`; then this is the *only* provider (no
network), every Meta carries `demo=True` (tag `DEMO`) and the UI shows a large DEMO badge.
Values are fixed per symbol (table below, else derived from a hash of the symbol) — nothing is
random, so two runs render identical screens.
"""

from __future__ import annotations

import hashlib
import math
from datetime import UTC, date, datetime, timedelta
from typing import ClassVar

from .models import (
    AssetClass,
    Bar,
    ChartEvent,
    CryptoMarket,
    Instrument,
    Interval,
    Latency,
    MacroPoint,
    MacroSeries,
    NewsItem,
    Profile,
    Quote,
    SearchResult,
    Statement,
)
from .providers.base import BarSeries, Capability, DataProvider, NetworkError, NotFound
from .providers.calendars import CalEntry, time_at
from .providers.ratelimit import TokenBucket
from .providers.yahoo_research import assemble_statements

ALL = frozenset(AssetClass)

# symbol -> (name, currency, last, prev_close, volume or None)
FIXTURES: dict[str, tuple[str, str, float, float, float | None]] = {
    "AAPL": ("Apple Inc. (DEMO)", "USD", 231.40, 229.15, 48_210_000),
    "MSFT": ("Microsoft Corp. (DEMO)", "USD", 512.30, 515.02, 19_870_000),
    "NVDA": ("NVIDIA Corp. (DEMO)", "USD", 187.55, 183.90, 201_450_000),
    "SPY": ("SPDR S&P 500 ETF (DEMO)", "USD", 671.20, 668.75, 61_300_000),
    "QQQ": ("Invesco QQQ (DEMO)", "USD", 598.10, 594.40, 38_900_000),
    "NOVO-B.CO": ("Novo Nordisk B (DEMO)", "DKK", 389.60, 395.10, 3_420_000),
    "^GSPC": ("S&P 500 (DEMO)", "USD", 6712.45, 6688.10, None),
    "^OMXC25": ("OMX Copenhagen 25 (DEMO)", "DKK", 1612.30, 1620.85, None),
    "EURUSD": ("EUR/USD (DEMO)", "USD", 1.1642, 1.1618, None),
    "USDDKK": ("USD/DKK (DEMO)", "DKK", 6.4102, 6.4250, None),
    "BTCUSDT": ("Bitcoin (DEMO, quoted in USDT)", "USDT", 104_250.0, 102_980.0, 18_400.0),
    "ETHUSDT": ("Ethereum (DEMO, quoted in USDT)", "USDT", 3_812.5, 3_760.2, 254_000.0),
}

NOW = datetime(2026, 11, 9, 14, 30, tzinfo=UTC)  # fixed clock for reproducible screenshots

# News fixtures (TOP / N / CN): fictional publishers and headlines, minutes before NOW. Two
# stories are reported twice (near-duplicate clusters), two are < 5 min old (NEW).
# (minutes ago, publisher, headline, summary, provider tickers)
NEWS: list[tuple[int, str, str, str | None, list[str]]] = [
    (
        3,
        "Demo Wire",
        "Novo Nordisk raises full-year sales outlook on strong obesity drug demand",
        "The drugmaker lifted its sales growth range for the year (DEMO text).",
        ["NOVO-B.CO"],
    ),
    (
        2,
        "Sample Markets Daily",
        "Novo Nordisk raises full-year sales outlook on strong demand for obesity drugs",
        None,
        ["NOVO-B.CO"],
    ),
    (
        4,
        "Example Business News",
        "Maersk shares slip as freight rates ease in Asia-Europe trade",
        "Container rates on the main lane fell for a third week (DEMO text).",
        ["MAERSK-B.CO"],
    ),
    (
        35,
        "Demo Wire",
        "ECB holds rates steady, signals patience on further cuts",
        "Policymakers kept the deposit rate unchanged (DEMO text).",
        [],
    ),
    (
        52,
        "Fixture Financial",
        "ECB holds rates steady and signals patience on further cuts",
        None,
        [],
    ),
    (
        80,
        "Sample Markets Daily",
        "Fed officials see room for one more rate cut this year",
        "Two officials said inflation is cooling (DEMO text).",
        [],
    ),
    (
        190,
        "Example Business News",
        "Apple supplier shares climb as iPhone orders rise",
        "Component makers in Asia gained (DEMO text).",
        ["AAPL"],
    ),
    (
        300,
        "Demo Wire",
        "Danish central bank keeps key rate unchanged, in step with ECB",
        "Nationalbanken left its current-account rate as is (DEMO text).",
        [],
    ),
    (
        360,
        "Fixture Financial",
        "NVIDIA unveils new data-center chip; shares edge higher",
        "The company showed a new accelerator (DEMO text).",
        ["NVDA"],
    ),
    (
        420,
        "Sample Markets Daily",
        "Microsoft agrees deal to buy cybersecurity startup",
        "Terms were not disclosed (DEMO text).",
        ["MSFT"],
    ),
    (
        480,
        "Example Business News",
        "Nikkei closes higher as exporters gain on weaker yen",
        "Tokyo stocks rose for a second day (DEMO text).",
        [],
    ),
    (
        540,
        "Demo Wire",
        "Bitcoin steadies above 100,000 dollars after a volatile week",
        "Crypto markets calmed (DEMO text).",
        ["BTCUSDT"],
    ),
    (
        600,
        "Fixture Financial",
        "US 10-year Treasury yield edges up before inflation data",
        "Bond markets were quiet (DEMO text).",
        [],
    ),
    (
        660,
        "Sample Markets Daily",
        "Oil prices rise as OPEC+ signals output discipline",
        "Brent crude gained (DEMO text).",
        [],
    ),
    (
        1560,
        "Example Business News",
        "Euro zone factory PMI shows manufacturing stabilising",
        "The survey index rose (DEMO text).",
        [],
    ),
]


def news_fixtures() -> list[NewsItem]:
    out: list[NewsItem] = []
    for i, (mins, source, headline, summary, tickers) in enumerate(NEWS):
        out.append(
            NewsItem(
                id=f"demo-news-{i:02d}",
                headline=f"{headline} (DEMO)",
                summary=summary,
                summary_note=None if summary else "DEMO item without a summary",
                url=f"https://example.com/demo/news/{i:02d}",
                source=source,
                provider="DEMO",
                published=NOW - timedelta(minutes=mins),
                tickers=list(tickers),
            )
        )
    return out


def _h(symbol: str, salt: str = "") -> float:
    """Deterministic number in [0, 1) from the symbol (not random: same input, same output)."""
    digest = hashlib.sha256(f"{salt}:{symbol}".encode()).digest()
    return int.from_bytes(digest[:8], "big") / 2**64


def fixture(symbol: str) -> tuple[str, str, float, float, float | None]:
    if symbol in FIXTURES:
        return FIXTURES[symbol]
    last = round(10 + 490 * _h(symbol), 2)
    prev = round(last * (1 - 0.03 + 0.06 * _h(symbol, "chg")), 2)
    return (f"{symbol} (DEMO)", "USD", last, prev, round(1e6 * (1 + 20 * _h(symbol, "v"))))


class DemoProvider(DataProvider):
    name = "demo"
    label = "DEMO fixtures"
    demo = True
    storage = "memory"  # never written to the bar store
    capabilities: ClassVar[dict[Capability, frozenset[AssetClass]]] = {
        Capability.QUOTE: ALL,
        Capability.BARS: ALL,
        Capability.PROFILE: ALL,
        Capability.SEARCH: ALL,
        Capability.MACRO: frozenset({AssetClass.INDEX}),
        Capability.MARKETCAP: frozenset({AssetClass.CRYPTO}),
        Capability.YIELDS: frozenset({AssetClass.INDEX}),
        Capability.EARNINGS: frozenset({AssetClass.EQUITY}),
        Capability.ACTIONS: frozenset({AssetClass.EQUITY}),
        Capability.NEWS: ALL,
        Capability.ECON: frozenset({AssetClass.INDEX}),
        Capability.FUNDAMENTALS: frozenset({AssetClass.EQUITY}),
    }

    def __init__(self) -> None:
        super().__init__(TokenBucket(10_000, 10_000))
        # DEMO only: the E2E "cut the network" switch (PUT /demo/network). While cut, every
        # request fails the way an unreachable provider does (§13 step 9, §14 offline test).
        self.network_up = True

    def _net(self) -> None:
        if not self.network_up:
            raise NetworkError("DEMO: network cut")

    def latency(self, asset: AssetClass) -> tuple[Latency, int | None]:
        return Latency.EOD, None

    async def quote(self, inst: Instrument) -> Quote:
        self._net()
        name, ccy, last, prev, vol = fixture(inst.symbol)
        return Quote(
            symbol=inst.symbol,
            name=name,
            currency=ccy,
            price=last,
            change=round(last - prev, 6),
            change_pct=round((last / prev - 1) * 100, 4),
            prev_close=prev,
            open=prev,
            high=round(max(last, prev) * 1.004, 6),
            low=round(min(last, prev) * 0.996, 6),
            volume=vol,
            market_state="REGULAR",
            ts=NOW,
            week52_high=round(last * 1.18, 2),
            week52_low=round(last * 0.74, 2),
        )

    async def bars(self, inst: Instrument, interval: Interval, lookback_days: int) -> BarSeries:
        self._net()
        _, _, last, _, vol = fixture(inst.symbol)
        n = min(400, max(30, lookback_days if interval in ("1d", "1wk", "1mo") else 300))
        step = {"1d": 86400, "1wk": 7 * 86400, "1mo": 30 * 86400}.get(interval, 300)
        phase = 6.283 * _h(inst.symbol, "phase")
        bars: list[Bar] = []
        start = int((NOW - timedelta(seconds=step * n)).timestamp())
        for i in range(n):
            # Smooth deterministic path ending at the fixture's last price.
            x = (i - n + 1) / max(1, n - 1)
            wave = math.sin(i / 6 + phase) - math.sin((n - 1) / 6 + phase)  # 0 on the last bar
            c = last * (1 + 0.12 * x + 0.03 * wave)
            o = c * (1 - 0.004 * math.sin(i / 3 + phase))
            h, lo = max(o, c) * 1.006, min(o, c) * 0.994
            v = None if vol is None else round(vol * (0.7 + 0.3 * abs(math.sin(i / 5))))
            bars.append(Bar(t=start + i * step, o=o, h=h, l=lo, c=c, v=v))
        return BarSeries(bars=bars, tz="UTC", utc_offset_s=0, as_of=NOW)

    async def earnings_events(self, inst: Instrument) -> list[ChartEvent]:
        """Quarterly releases over two years, at fixed offsets from the DEMO clock."""
        self._net()
        day = NOW.date()
        return [
            ChartEvent(
                kind="E",
                date=(day - timedelta(days=20 + 91 * q)).isoformat(),
                title="Earnings release (DEMO), after the close",
                source="DEMO fixtures",
            )
            for q in range(7, -1, -1)
        ]

    async def corp_actions(self, inst: Instrument) -> list[ChartEvent]:
        self._net()
        day = NOW.date()
        divs = [
            ChartEvent(
                kind="D",
                date=(day - timedelta(days=45 + 91 * q)).isoformat(),
                title="Dividend (DEMO), ex-date",
                value=0.25,
                currency="USD",
                source="DEMO fixtures",
            )
            for q in range(7, -1, -1)
        ]
        split = ChartEvent(
            kind="S",
            date=(day - timedelta(days=150)).isoformat(),
            title="Split 4:1 (DEMO)",
            value=4.0,
            source="DEMO fixtures",
        )
        return [*divs, split]

    async def profile(self, inst: Instrument) -> Profile:
        self._net()
        name, ccy, _, _, vol = fixture(inst.symbol)
        return Profile(
            symbol=inst.symbol,
            name=name,
            asset_class=inst.asset_class,
            currency=ccy,
            description="DEMO fixture profile for tests and screenshots.",
            avg_volume=vol,
        )

    async def fundamentals(
        self, inst: Instrument, period: str
    ) -> tuple[list[str], str | None, list[Statement]]:
        self._net()
        return fundamentals_fixture(inst.symbol, period)

    async def news(self, inst: Instrument | None, limit: int) -> list[NewsItem]:
        self._net()
        items = news_fixtures()
        if inst is not None:
            items = [n for n in items if inst.symbol in n.tickers]
        return items[:limit]

    async def econ_calendar(self) -> list[CalEntry]:
        self._net()
        return eco_calendar_fixtures()

    async def econ_series(self, spec: str) -> MacroSeries:
        self._net()
        return eco_series_fixture(spec)

    async def search(self, query: str) -> list[SearchResult]:
        self._net()
        q = query.strip().upper()
        return [
            SearchResult(symbol=s, name=f[0], asset_class=AssetClass.EQUITY)
            for s, f in FIXTURES.items()
            if q in s or q in f[0].upper()
        ]

    async def markets(self, limit: int) -> list[CryptoMarket]:
        """CRYPTO's ranking (CoinGecko in real mode): a few coins, deterministic values."""
        self._net()
        coins = [("bitcoin", "BTC", "Bitcoin"), ("ethereum", "ETH", "Ethereum")]
        coins += [
            ("solana", "SOL", "Solana"),
            ("ripple", "XRP", "XRP"),
            ("cardano", "ADA", "Cardano"),
        ]
        out: list[CryptoMarket] = []
        for rank, (cid, sym, name) in enumerate(coins[:limit], start=1):
            _, _, last, prev, vol = fixture(f"{sym}USDT")
            out.append(
                CryptoMarket(
                    id=cid,
                    symbol=sym,
                    name=f"{name} (DEMO)",
                    rank=rank,
                    price_usd=last,
                    change_24h_pct=round((last / prev - 1) * 100, 4),
                    change_7d_pct=round(-5 + 10 * _h(sym, "7d"), 4),
                    market_cap=round(last * 1e7 * (6 - rank)),
                    volume_24h=round(last * (vol or 1e5)),
                    last_updated=NOW,
                )
            )
        return out

    async def series(self, series_id: str) -> MacroSeries:
        self._net()
        if not series_id:
            raise NotFound("empty series id")
        base = 1 + 4 * _h(series_id)
        pts = [
            MacroPoint(
                date=(NOW - timedelta(days=30 * (24 - i))).date().isoformat(),
                value=round(base + 0.2 * math.sin(i / 3), 3),
            )
            for i in range(25)
        ]
        return MacroSeries(
            id=series_id, title=f"{series_id} (DEMO)", units="%", frequency="Monthly", data=pts
        )


# ---------------------------------------------------------------------------- ECO (DEMO)
# A fictional week around NOW (Monday 2026-11-09 14:30 UTC = 15:30 Copenhagen), mapped by the
# real data/symbology/eco_events.csv. Released today: DK CPI 08:00, EZ retail 11:00, US CPI
# 14:30 CPH; next: UMich at 16:00 CPH (30 minutes after NOW).


def eco_calendar_fixtures() -> list[CalEntry]:
    today = NOW.date()

    def d(n: int) -> date:
        return today + timedelta(days=n)

    cph = "Europe/Copenhagen"
    return [
        CalEntry(
            "dst",
            "Consumer price index and net retail price index",
            "Consumer price index and net retail price index",
            today,
            time_at(today, "08:00", cph),
            "2026-10",
        ),
        CalEntry("eurostat", "Retail trade", "Retail trade", today),
        CalEntry(
            "ecb_stat",
            "Euro area bank interest rate statistics",
            "Euro area bank interest rate statistics",
            today,
            time_at(today, "10:00", "Europe/Berlin"),
            "2026-09",
        ),
        CalEntry("fred", "10", "Consumer Price Index", today),
        CalEntry("fred", "91", "Surveys of Consumers", today),
        CalEntry(
            "dst",
            "Tourist nights in Denmark (monthly)",
            "Tourist nights in Denmark (monthly)",
            d(1),
            time_at(d(1), "08:00", cph),
            "2026-09",
        ),
        CalEntry("fed", "FOMC", "FOMC meeting", d(2)),
        CalEntry("fred", "180", "Unemployment Insurance Weekly Claims Report", d(3)),
        CalEntry(
            "bea",
            "Gross Domestic Product",
            "Gross Domestic Product",
            d(3),
            time_at(d(3), "08:30", "America/New_York"),
        ),
        CalEntry(
            "ecb_mp",
            "Governing Council of the ECB: monetary policy meeting (Day 2), followed by press "
            "conference",
            "ECB monetary policy meeting",
            d(3),
        ),
        CalEntry(
            "eurostat",
            "Flash estimate inflation euro area",
            "Flash estimate inflation euro area",
            d(4),
        ),
        CalEntry("eurostat", "Production in construction", "Production in construction", d(4)),
    ]


# spec -> (kind, base, step): "index" grows by `step` a month; "level" swings around `base`.
_ECO_SERIES: dict[str, tuple[str, float, float]] = {
    "fred:CPIAUCSL": ("index", 318.0, 0.0024),
    "fred:CPIAUCNS": ("index", 317.0, 0.0025),
    "fred:CPILFESL": ("index", 324.0, 0.0026),
    "fred:UMCSENT": ("level", 61.0, 2.5),
    "fred:ICSA": ("level", 221000.0, 6000.0),
    "fred:A191RL1Q225SBEA": ("level", 2.1, 0.6),
    "fred:DFEDTARU": ("rate", 4.0, 0.0),
    "ecb:FM/D.U2.EUR.4F.KR.DFR.LEV": ("rate", 2.0, 0.0),
    "dst:PRIS01?VAREGR=000000&ENHED=300": ("level", 2.1, 0.3),
}


def _months_back(n: int) -> tuple[int, int]:
    y, m = 2026, 10 - n  # the newest month in DEMO series is October 2026
    while m < 1:
        y, m = y - 1, m + 12
    return y, m


def eco_series_fixture(spec: str) -> MacroSeries:
    kind, base, step = _ECO_SERIES.get(spec, ("level", 0.2 + _h(spec), 0.3))
    fred = spec.startswith("fred:")
    pts: list[MacroPoint] = []
    if kind == "rate":
        for i in range(40, -1, -1):
            day = (NOW - timedelta(days=i)).date().isoformat()
            pts.append(MacroPoint(date=day, value=base))
    elif "GDP" in spec or "namq" in spec or "NKN1" in spec:
        for i in range(11, -1, -1):
            q = 3 - i  # the newest quarter is 2026-Q3
            y = 2026 + (q - 1) // 4
            qq = (q - 1) % 4 + 1
            label = f"{y}-{(qq - 1) * 3 + 1:02d}-01" if fred else f"{y}-Q{qq}"
            pts.append(MacroPoint(date=label, value=round(base + step * math.sin(i), 2)))
    else:
        for i in range(25, -1, -1):
            y, m = _months_back(i)
            label = f"{y}-{m:02d}-01" if fred else f"{y}-{m:02d}"
            if kind == "index":
                v = base * (1 + step) ** (25 - i) * (1 + 0.0008 * math.sin(i * 1.7))
            else:
                v = base + step * math.sin(i * 1.3)
            pts.append(MacroPoint(date=label, value=round(v, 3)))
    freq = "D" if kind == "rate" else ("Q" if len(pts) == 12 else "M")
    return MacroSeries(
        id=spec,
        title=f"{spec} (DEMO)",
        frequency=freq,
        data=pts,
        updated=NOW - timedelta(minutes=5),
    )


def fundamentals_fixture(symbol: str, period: str) -> tuple[list[str], str | None, list[Statement]]:
    """Synthetic statements (DEMO only): 5 fiscal years or 8 quarters ending 2026, steady
    growth with a symbol-dependent scale and margins. Not real company figures."""
    _, ccy, *_ = fixture(symbol)
    n = 5 if period == "annual" else 8
    if period == "annual":
        periods = [f"{2021 + i}-12-31" for i in range(n)]
    else:
        ends = ["03-31", "06-30", "09-30", "12-31"]
        periods = [f"{2024 + (i + 3) // 4}-{ends[(i + 3) % 4]}" for i in range(n)]
    scale = (5 + 95 * _h(symbol, "rev")) * 1e9 / (1 if period == "annual" else 4)
    gm, om = 0.35 + 0.3 * _h(symbol, "gm"), 0.12 + 0.15 * _h(symbol, "om")
    nm = om * 0.78
    series: dict[str, dict[str, float | None]] = {}

    def put(key: str, d: str, v: float) -> None:
        series.setdefault(key, {})[d] = round(v, 2)

    for i, d in enumerate(periods):
        rev = scale * (1.08 ** (i / (1 if period == "annual" else 4)))
        put("TotalRevenue", d, rev)
        put("CostOfRevenue", d, rev * (1 - gm))
        put("GrossProfit", d, rev * gm)
        put("OperatingIncome", d, rev * om)
        put("NetIncome", d, rev * nm)
        shares = 1e9 * (1 + 4 * _h(symbol, "sh"))
        put("DilutedAverageShares", d, shares)
        put("DilutedEPS", d, rev * nm / shares)
        assets = rev * (1.6 if period == "annual" else 6.4)
        put("TotalAssets", d, assets)
        put("CurrentAssets", d, assets * 0.4)
        put("CashAndCashEquivalents", d, assets * 0.12)
        put("TotalLiabilitiesNetMinorityInterest", d, assets * 0.55)
        put("CurrentLiabilities", d, assets * 0.25)
        put("StockholdersEquity", d, assets * 0.45)
        put("OperatingCashFlow", d, rev * (nm + 0.06))
        put("CapitalExpenditure", d, -rev * 0.04)
        put("FreeCashFlow", d, rev * (nm + 0.02))
    return periods, ccy, assemble_statements(series, periods, period)
