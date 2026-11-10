/**
 * Notices and attributions the data providers require (SPEC §1.7, docs/PROVIDERS.md §4). Shown
 * on HELP → Data sources (`HELP SOURCES`). Texts quoted from a provider's terms are marked as
 * such in PROVIDERS.md; the FRED sentence is the one its API terms require verbatim.
 */

export interface Notice {
  source: string;
  /** What the app uses it for (SPEC §6.2). */
  use: string;
  text: string;
  links: { label: string; url: string }[];
  /** Opt-in source: the PDF toggle that switches it on (shown with its state). */
  optIn?: "yfinance";
}

export const FRED_NOTICE =
  "This product uses the FRED® API but is not endorsed or certified by the Federal Reserve Bank of St. Louis.";

export const NOTICES: readonly Notice[] = [
  {
    source: "FRED",
    use: "US macro series and release dates (memory only, never stored)",
    text: `${FRED_NOTICE} Series owned by third parties keep their own copyright; each chart cites its series.`,
    links: [
      { label: "FRED API terms", url: "https://fred.stlouisfed.org/docs/api/terms_of_use.html" },
    ],
  },
  {
    source: "Tiingo",
    use: "US live secondary: derived reference price",
    text:
      "Values tagged RT·REF are a reference price from Tiingo (derived by Tiingo, not exchange " +
      "prints); estimated bid/ask is marked est. Kept in memory for the session only.",
    links: [{ label: "tiingo.com", url: "https://www.tiingo.com/" }],
  },
  {
    source: "Wikipedia",
    use: "Index member lists",
    text:
      "Member lists come from community-edited Wikipedia articles, licensed CC BY-SA 4.0, " +
      "converted to CSV by this app. Each list links to the article revision it was read from.",
    links: [
      { label: "CC BY-SA 4.0", url: "https://creativecommons.org/licenses/by-sa/4.0/" },
      {
        label: "Reusing Wikipedia content",
        url: "https://en.wikipedia.org/wiki/Wikipedia:Reusing_Wikipedia_content",
      },
    ],
  },
  {
    source: "yfinance",
    use: "Opt-in fallback for non-US prices, indices, futures, fundamentals",
    text:
      "Unofficial source, enabled by you, personal use. Every value from it is marked PERSONAL " +
      "USE. Yahoo Finance data must not be redistributed and is not meant for trading decisions.",
    links: [
      { label: "Yahoo data delays (SLN2310)", url: "https://help.yahoo.com/kb/SLN2310.html" },
      { label: "yfinance", url: "https://pypi.org/project/yfinance/" },
    ],
    optIn: "yfinance",
  },
  {
    source: "CoinGecko",
    use: "Crypto market caps",
    text: "Powered by CoinGecko.",
    links: [{ label: "coingecko.com", url: "https://www.coingecko.com/" }],
  },
  {
    source: "GDELT",
    use: "Company news outside North America (headlines and links only)",
    text: "Article lists from the GDELT Project.",
    links: [{ label: "gdeltproject.org", url: "https://www.gdeltproject.org/" }],
  },
  {
    source: "BEA · Federal Reserve",
    use: "US release schedules (ECO): BEA release dates, FOMC meeting dates",
    text:
      "Source: U.S. Bureau of Economic Analysis release schedule; Board of Governors of the " +
      "Federal Reserve System, FOMC meeting calendar. BLS, Census and Fed release dates come " +
      "from FRED: BLS refuses automated access that does not carry the user's contact details.",
    links: [
      { label: "bea.gov", url: "https://www.bea.gov/news/schedule" },
      {
        label: "federalreserve.gov",
        url: "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm",
      },
    ],
  },
  {
    source: "ECB",
    use: "FX reference rates, euro yield curves, ECO calendars and series",
    text: "Source: European Central Bank Data Portal. Derived values are labelled as derived.",
    links: [{ label: "data.ecb.europa.eu", url: "https://data.ecb.europa.eu/" }],
  },
  {
    source: "Eurostat · Statistics Denmark · World Bank · NBU",
    use: "Macro, ECO calendars and series, official UAH rates",
    text: "Source citation shown with each series. Derived values are labelled as derived.",
    links: [
      { label: "Eurostat", url: "https://ec.europa.eu/eurostat" },
      { label: "Statistics Denmark", url: "https://www.dst.dk/en" },
      { label: "World Bank", url: "https://data.worldbank.org/" },
      { label: "National Bank of Ukraine", url: "https://bank.gov.ua/en/" },
    ],
  },
  {
    source: "EODHD",
    use: "EU/Nordic end-of-day closes and index levels (Free plan: at most 18 a day; OMXC25 and DAX first)",
    text:
      "Source: EODHD (EOD Historical Data). End-of-day closes, stored locally for your private " +
      "use; not redistributed.",
    links: [{ label: "eodhd.com", url: "https://eodhd.com/" }],
  },
  {
    source: "Massive",
    use: "US bar history (Stocks Basic: two years, up to the previous session)",
    text:
      "Source: Massive (formerly Polygon.io). Split-adjusted bars, stored locally for your " +
      "private use within the plan's two-year window; not redistributed.",
    links: [{ label: "massive.com", url: "https://massive.com/" }],
  },
  {
    source: "SEC EDGAR",
    use: "US fundamentals, filings, insiders, US ticker list",
    text: "Source: U.S. Securities and Exchange Commission (EDGAR).",
    links: [{ label: "sec.gov/edgar", url: "https://www.sec.gov/edgar" }],
  },
  {
    source: "U.S. Treasury",
    use: "US daily par yield curve",
    text: "Source: U.S. Department of the Treasury, daily par yield curve rates.",
    links: [{ label: "home.treasury.gov", url: "https://home.treasury.gov/" }],
  },
  {
    source: "lightweight-charts",
    use: "Charts (not a data provider)",
    text: "Charts are drawn with TradingView lightweight-charts (Apache-2.0); its attribution stays on every chart.",
    links: [
      {
        label: "lightweight-charts",
        url: "https://github.com/tradingview/lightweight-charts",
      },
    ],
  },
];

export function noticeFor(source: string): Notice | undefined {
  const s = source.toLowerCase();
  return NOTICES.find((n) => n.source.toLowerCase() === s || n.source.toLowerCase().includes(s));
}
