"""Constructs the provider set from settings and defines routing preferences."""

from __future__ import annotations

from ..config import Settings
from ..models import AssetClass, ProviderState, ProviderStatus
from .base import Capability, DataProvider
from .binance import BinanceProvider
from .calendars import BeaProvider, DstProvider, EcbStatProvider, EurostatProvider, FedProvider
from .coingecko import CoinGeckoProvider
from .ecb import EcbProvider
from .eodhd import EodhdProvider
from .finnhub import FinnhubProvider
from .fred import FredApiProvider
from .gdelt import GdeltProvider
from .massive import MassiveProvider
from .nbu import NbuProvider
from .rss import RssProvider
from .sec import SecEdgarProvider
from .treasury import TreasuryProvider
from .yahoo import YahooProvider

C, A = Capability, AssetClass

# Preferred provider order per (capability, asset class). Unlisted providers follow in
# registration order. Disabled providers (missing key) and opt-in providers the user has not
# enabled (yfinance) are skipped automatically, so with nothing enabled a value is N.A.
#
# Not in any live chain (SPEC §6.2, PROVIDERS.md §5): Alpha Vantage (25 req/day, rare backfills
# only), open.er-api.com (not a §6.2 source), FRED's undocumented fredgraph.csv endpoint.
PREFERENCES: dict[tuple[Capability, AssetClass], list[str]] = {
    (C.QUOTE, A.CRYPTO): ["binance", "yahoo"],
    (C.BARS, A.CRYPTO): ["binance", "yahoo"],
    (C.PROFILE, A.CRYPTO): ["binance", "yahoo"],
    (C.SEARCH, A.CRYPTO): ["binance", "yahoo"],
    # EU/Nordic: EODHD Free end-of-day closes (D13); the opt-in yfinance, when the user
    # switched it on, is fresher (intraday, D{n}) and spares EODHD's 18 calls a day.
    (C.QUOTE, A.EQUITY): ["finnhub", "yahoo", "eodhd"],
    # US bars: Massive Basic (2 years, previous session and older); EU/Nordic: EODHD.
    (C.BARS, A.EQUITY): ["yahoo", "massive", "eodhd"],
    # FX: official daily reference fixings (EOD); UAH pairs only from NBU (ECB has no UAH).
    # The opt-in yfinance, when on, is intraday and goes first.
    (C.QUOTE, A.FX): ["yahoo", "ecb", "nbu"],
    (C.PROFILE, A.EQUITY): ["finnhub", "yahoo"],
    (C.FILINGS, A.EQUITY): ["sec", "yahoo"],
    (C.FUNDAMENTALS, A.EQUITY): ["sec", "yahoo"],
    (C.MACRO, A.INDEX): ["fred"],
    # Index levels: yfinance (opt-in, intraday) first; else EODHD's close for the indices with
    # a checked EODHD code (OMXC25 and DAX first on its budget).
    (C.QUOTE, A.INDEX): ["yahoo", "eodhd"],
    (C.BARS, A.INDEX): ["yahoo", "eodhd"],
}


def build_providers(settings: Settings) -> list[DataProvider]:
    return [
        BinanceProvider(),
        FinnhubProvider(settings.finnhub_api_key),
        CoinGeckoProvider(settings.coingecko_api_key),
        RssProvider(settings.rss_feed_list),
        GdeltProvider(),  # company news outside North America
        SecEdgarProvider(settings.edgar_user_agent),
        TreasuryProvider(),
        FredApiProvider(settings.fred_api_key),
        EodhdProvider(settings.eodhd_api_key, settings.data_dir),
        MassiveProvider(settings.massive_api_key),
        EcbProvider(),
        NbuProvider(),
        YahooProvider(),  # opt-in, off by default (PDF toggle)
        # ECO: official release calendars (+ FRED release dates above), keyless
        BeaProvider(),
        FedProvider(),
        EurostatProvider(),
        EcbStatProvider(),
        DstProvider(),
    ]


DEMO_OFFLINE = "DEMO mode: fixtures only, no network"


def demo_offline_statuses(settings: Settings) -> list[ProviderStatus]:
    """The real providers as DEMO sees them: never called, so disabled. A real reason the user
    can act on (no key) is kept; otherwise the reason is DEMO itself, also for an opt-in source,
    whose PDF switch changes nothing in DEMO (review 1b #10). Built once, never used to fetch."""
    out: list[ProviderStatus] = []
    for p in build_providers(settings):
        st = p.status(opt_in_on=True)
        if st.state != ProviderState.DISABLED:
            st = st.model_copy(update={"state": ProviderState.DISABLED, "detail": DEMO_OFFLINE})
        out.append(st)
    return out
