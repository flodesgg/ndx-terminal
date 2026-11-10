# Data providers — verified facts

**Checked: 2026-11-09** against official documentation, pricing pages and terms (SPEC §1 rule 7,
§6.2). Every limit below cites where it came from. "Not documented" means we looked on the official
pages listed and found no number; values marked *self-imposed* are our own conservative budgets,
not provider facts. Re-verify any row older than ~6 months before building on it.

Method: the official docs/terms of each provider were read (no keys, no sign-ups, at most one
anonymous GET to a public endpoint), then every cited page was re-opened to check each number and
terms claim (verdicts: confirmed / corrected / unverifiable). Only confirmed or corrected values
are stated as facts here.

**Updated 2026-11-09 for SPEC v3.1** (decisions after Phase 0): Alpaca not used (I am in
Denmark); replacements in §3.17–3.22; EU/Nordic default chosen 2026-11-09 (§8); options: opt-in yfinance only (2026-11-10, §3.20).

Use is **personal, single-user, non-commercial**. Nothing fetched from these providers may be
redistributed, exported for others, or committed to the repo unless the row says it is allowed.

---

## 1. Findings that contradict or refine the spec (need a decision)

| # | Finding | Evidence | Affects |
|---|---|---|---|
| P1 | **Yahoo's ToS forbid automated collection** (bots/scrapers) without express permission and access other than through Yahoo's own interfaces. yfinance and the raw `query1/query2` JSON endpoints are unofficial and not sanctioned by Yahoo. The spec relies on yfinance as *primary* for EU/Nordic/indices/futures/FX. | [Yahoo ToS §2(d)(9), §2(e)](https://legal.yahoo.com/us/en/yahoo/terms/otos/index.html) (last updated 2026-11-01); [SLN2310](https://help.yahoo.com/kb/SLN2310.html) (no redistribution, informational only) | §6.2 rows 2–3, fundamentals, options, calendars |
| P2 | **Yahoo delays are per exchange, not a blanket D15.** Copenhagen, Stockholm, Helsinki, Nasdaq US, Cboe UK and FX `=X` are listed as real-time (via ICE Data Services); London/Tokyo 20 min; SIX 30; CME/CBOT 10; NYMEX/COMEX/ICE US 30; Oslo, Xetra, Paris, Amsterdam, HKEX 15. NYSE-listed stocks have no row (delay undocumented). "Real-time" is never defined (venue vs consolidated). | [SLN2310](https://help.yahoo.com/kb/SLN2310.html) | §6.1 needs `Dn` (D10/D15/D20/D30) and a label for "real-time via redistributor" |
| P3 | **FRED's site terms prohibit storing, caching or archiving FRED content** (also for personal use), while the separate API terms page does not mention caching. The two official pages are inconsistent; the stricter one conflicts with §6.3 caches, DuckDB/Parquet and offline mode. FRED API use also requires a prominent "uses the FRED® API but is not endorsed or certified by the St. Louis Fed" notice. | [fred.stlouisfed.org/legal](https://fred.stlouisfed.org/legal/) (Full Terms prohibition p); [API terms](https://fred.stlouisfed.org/docs/api/terms_of_use.html) | §6.3 cache/offline for `US2Y/US10Y/US30Y`, ECO, YC |
| P4 | **Alpaca eligibility is unclear for a Denmark-based user.** The T&C (still linked as current) say content is intended for US residents only; the paper-trading page says anyone globally can open a paper-only account, and that paper-only holders are entitled to **IEX data only** — which contradicts the spec's "free full-market history except the latest 15 min" for a paper-only account. Alpaca's own pages also disagree on SIP history without a subscription. | [T&C PDF](https://files.alpaca.markets/disclosures/library/TermsAndConditions.pdf); [about-market-data-api](https://docs.alpaca.markets/docs/about-market-data-api); [market-data FAQ](https://docs.alpaca.markets/us/docs/market-data-faq); [historical-stock-data](https://docs.alpaca.markets/docs/historical-stock-data-1) | §6.2 rows 1–2 (US live secondary, US bars primary), options |
| P5 | **Finnhub free tier has no international data and no candles at all** (US candles included), and no forex rates/candles. So "Finnhub REST as secondary for EU/Nordic/FX" does nothing on the free plan. WebSocket: 50 symbols, **one connection per key**. | [pricing](https://finnhub.io/pricing) (rendered bundle); [websocket-trades](https://finnhub.io/docs/api/websocket-trades); [stock-candles](https://finnhub.io/docs/api/stock-candles) | §6.2 row 3; streaming hub caps |
| P6 | **ECB EXR has no UAH** (29 currencies; EUR/RUB suspended since 2022-03-01). NBU is the *only* official UAH source, not an optional secondary (EURUAH is in the §8 FX seed list). | [ECB euro reference rates](https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html); [NBU API](https://bank.gov.ua/en/open-data/api-dev) | §6.2 FX reference |
| P7 | **Economic-calendar sources are uneven:** BLS (ICS) and BEA (ICS + JSON) and Eurostat (ICS) are machine-readable; the **ECB statistical calendar and Statistics Denmark's release calendar are HTML only** (scraping + contract tests); FRED release dates need an API key and a flag to show future dates. Eurostat is missing from the spec's calendar row. | see §3.9 rows | `ECO` (Phase 3) |
| P8 | **SEC EDGAR full-text search has no documented API** (only the web UI; `efts` is undocumented). Form 4 insiders must be parsed from submissions + filing XML (or the quarterly Insider Transactions data sets). | [efts FAQ](https://www.sec.gov/edgar/search/efts-faq.html); [EDGAR APIs](https://www.sec.gov/search-filings/edgar-application-programming-interfaces) | `CF` / `INS` |
| P9 | **Seed/index files may not be committed.** Nasdaq Trader allows one unaltered personal copy and forbids storing/redistribution without consent; SSGA (SPY) forbids reproduction; Invesco (QQQ) forbids robots/data-mining and downloading without consent; OMXC25 weights need a Nasdaq login. → Fetch at runtime into the local data dir (never commit), curate the C25 list by hand from public review announcements, and treat QQQ holdings as **not usable** without consent. SEC `company_tickers.json` is public and may be committed. | [Nasdaq Trader copyright](https://www.nasdaqtrader.com/trader.aspx?id=copydisclaimmain); [SSGA terms](https://www.ssga.com/us/en/intermediary/terms-of-use); [Invesco terms](https://www.invesco.com/us/contentdetail?contentId=258d54c4a0561410VgnVCM100000c2f1bf0aRCRD&audienceType=Investor); [OMXC25 weighting](https://indexes.nasdaqomx.com/Index/Weighting/OMXC25) | §5 seed data ("committed with a last reviewed date"), `MEMB`, `IMAP`, `EQS` |
| P10 | **Attribution notices are mandatory** for several sources (FRED, BEA, CoinGecko, ExchangeRate-API, GDELT; source citation for ECB, Eurostat, DST, World Bank, NBU, SEC, BLS). The spec only requires a per-value source tag. → An About/HELP "Data sources & notices" page plus per-panel credits where required. | §4 below | §1.3, `HELP` |
| P11 | **§6.1 has no tag for non-ticking data** (filings, fundamentals, calendars, news, aggregated snapshots like CoinGecko). v1 used `STATIC`. Proposal: `CACHE hh:mm` + the record's own timestamp as `as_of`; STALE computed from each series' release frequency (monthly/quarterly macro would otherwise always be STALE). | various | §6.1 |
| P12 | **Binance limits are weight-based per IP** (6000 weight/min live on 2026-11-09), not request counts; v1's 600 req/min bucket could reach 4× the limit with batch tickers. Binance.com bars US residents; whether Denmark/EEA is restricted for market-data API use could not be confirmed (terms pages are JS-rendered). | [limits](https://developers.binance.com/docs/binance-spot-api-docs/rest-api/limits); live `exchangeInfo` | crypto adapter |

---

**Resolutions (SPEC v3.1, decisions 2026-11-09):**
P1 → yfinance opt-in, off by default, `PERSONAL USE` marker (2026-11-10: also a limited mode `PDF YFINANCE DK` — Danish stocks and all indices only, EODHD stays the fallback) · P2 → generic `D{n}` tags · P3 → FRED kept in
memory only (short TTL, never on disk, never offline), US yields from Treasury, not-endorsed notice on HELP ·
P4 → Alpaca dropped · P5 → Finnhub REST removed from the EU/Nordic row · P7 → calendar row lists Eurostat ICS
and HTML-only ECB/DST · P8 → no full-text search · P9 → seeds downloaded at runtime, ETF issuer files only via
manual CSV import · P10 → HELP "Data sources" page · P11 → adopted in SPEC §6.3.

New findings from the replacement search (2026-11-09):

| # | Finding | Evidence |
|---|---|---|
| P13 | **Tiingo Starter (free) data may not be persisted at all** — only volatile memory or a temporary cache cleared before the session ends; databases, logs and backups are banned. Paid plans must delete everything, backups included, when the plan ends. | [Tiingo ToS §1.6](https://app.tiingo.com/tos/) (last updated 2026-11-05) |
| P14 | **iShares (IVV) US site terms forbid robots/automatic download**, like Invesco (QQQ). SSGA (SPY) forbids reproduction. → no automated ETF-issuer holdings at all; members from Wikipedia + SEC N-PORT, issuer files via manual CSV import. | iShares terms ("Use any robot, spider, intelligent agent, other automatic device"); P9 |
| P15 | **No source at ≤ ~$10/month with clean terms covers EU/Nordic stocks, indices, futures and FX intraday.** Cheapest clean full option is EODHD All World at $19.99/month; exchange MiFIR delayed files are free but raw trades only, and Nasdaq Nordic needs prior written approval. → §8. | §3.19, §3.21 |
| P16 | **Without yfinance there is no free default for index levels (SPX, OMXC25, DAX…) or continuous futures (CL1, GC1…).** They show `N.A.` until a source is picked. | §3.19, §3.21 |
| P17 | **EODHD Free does serve index EOD levels** (`OMXC25.INDX`, checked with the key 2026-11-09), which refines P16/SPEC §6.2 ("index levels → N.A."). **Decision 2026-11-09:** OMXC25 and DAX have first claim on the budget (a call stays reserved for each until fetched for the session); other indices with a checked code use what is left. Codes checked against EODHD's `exchange-symbol-list/INDX` (1,681 rows; one call): OMXC25.INDX, GDAXI.INDX, STOXX50E.INDX, FCHI.INDX, AEX.INDX, SSMI.INDX, OMXS30.INDX; **FTSE 100 is not in the list**. Stored in `data/symbology/indices.csv` (`eodhd`, `calendar`). EU/Nordic indices only (D13). Real check: DAX 2026-11-09 close fetched end to end (`EOD`, as_of 16:30 UTC). Intraday index levels and futures stay `N.A.` without yfinance. | §3.19 |

---

## 2. Spec §6.2 rows → providers

| §6.2 domain | Primary | Secondary | Verified reality on free tiers | Tag |
|---|---|---|---|---|
| US stocks/ETFs live | Finnhub WS trades — 50 symbols, 1 connection/key | Tiingo 24x5 WS (Starter, free; P13 memory only) | Consolidated quotes not free; Finnhub bid/ask premium → `N.A.`; Tiingo bid/ask is estimated | `RT·TRD` / `RT·REF` |
| US bars history | Massive Stocks Basic — 1m–1d, 2 years, previous session and older, 5 calls/min | opt-in yfinance (P1) | Today's bars refused on Basic (HTTP 403) → build today only from received trade prints | `EOD` / `CACHE` |
| EU/Nordic stocks, indices, futures, FX intraday | **EODHD Free** (my choice 2026-11-09, §8) — 20 calls/day, 1 year EOD | opt-in yfinance (P1, P2) | No intraday on Free; nothing clean at ≤ ~$10 covers all (P15, P16) | `EOD` / `N.A.` |
| Crypto | Binance WS + REST | Coinbase public WS; CoinGecko for market caps | CoinGecko is an aggregated cached snapshot, not RT | `RT` (venues); `CACHE` (CoinGecko) |
| FX reference | ECB Data Portal EXR (no UAH) | NBU (only official UAH; P6) | Reference fixings, once per business day | `EOD` ("ECB/NBU reference rate") |
| Rates & curves | US Treasury par curve | ECB yield curves (12:00 CET) | Official once-daily; FRED not used (P3) | `EOD` |
| Macro | FRED/ALFRED (memory only, P3), ECB, Eurostat, Statistics Denmark | World Bank | Low frequency; no consensus anywhere | `EOD` + frequency-aware STALE (P11) |
| Economic calendar | BLS ICS, BEA ICS/JSON, Eurostat ICS, FRED release dates (key), ECB & DST (HTML) | — | No official source publishes consensus → survey `N.A.` (confirmed) | `CACHE hh:mm` |
| Fundamentals | SEC XBRL companyfacts | opt-in yfinance (P1) | US registrants; us-gaap/ifrs/dei/srt facts only | `CACHE` / as_of = filing |
| Filings, insiders | SEC EDGAR submissions + Form 4 XML | — | No FTS API (P8); UA with contact; ≤10 req/s | `CACHE` / as_of = acceptance |
| Earnings/IPO calendars | Finnhub (earnings: US, 1 month history on free; IPO: no free-tier note) | opt-in yfinance (P1) | Finnhub dividends/splits premium | `CACHE` |
| Options (Phase 6) | **opt-in yfinance only** (decision 2026-11-10, §3.20) | — | OPRA via Yahoo 15 min; Greeks/IV only as Yahoo states them; off → `N.A.` | `D15` + `PERSONAL USE` |
| News | Finnhub company (North America only, 1 y) + market news (REST; WS news premium) | RSS (terms unverified, §3.14), GDELT (no summary field) | Headline + summary + link only | publisher time + `CACHE` |
| Index members | Wikipedia constituent lists via MediaWiki API (CC BY-SA 4.0) | SEC N-PORT of an index fund (lagging); curated C25 CSV; manual CSV import of issuer files (P14) | Wikipedia follows index changes within ~1–5 days; N-PORT lags ~2 months | `EOD`, as_of = revision / report date |

---

## 3. Provider details

Format per provider: **Auth** · **Limits** (→ bucket we use) · **Caps** · **Coverage/delay → tag** ·
**Terms & attribution** · **Endpoints** · **v1** · **Open questions**.

### 3.1 Finnhub — US live (WS), news, earnings/IPO calendars
- **Auth:** free key from a Finnhub account; REST via `X-Finnhub-Token` header (preferred, keeps the key out of URLs/logs) or `token=`; WS `wss://ws.finnhub.io?token=…`. [auth](https://finnhub.io/docs/api/authentication)
- **Limits:** free 60 calls/min ([pricing](https://finnhub.io/pricing), read from the page's rendered bundle) plus 30 calls/s on all plans; HTTP 429 on excess ([rate-limit](https://finnhub.io/docs/api/rate-limit), [ToS](https://finnhub.io/terms-of-service)). No daily/monthly quota documented. → bucket **55/min, burst 10** (*self-imposed*).
- **Caps:** WS free **50 symbols**, **1 connection per key**. `/quote` is single-symbol; no batch quote.
- **Coverage → tag:** WS trades for US stocks (docs title names "US Full SIP", but the free-tier feed is not stated) → `RT·TRD`; v=0 messages are price updates, not trades. `/quote` real-time US last trade → `RT·TRD` at fetch, `CACHE`/`STALE` after. Free: `/stock/profile2` (US), `/company-news` (North American companies, 1 y), `/news`, `/calendar/earnings` (US, 1 month), `/calendar/ipo`, `/stock/insider-transactions`, `/stock/filings`. **Premium:** candles (all), tick, bid/ask, forex rates/candles, crypto candles, index constituents, economic calendar, dividends, splits, ETF holdings, WS news.
- **Terms:** personal use only; no redistribution or sharing of data or derived results without written approval; delete data when the subscription ends; non-professional status. No attribution requirement found. [ToS](https://finnhub.io/terms-of-service)
- **v1:** REST only (`providers/finnhub.py`), key in query string (`:116`), 55/min; labelled `REALTIME`. No WS client. Key currently empty in `.env`.
- **Open:** whether free WS includes LSE/FX/crypto; extended-hours prints; WS heartbeat rules.
- **Recorded with my key 2026-11-09 13:40–13:41 ET (market open), `tests/fixtures/finnhub_ws_trades.json`:** 60 trade rows in 45 s for AAPL (40), MSFT (19), SPY (1), delivered in bursts; **exact duplicate rows** and **rows out of time order** within and across messages; one `{"type":"ping"}`; no error for an unknown symbol (it is simply silent); `unsubscribe` stops the flow; conditions mostly `["1","8"]`. One busy ETF printing once in 45 s means the free feed is a **sparse sample of prints, not the full tape** — so not consolidated last-sale either.
- **Adapter (Phase 2 step 2.5, `providers/finnhub_ws.py`):** one connection per key, opened only while symbols are wanted, closed when none are (the key's single connection is free otherwise); per-symbol subscribe/unsubscribe 50 ms apart; cap 50 by the hub's focus → watch → rotation priority. Shown price = the print with the **newest trade time**; a later-arriving older print is dropped; v=0 rows ignored. `BRK-B` ↔ `BRK.B`. Tag `RT·TRD`, source "Finnhub (stream)", `stale_after_s` 120 (*self-imposed*: a quiet minute is normal on this feed). The key is in the URL, so the `websockets` logger is held at WARNING and every stored error has the key replaced by `<key>`.

### 3.2 Alpaca Market Data — **not used** (SPEC v3.1)
Dropped by decision on 2026-11-09: the T&C carry a "U.S. Residents Only" clause and paper-only
accounts get IEX data only (P4); I am in Denmark. Its three roles moved to Tiingo (US live
secondary, §3.17), Massive (US bars, §3.18) and opt-in yfinance for options (§3.20). Facts as checked
on 2026-11-09 are kept in git history (commit 8477db7).

### 3.3 yfinance (library) and Yahoo Finance (data behind it)
- **Status (SPEC v3.1): opt-in, off by default, PERSONAL USE.** Enabled only by the user's toggle in `PDF`; every value shows a dim `PERSONAL USE` marker and the hover card says the source is unofficial and was enabled by the user. With the toggle off, rows it would fill show `N.A.`.
- **Auth:** none; cookie + crumb handled inside yfinance. Endpoints are undocumented.
- **Version:** yfinance **1.8.0** is the latest on PyPI (2026-11-03), Apache-2.0. [PyPI](https://pypi.org/project/yfinance/)
- **Limits:** none documented by Yahoo or yfinance; 429 → `YFRateLimitError`; community reports of multi-hour blocks. → bucket **60/min, burst 10** (*self-imposed*, lower than v1's 240/min), batch symbols, long TTLs, circuit breaker. yfinance's 1.8.0 release notes warn `Tickers.calendar`/`.info` can trigger blocks — keep them out of live paths.
- **Caps:** none documented (v1 sends 50 symbols per quote call — its own choice).
- **Coverage → tag:** per exchange, see P2 ([SLN2310](https://help.yahoo.com/kb/SLN2310.html)). Options (OPRA) 15 min → `D15`. Daily bars/fundamentals → `EOD`.
- **Terms:** P1. Additionally: Yahoo data must not be redistributed and is not meant for trading decisions (SLN2310); no competing databases/feeds (ToS §2(d)(10)). yfinance itself says it is for research/educational use and points to Yahoo's terms.
- **v1:** does **not** use the public yfinance API: imports private `yfinance.data.YfData` and calls `/v7/finance/quote`, `/v8/finance/chart`, `/v10/finance/quoteSummary`, `/v1/finance/search`, fundamentals-timeseries, `/v1/finance/visualization` (econ calendar), `/v1/finance/screener` (`providers/yahoo.py:386-527`, `yahoo_research.py:429-492`). `pyproject.toml` has `yfinance>=1.8.0` (lower bound; only `uv.lock` pins 1.8.0). Labels `REALTIME` when Yahoo's undocumented `quoteSourceName` says so.
- **Open:** NYSE delay; meaning of Yahoo "real-time"; whether Yahoo's Developer API terms cover Finance endpoints.

### 3.4 Binance — crypto primary
- **Auth:** none for market data. `data-api.binance.vision` / `data-stream.binance.vision` are **official** market-data-only endpoints (not a mirror). [market_data_only FAQ](https://developers.binance.com/docs/binance-spot-api-docs/faqs/market_data_only)
- **Limits (per IP):** live `exchangeInfo` on 2026-11-09: `REQUEST_WEIGHT` **6000/min**, `RAW_REQUESTS` 300 000/5 min. Weights: ticker/24hr 2 (1–20 symbols) / 40 (21–100) / 80 (101+ or none); klines 2; exchangeInfo 20. 429 → back off (Retry-After); repeated → 418 ban 2 min–3 days. WS: **5 incoming msgs/s per connection** (incl. ping/pong/control), 300 connection attempts/5 min/IP, 24 h connection life, server ping every 20 s. → budget **3000 weight/min** (*self-imposed*), read limits from `exchangeInfo` at startup. [limits](https://developers.binance.com/docs/binance-spot-api-docs/rest-api/limits), [WS streams](https://raw.githubusercontent.com/binance/binance-spot-api-docs/master/web-socket-streams.md)
- **Caps:** **1024 streams per WS connection**; ≤100 symbols per ticker request.
- **Coverage → tag:** Binance spot venue, `@ticker` every 1 s, klines every 2 s → `RT`. Pairs are USDT-quoted: label "quoted in USDT".
- **Terms:** could not be read (JS-rendered); US residents barred (official blog). Assume personal display only, no redistribution.
- **v1:** `providers/binance.py` + `live.py` BinanceFeed; counts requests (600/min) not weight; no 100-symbol chunking; no 1024-stream cap.
- **Open:** DK/EEA restrictions; full Terms of Use text.

### 3.5 Coinbase — crypto secondary
- **Auth:** none for public channels (Advanced Trade `wss://advanced-trade-ws.coinbase.com`: ticker, ticker_batch, candles, level2, market_trades, heartbeats). [overview](https://docs.cdp.coinbase.com/coinbase-app/advanced-trade-apis/websocket/websocket-overview)
- **Limits:** Advanced Trade 8 connections/s and 8 unauthenticated msgs/s per IP; subscribe within 5 s; channels close after 60–90 s idle unless `heartbeats` is subscribed. Exchange feed: 10 subscriptions per product per channel. [rate limits](https://docs.cdp.coinbase.com/coinbase-app/advanced-trade-apis/websocket/websocket-rate-limits)
- **Caps:** product ids per subscription not documented.
- **Coverage → tag:** Coinbase venue, ticker per match → `RT`; ticker_batch every 5 s (STALE after 10 s).
- **Terms:** market-data terms (dated 2023-02-06, page returned 403; read via search snippets): personal/research use; **no creating indexes or benchmarks**, no AI/ML training, no redistribution. [market data terms](https://www.coinbase.com/legal/market_data)
- **Recorded 2026-11-09 (Phase 2 step 2.3, keyless):** subscribing `ticker` for BTC-USD, ETH-USD and a made-up product returned one `snapshot` per real product (price, `volume_24_h`, `low/high_24_h`, `low/high_52_w`, `price_percent_chg_24_h`, best bid/ask and sizes), a `subscriptions` echo without the made-up product (no error), then `update`s on matches and `heartbeats` every second. The channel docs give no message examples and no product-id limit (→ cap 50, *self-imposed*).
- **Adapter:** `server/ndx_server/providers/coinbase_ws.py`, a `SymbolFeed` the hub uses only while the Binance stream is failing (from a failed connection until the next successful one). Our crypto symbols are Binance stablecoin pairs; Coinbase's book is `BASE-USD`, so every value carries "quoted in USD, not USDT". Tag `RT` (one venue's own book); change = the stated 24 h % in price units; previous close `N.A.` (not stated). No REST fallback (not verified, not needed for the secondary role).

### 3.6 CoinGecko — market caps
- **Auth:** keyless public API, or free **Demo** key via `x-cg-demo-api-key` header (query param leaks into logs).
- **Limits:** Demo **100 calls/min** and **10 000 calls/month** (raised from 30/min on 2026-05-17); keyless ~5/min, shared per IP, **not for scheduled polling**. All requests count toward the per-minute limit. [pricing](https://www.coingecko.com/en/api/pricing), [errors](https://docs.coingecko.com/docs/errors-and-rate-limits), [keyless](https://docs.coingecko.com/docs/keyless-public-api) → bucket **30/min** plus a **monthly counter** (a 120 s refresh left open 24/7 is ~21.6k calls/month, over the cap).
- **Caps:** `/coins/markets` per_page ≤ 250.
- **Coverage → tag:** aggregated across exchanges, update frequency undocumented → `CACHE hh:mm`, never `RT`.
- **Terms:** attribution **"Powered by CoinGecko"** (+ logo link) near the data; caching discouraged, refresh at least every 24 h, delete on termination; no redistribution. [API terms](https://www.coingecko.com/en/api_terms), [attribution guide](https://brand.coingecko.com/resources/attribution-guide)
- **v1:** keyless by default, 10/min, labelled `DELAYED 1m`; no attribution.

### 3.7 ECB Data Portal — FX reference (EXR), euro yield curves (YC)
- **Auth:** none. SDMX 2.1 REST at `https://data-api.ecb.europa.eu/service/data/{flow}/{key}`. [API](https://data.ecb.europa.eu/help/api/data)
- **Limits:** not documented (no 429 among listed status codes). → bucket **30/min** (*self-imposed*); use `updatedAfter` / `If-Modified-Since`.
- **Caps:** none documented; keys support wildcards and `+` OR.
- **Coverage → tag:** EXR: 29 currencies vs EUR, **no UAH/RUB**; reference rates from a ~14:10 CET concertation, published ~16:00 CET, "for information only" → `EOD`, tooltip "ECB reference rate". YC: published 12:00 CET on TARGET business days → `EOD`. STALE after > 2 TARGET business days.
- **Terms:** free reuse with source cited ("Source: ECB statistics"); statistics must not be modified → derived/inverted rates labelled as derived. [disclaimer](https://www.ecb.europa.eu/services/using-our-site/disclaimer/html/index.en.html), [ESCB reuse policy](https://www.ecb.europa.eu/stats/ecb_statistics/governance_and_quality_framework/html/usage_policy.en.html)
- **Statistical calendar:** HTML only (no ICS/CSV) → scraping. [statscal](https://www.ecb.europa.eu/press/calendars/statscal/html/index.en.html)
- **Checked 2026-11-09 (Phase 2 step 2.2):** one keyless request `EXR/D..EUR.SP00.A?lastNObservations=2&format=csvdata&detail=dataonly` returns every currency's last two fixings — 29 live ones plus stopped series (ARS last fixed 2020-10-30, legacy euro-area currencies, RUB) that still answer; we drop any series not fixed for 14 days. The 2026-11-09 fixings were in at 18:40 UTC. Typical answer 0.5–1 s, but 1 of 6 sampled requests (and 2 live-checks) got **HTTP 504 after ~30 s** from the ECB gateway → 12 s client timeout and retries (router; live-check retries once and says so). Series titles say "2:15 pm (C.E.T.)" → `as_of` = fixing date 14:15 CET.
- **Adapter:** `server/ndx_server/providers/ecb.py` (FX quotes, `EOD`): EUR/xxx as published; inverses and crosses labelled "derived from ECB euro reference rates"; refetch after the next publication (16:15 CET), hourly while a weekday's fixing is late, until 20:00 CET. One request serves every pair; the 30/min budget counts real requests. Euro yield curves (YC) are Phase 3.
- **Checked 2026-11-10 (Phase 3 step 2, ECO):** statistical calendar
  `press/calendars/statscal/html/index.en.html` is a `<dl>`: `<dt>dd/mm/yyyy HH:MM [<br>Tentative]`
  (Frankfurt time), `<dd>Title (Dataset: X)<br>Reference period: Oct-2026`. Meetings page
  `press/calendars/mgcgc/html/index.en.html`: dates only; we take "monetary policy meeting … (Day 2)"
  and use the standard 14:15 Frankfurt decision time (marked `*`). SDMX `FM/D.U2.EUR.4F.KR.DFR.LEV`
  (deposit facility rate) answers keyless; one of five calls timed out. **ICP (HICP) stopped at
  2025-12** (ECOICOP v2 switch) → HICP comes from Eurostat `prc_hicp_minr` (§3.11). Adapter
  `providers/calendars.py` `EcbStatProvider` ("ecbstat": its own self-imposed bucket, 20/min, so
  calendar pages never starve the FX fixings).

### 3.8 National Bank of Ukraine — UAH official rates
- **Auth:** none. `https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange?json` (+ `valcode`, `date`). [API](https://bank.gov.ua/en/open-data/api-dev)
- **Limits:** not documented → **10/min** (*self-imposed*).
- **Coverage → tag:** one official rate per business day → `EOD`. After 15:30 the "current" endpoint returns the **next** business day's rate: take `as_of` from `exchangedate`. A separate 12:00 USD/EUR reference rate exists; the tooltip must say which one is shown.
- **Terms:** cite the source; modifications need NBU approval → derived crosses labelled as derived. [terms](https://bank.gov.ua/en/useterms)
- **Checked 2026-11-09 (Phase 2 step 2.2):** at ~19:40 Kyiv time the plain endpoint answered with `exchangedate` 10.11.2026 (tomorrow), 45 currencies; `&date=20261108` (a Sunday) returned a rate dated 08.11 → NBU sets a rate for every calendar day.
- **Adapter:** `server/ndx_server/providers/nbu.py` (UAH pairs only, `EOD`): the rate in effect today (`date=` today in Kyiv) and the day before (for the change) — two requests a day, refreshed after Kyiv midnight; `as_of` = effective date 00:00 Kyiv; UAH/xxx labelled as derived (inverse). Only the official daily rate is used, not the separate 12:00 reference rate.

### 3.9 FRED / ALFRED — rates (`DGS*`), macro, release dates
- **Auth:** free API key required on every request (32 chars, `api_key`). [api_key](https://fred.stlouisfed.org/docs/api/api_key.html)
- **Limits:** **120 requests/min**, then 429 / temporary block; no daily quota documented. [errors](https://fred.stlouisfed.org/docs/api/fred/errors.html) → bucket **100/min**.
- **Coverage → tag:** official series at source release; `DGS*` daily on business days → `EOD`; ALFRED vintages via `realtime_start/end`. `fred/releases/dates` needs `include_release_dates_with_no_data=true` for future dates.
- **Terms:** P3 (caching conflict; mandatory not-endorsed notice; no FRED logos; third-party copyrighted series need the owner's permission beyond personal use; no ML training). [API terms](https://fred.stlouisfed.org/docs/api/terms_of_use.html), [legal](https://fred.stlouisfed.org/legal/)
- **Status (SPEC v3.1):** macro and release dates only; values kept **in memory only**, short TTL, never written to DuckDB/SQLite/disk, never served offline; not used for US yields (Treasury, §3.10). HELP shows the not-endorsed notice.
- **v1:** `providers/fred.py` (API, key empty → disabled) with keyless fallback to `fredgraph.csv`, which is **not a documented endpoint** (grey area under the bot clause); 3 h macro cache.
- **Checked 2026-11-10 (Phase 3 step 2, ECO):** `fred/releases/dates` for −7…+40 days with
  `include_release_dates_with_no_data=true` returned **exactly 1000 rows** (the page limit) →
  paged with `offset` (≤ 4 pages). Dates only, no times → the issuer's standard time from
  `data/symbology/eco_events.csv`, marked `*`. Release "FOMC Press Release" (id 101) has a date on
  **every day**, so FOMC dates come from the Federal Reserve page (§3.12). FRED is the source of
  **BLS/Census release dates** (BLS refuses bots, §3.12): ids 10 CPI, 50 Employment Situation, 46
  PPI, 9 retail, 180 claims, 13 G.17, 27 housing starts, 97 new home sales, 91 UMich, 192 JOLTS.
  `series/observations` `last_updated` ("2026-11-10 07:41:06-06") is now parsed to UTC and
  decides whether a release's actual is in the series yet. Values stay memory-only.

### 3.10 U.S. Treasury — daily par yield curve
- **Auth:** none. CSV `daily-treasury-rates.csv/{year}/all?type=daily_treasury_yield_curve…` and XML feed. [XML feed](https://home.treasury.gov/treasury-daily-interest-rate-xml-feed)
- **Limits:** not documented → **10/min** (*self-imposed*). XML paging (300 rows) only for `field_tdr_date_value=all`.
- **Coverage → tag:** 14 tenors (1, 1.5, 2, 3, 4, 6 Mo; 1–30 Yr), from ~15:30 ET indicative quotes; publish time undocumented → `EOD`. Columns get added over time (4 Mo 2022, 1.5 Mo 2025) — tolerate extra/missing columns.
- **Terms:** no reuse clause found; US federal works are generally public domain. Credit "Source: U.S. Treasury".
- **v1:** `providers/treasury.py` uses the documented CSV path (OK).
- **Re-checked 2026-11-09 (Phase 2 step 2.4):** the live 2026 CSV header still matches our fixture (14 tenors incl. "1.5 Month"); at 13:21 ET the newest row was 11/06 (Monday's curve comes after the close). [Methodology](https://home.treasury.gov/policy-issues/financing-the-government/interest-rate-statistics/treasury-yield-curve-methodology): inputs are FRBNY "indicative, bid-side market price quotations ... at or near 3:30 PM each trading day"; rates "usually available ... by 6:00 PM Eastern Time" → `as_of` = curve date 15:30 ET (was 00:00 UTC), "today" taken in New York, not on the machine's clock.

### 3.11 Eurostat, Statistics Denmark, World Bank — macro
| | Eurostat | Statistics Denmark (StatBank) | World Bank Indicators v2 |
|---|---|---|---|
| Auth | none | none (CATALOGUE needs a key) | none |
| Limits | not numeric; undisclosed fair-use thresholds; one extraction at a time; >500k cells async, >5M rejected (413) | not documented; ≤1M cells per non-streaming call | not documented; ≤60 indicators/call; URL ≤4000 chars |
| Bucket (*self-imposed*) | 10/min, concurrency 1 | 30/min | 30/min |
| Freshness | updated 11:00 & 23:00 CET; no vintages | releases 08:00 (Danish time assumed) | mostly annual |
| Calendar | **ICS release calendar** (not in spec) | **HTML only** | — |
| Terms | reuse with source acknowledgement (+ DOI/access date) | CC BY 4.0-equivalent; cite DST; mark own calculations | CC BY 4.0 by default; some datasets differ |
| Docs | [API](https://ec.europa.eu/eurostat/en/web/user-guides/data-browser/api-data-access/api-introduction), [copyright](https://ec.europa.eu/eurostat/help/copyright-notice) | [API](https://www.dst.dk/en/Statistik/hjaelp-til-statistikbanken/api), [releases](https://www.dst.dk/en/Statistik/planlagte) | [API](https://datahelpdesk.worldbank.org/knowledgebase/articles/889392-about-the-indicators-api-documentation), [terms](https://www.worldbank.org/ext/en/legal/terms-conditions/datasets) |
| v1 | — | — | — |

**Checked 2026-11-10 (Phase 3 step 2, ECO):**
- **Eurostat release calendar:** the old `…/cache/RELEASE_CALENDAR/calendar_EN.ics` is **404**.
  The subscribe page's script builds `https://ec.europa.eu/eurostat/o/calendars/eventsIcal?theme=0&category=2`
  (Euro indicators): 463 all-day events (`DTSTART;VALUE=DATE`) → date only, standard time 11:00
  Luxembourg, marked `*`.
- **Eurostat HICP:** `prc_hicp_manr` (and ECB ICP) **stopped at 2025-12** with the switch to
  ECOICOP v2. The new dataset is `prc_hicp_minr?coicop18=TOTAL&unit=RCH_A`; `geo=EA` (changing
  composition) had Oct-2026 = 4.0, updated 2026-11-04 11:00. **Euro-area aggregates are now
  `EA21`** (`EA20` returns no values) for `une_rt_m`, `namq_10_gdp`, `sts_inpr_m`, `sts_trtu_m`.
  The JSON-stat `updated` stamp decides whether a release is in the series yet.
- **Statistics Denmark:** releases `Statistik/planlagte?days=b&prod=1` (prod=1 = News, days=b = one
  month) — a table Date (with U+2011 hyphens) / Time (Copenhagen) / Type / Title / Subject /
  Period / Confirmed; **lists only today onward** (past releases of the window are missing).
  CPI: **`PRIS111` ended at 2025M12**; `PRIS01` (VAREGR=000000, ENHED=300 = YoY %) has 2026M10 =
  2.2. Also `AUP01`, `NKN1`, `DETA212A`. `tableinfo` gives `updated`; data via POST `/v1/data`
  CSV with `Tid=(-n+30)`. The DST titles for unemployment, GDP and retail are not yet seen in a
  live window (none were scheduled); their mapping regexes are unverified.

### 3.12 BLS and BEA — US release schedules (and optional data APIs)
- **BLS:** schedule pages + ICS, no auth; times in ET (e.g. CPI Oct 2026 on 2026-11-10 08:30 ET). Data API v1 keyless **25 queries/day**, v2 with a free key **500/day**, 50 series/query, 50 requests/10 s; key renewed yearly. Terms: cite access date and the "cannot vouch for derived data" disclaimer; no BLS logo. [API FAQ](https://www.bls.gov/developers/api_faqs.htm), [ToS](https://www.bls.gov/developers/termsOfService.htm)
- **BEA:** schedule HTML + ICS + `release_dates.json`, no auth (times without explicit TZ). Data API needs a free UserID; 100 requests/min, 100 MB/min, 30 errors/min (429 + Retry-After). Using the Data API requires a prominent not-endorsed notice. [schedule](https://www.bea.gov/news/schedule), [API ToS](https://apps.bea.gov/API/_pdf/bea_api_tos.pdf)
- **Consensus:** none of BLS/BEA/ECB/Eurostat/DST/World Bank publish consensus → `survey N.A.` confirmed.
- **v1:** neither implemented; v1's calendar is Yahoo's (§5).
- **Checked 2026-11-10 (Phase 3 step 2, ECO):**
  - **BLS: HTTP 403 "Access Denied"** to automated requests for the schedule pages and ICS
    without contact details in the User-Agent. Sending my contact details to BLS was not
    done (privacy; left for later) → BLS release dates come from FRED
    (§3.9). The BLS data API is not used.
  - **BEA:** `https://apps.bea.gov/API/signup/release_dates.json` (keyless): `{release name:
    {release_dates: [ISO with offset]}}` plus a `file_last_updated` string key; some dates repeat
    (deduplicated). Times are given → shown as calendar times (no `*`).
  - **Federal Reserve:** `monetarypolicy/fomccalendars.htm` — panels "YYYY FOMC Meetings", each
    meeting `fomc-meeting__month` + `fomc-meeting__date` ("17-18*", `*` = SEP meeting). The
    decision is the last day, statement at 14:00 ET (standard time, `*`). Budget "fed" 10/min
    (*self-imposed*, one page per 3 h).

### 3.13 SEC EDGAR — fundamentals, filings, insiders, US ticker seed
- **Auth:** none; **User-Agent declaring who you are with a contact email is required**. [accessing EDGAR data](https://www.sec.gov/search-filings/edgar-search-assistance/accessing-edgar-data)
- **Limits:** **10 requests/s total per user** across all machines; excess → brief IP limit lifted after 10 min below threshold. [privacy/developers](https://www.sec.gov/privacy) → bucket **5/s**.
- **Coverage:** submissions update < 1 s, XBRL APIs < 1 min after processing; XBRL = non-custom taxonomy facts only; `company_tickers.json` updated periodically, no accuracy guarantee; Insider Transactions data sets quarterly. `data.sec.gov` has no CORS (backend only). Full-text search: no API (P8).
- **Tag:** as_of = acceptance/filing date; `CACHE hh:mm` (filings TTL 24 h, fundamentals 12 h per §6.3).
- **Terms:** public content, may be copied/redistributed; cite the SEC; no SEC seal/EDGAR logo; no implied affiliation.
- **v1:** `providers/sec.py`, `sec_financials.py` (UA from `EDGAR_USER_AGENT`, 5/s); no filings cache; companyfacts TTL 1 h.

### 3.14 News — GDELT and RSS
- **GDELT DOC 2.0:** no auth; no official numeric limit (rate-limited, third-party reports ≈1 request/5 s → bucket **6/min**); ≤250 records/request; returns metadata only — **no summary field** (summary `N.A.`). Any use must cite GDELT and link gdeltproject.org. [DOC 2.0](https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/), [about](https://www.gdeltproject.org/about.html)
- **RSS (v1 defaults, `config.py:65-71`):**
  - MarketWatch Top Stories (Dow Jones): live, "all rights reserved"; current terms pages refused automated fetch → **unverified**.
  - CNBC Top News: live; Versant ToS limits use to personal, non-commercial; no explicit permission for third-party display found.
  - Financial Times markets: liveness and terms **unverified** (site refuses automated fetch); archived terms restrict RSS to personal use with FT credit + link.
  - v1 sends a browser-like `Mozilla/5.0` User-Agent to get past publisher blocks — conflicts with "respect terms". Use an honest UA; the user picks feeds in `PDF`; show feed name + link back; no defaults whose terms are unverified.
- **Phase 3 step 1 (2026-11-10):**
  - RSS: **no default feeds** (`RSS_FEEDS` empty); the user adds feeds on the `PDF NEWS` page (http(s) only, max 12, stored in user.db). Honest User-Agent `NDXTerminal/<version> (+local personal research tool)`. Each item shows the publisher and links to the original.
  - GDELT: adapter `providers/gdelt.py` — company news **outside North America only** (Finnhub `/company-news` covers North America); `mode=artlist&format=json&sort=datedesc&timespan=7d`, query `"<company name>" sourcelang:english`; cache ≥ 15 min; 429 → rate limited. **Live check 2026-11-10: HTTP 429 on both attempts** ("limit requests to one every 5 seconds"), even with > 5 s between them — the response shape is **not confirmed live**; the parser follows the documented `articles[]` fields (`url`, `title`, `seendate`, `domain`) and is tested on a synthetic fixture (`tests/fixtures/gdelt_artlist_synthetic.json`). Credit shown in `HELP SOURCES` / notices.
  - Finnhub market news: categories `general`, `forex`, `crypto`, `merger` → **4 tokens per refresh** (every 2 min while TOP is open); a category is skipped when the bucket has no token within 3 s.

### 3.15 Alpha Vantage — rare backfills only
- **Auth:** free key (`apikey=`). **Limits:** **25 requests/day** (confirmed); no per-minute limit stated for free. [support](https://www.alphavantage.co/support/)
- **Coverage → tag:** free equity GLOBAL_QUOTE/daily/overview → `EOD`; FX delay undocumented → `EOD` with "Last Refreshed" as as_of. Realtime/15-min US data need a separate entitlement even on paid plans.
- **Terms:** personal, non-commercial licence (ToS read via snippets only).
- **v1:** in the live QUOTE/BARS fallback chains (`registry.py:28-31`) — violates "never in a live path" (latent: key is empty).

### 3.16 Index membership proxies and symbol seeds
| Source | Access | Terms (verified) | Use |
|---|---|---|---|
| SPY daily holdings (SSGA) — XLSX | public download | no reproduction/disclosure without consent | **manual CSV/XLSX import only** (SPEC v3.1) |
| IVV holdings (iShares) — CSV | public download | terms forbid robots/automatic devices (P14) | **manual import only** |
| QQQ holdings (Invesco) | JS-rendered; download URL unconfirmed | no robots/data-mining; downloading needs consent | **manual import only**; Nasdaq-100 members from Wikipedia (§3.22) |
| OMXC25 (Nasdaq Global Indexes) | weights behind login | licensed data | curated CSV of the 25 names from public semi-annual review announcements (June/December; Nordea added 2026-06-22 per a third-party republication of Nasdaq's release) |
| Nasdaq Trader `nasdaqlisted.txt`/`otherlisted.txt` | HTTP path works but only FTP is documented; Imperva CDN | one unaltered personal copy; no storage/redistribution | runtime fetch into data dir, never commit; keep Nasdaq copyright notice |
| SEC `company_tickers.json` | public | public domain | runtime fetch (SPEC v3.1: no third-party files in git, even when allowed) |
| Binance `exchangeInfo` | public | see §3.4 | runtime fetch |

---

### 3.17 Tiingo — US live secondary (replaces Alpaca IEX)
- **Auth:** free Starter account + token. WS `wss://api.tiingo.com/equity/intraday` (24x5 consolidated feed; `thresholdLevel` 6 = reference price, 4 adds estimated bid/ask). [product](https://www.tiingo.com/products/consolidated-real-time-stock-api), [WS docs](https://www.tiingo.com/documentation/websockets/equity-realtime-stock-data)
- **Limits (Starter):** 50 requests/hour, 1,000/day, 500 unique symbols/month, 1 GB/month; "We do not rate limit to minute or second". WS symbol/connection caps not documented. [pricing](https://www.tiingo.com/about/pricing), [overview §1.1.3](https://www.tiingo.com/documentation/general/overview)
- **Coverage → tag:** a vendor-derived reference price (quote mids or trade prints), not SIP and not exchange prints → **`RT·REF`**; bid/ask shown as `est.`. Included "at no additional charge on every self-serve plan, including the free Starter plan". Exchange-unencumbered (no exchange licences or per-user fees).
- **Terms:** "data is for internal and personal use only" ([overview §1.1.6](https://www.tiingo.com/documentation/general/overview)). Starter: **memory only** (P13, [ToS §1.6(a)](https://app.tiingo.com/tos/)). Eligibility: ToS §17.13 excludes only US-embargoed countries and sanctions lists → Denmark OK. Credit Tiingo on the HELP notices page.
- **Next tier:** Power $30/month (may persist while the plan is active; delete on expiry).
- **Recorded with my key 2026-11-09 13:48–13:53 ET (market open); fixtures keep the shape and timing with synthetic values (P13), `tests/fixtures/tiingo_ws_*.json`:** the documentation page lists only the URL, threshold levels and data fields; the rest was observed. Subscribe = `{"eventName":"subscribe","authorization":<key>,"eventData":{"thresholdLevel":4,"tickers":["aapl",…]}}` → `I` (code 200, `subscriptionId`) and an `H` heartbeat at once. Level 4 messages are `["2026-11-09T13:52:02.581744471-05:00","spy",lqSpread,bidSize,bidPrice,refPrice,askPrice,askSize]` (nanoseconds, New York offset); level 6 is `[time,ticker,refPrice]`. Unknown tickers are accepted silently. Rates for AAPL, MSFT, SPY: level 6 ~3.7 updates/s, level 4 ~7/s; a few updates arrive out of time order, no duplicates.
- **Subscription changes drop the connection:** adding or removing tickers on an open connection (by `subscriptionId`, as Tiingo's IEX feed does) is acknowledged (`I`, code 200, the new list) and **~0.15 s later the server closes the connection** (close code 1005), in all three runs, with client pings on or off. An unchanged connection stayed up for 65 s with pings. → A symbol change is a reconnect with the whole list.
- **Bandwidth is the binding limit:** recorded level-4 traffic is ~1 KB/s of payload for three busy names (~0.4 KB/s at level 6). Starter's 1 GB/month would be used up in about 12 days of 24x5 streaming of just those three, so Tiingo can only be an occasional overflow stream on Starter. Whether WS traffic counts toward the 1 GB is not documented; treated as counting.
- **Adapter (Phase 2 step 2.6, `providers/tiingo_ws.py`):** threshold 4 (reference price + estimated bid/ask in one message); tag `RT·REF`, source "Tiingo", note "Tiingo reference price (derived by Tiingo, not exchange prints); bid/ask estimated"; the UI labels its bid/ask/spread/mid `est.` (by `venue == "REF"`). Gets the US equities Finnhub cannot carry (or all of them without a Finnhub key). Cap 50 (*self-imposed*); a symbol change reconnects at most once a minute (*self-imposed*), and each connect takes a token from the 40/hour budget; ≤ 450 unique symbols per UTC month (*self-imposed*, ledger of names only in `<data>/symbols_month.json`); payload bytes counted per UTC month in `<data>/bytes_month.json`, feed stops at 900 MB (*self-imposed*) and hands its symbols back to polling. Values stay in memory only (P13). Newest update time wins; older late updates are dropped.

### 3.18 Massive (formerly Polygon.io) — US bars history (replaces Alpaca historical)
- **Auth:** free Stocks Basic account + API key (`Authorization: Bearer`). [pricing](https://massive.com/pricing), [custom bars](https://massive.com/docs/rest/stocks/aggregates/custom-bars)
- **Limits:** "5 API Calls / Minute" (HTTP 429 above); up to 50,000 bars per request (default 5,000). One key only: ToS §6.1(o) bans extra accounts or rotated credentials to get around limits. → bucket **4/min** (*self-imposed*).
- **Coverage → tag:** full-market US stocks 1m–1d, **2 years**; previous session and older only (today's data returns HTTP 403 on Basic, [KB](https://massive.com/knowledge-base/article/on-the-free-basic-plan-when-can-i-pull-the-previous-trading-days-data)) → `EOD`, then `CACHE hh:mm`. Never `D15` on Basic.
- **Terms:** licence to "access, download, store and use the Information included in your plan" for personal, non-commercial use; no sharing/redistribution; on termination delete stored data within 30 days (untouched backups ≤ 90 days). Keep only the rolling 2-year window the plan includes. [Market Data Terms](https://massive.com/legal/market-data-terms-of-service), [Individuals ToS](https://massive.com/legal/individuals-terms-of-service) (both updated 2026-11-03). Citizenship/location do not restrict access ([KB](https://massive.com/knowledge-base/article/can-i-us-massives-data-if-i-am-not-a-us-citizen)).
- **Next tier:** Stocks Starter $29/month (5 years, D15, WS aggregates).
- **Recorded with my key 2026-11-09 ~14:00 ET, `tests/fixtures/massive_*.json` (results trimmed):** base `https://api.massive.com`, Bearer header works (key never in a URL). AAPL 1d from 2024-11-09 to 2026-11-08: 499 bars, oldest 2024-11-11, newest Friday 2026-11-06; daily `t` = 00:00 New York. 5m over a week: 959 bars, **04:00–19:55 ET (extended hours included)**, `queryCount` 4,614 — `limit` counts the *base minute aggregates* scanned, so one request covers ~50 sessions of minutes and longer intraday ranges page via `next_url`. `BRK.B` (dot) works. Today's range → **HTTP 403 `NOT_AUTHORIZED`** "Your plan doesn't include this data timeframe" (not a key problem). Unknown ticker → 200 with `resultsCount` 0. Bar fields `o h l c v vw t n`.
- **Adapter (Phase 2 step 2.7, `providers/massive.py`):** US equities, 1m–1d (1wk/1mo not requested), `adjusted=true`; range = max(lookback, 2 years) up to the previous New York day (after 00:05 ET); refetch after the next 00:05 ET; `EOD` then `CACHE`; pages newest-first, at most 3, each waiting for its own token of the 4/min bucket, and a series cut short says so in its note ("older bars not loaded"); 403-timeframe → `NotSupported` (falls through, not a key error); routing (BARS, EQUITY): yfinance (opt-in) → Massive → EODHD. Stored bars kept to the 2-year window (storage rule).

### 3.19 EODHD — EU/Nordic default: **Free plan** (my choice 2026-11-09)
- **Auth:** account + `api_token` query param; the key lives in env var `EODHD_API_KEY` (set 2026-11-09). [pricing](https://eodhd.com/pricing), [plans](https://eodhd.com/help/plans), [limits](https://eodhd.com/financial-apis/api-limits)
- **Plans:** Free $0 — 20 calls/day, 1 year of EOD ("Enough to try the endpoints out, not to run an application"). **EOD Historical Data All World $19.99/month** ($199/year) — 100,000 calls/day, 1,000/min; EOD for CO, ST, HE, OL, XETRA, LSE, PA, AS, SW and more, plus FX; live (delayed) quotes. $29.99 tier adds intraday bars (final 2–3 h after close) and a WebSocket (US: Cboe EDGX only; EU: Cboe Europe venues only → `RT·<venue>`).
- **Coverage → tag:** stocks live "15–20 min" → `D20` (or compute from the returned timestamp); FX ≈ 1 min → `D1`; daily bars `EOD`. Exact Nordic/EU index symbols (`.INDX`) and whether indices work on the live endpoint: **unverified** — check with a key before relying on them.
- **Checked with my Free key (2026-11-09, 3 calls):** `/api/user` reports `apiRequests`, `apiRequestsDate`, `dailyRateLimit` 20 and `extraLimit` 500 and **costs no call** (it also returns the holder's name and email — never stored); the counter rose by exactly 3 for 3 EOD requests, the unknown ticker's `404 Ticker Not Found.` included ([api-limits](https://eodhd.com/financial-apis/api-limits): reset "at midnight GMT", HTTP 402 when the calls are gone, 1,000 requests/min). `NOVO-B.CO` returned EOD rows up to 2026-11-06 at 18:02 UTC — **the 2026-11-09 close was not there two hours after Copenhagen closed** → we wait 4 h after a close before expecting it (*self-imposed*) and retry 2 h later if it is still missing. **`OMXC25.INDX` works on Free** (EOD rows incl. 2026-11-09) — see P17.
- **Adapter (Phase 2 step 2.1):** `server/ndx_server/providers/eodhd.py`; exchanges DC SS NO FH GY LN FP NA SW (US and Asia not used); daily bars and an EOD quote derived from the last two closes; one call per symbol per session, persisted 18/day counter (`quota.json` in the data folder, synced with `/api/user`); closes in the bar store; LSE currency `N.A.` (pence vs pounds not stated per row).
- **Terms:** "Private display to yourself on your own devices is personal use." ([personal-use](https://eodhd.com/help/personal-use)); non-professional users are "permitted to store, manipulate, and analyze the data for private, non-commercial purposes" ([T&C](https://eodhd.com/knowledgebase/terms-conditions)); storage page: databases and backups allowed, "no deletion requirement" ([storage](https://eodhd.com/help/storage)). Redistribution and display to others prohibited. No country clause → Denmark OK.

### 3.20 Options — **opt-in yfinance only** (decision 2026-11-10)
Decision: no separate options source. `OMON`/`OVME` (Phase 6, SPEC §7) use opt-in yfinance (OPRA 15 min → `D15`,
`PERSONAL USE`, P1); with yfinance off, chains are `N.A.`. The candidates below were checked on 2026-11-09 and
are kept for reference (not used).

| Candidate | Price | Data → tag | Terms (quote) | Catch |
|---|---|---|---|---|
| MarketData.app Free Forever | $0, 100 credits/day | previous-session chains, prices + OI → `EOD`; Greeks/IV "not stored historically" → `N.A.` | "for your own personal non-professional use"; may store, only you may access; delete on account close ([terms](https://www.marketdata.app/terms/)) | no Greeks on Free; Starter $30/month ($12/month annual) adds D15 + Greeks |
| Tradier Brokerage (Lite) | $0; $50/year inactivity fee if < 2 trades/year | production `RT` chains with Greeks (ORATS); sandbox `D15` | "Unless you are a Tradier Partner, Tradier APIs are intended for personal use only." ([FAQ](https://docs.tradier.com/docs/faq)) | needs a real US brokerage account (KYC, W-8BEN; Denmark accepted); storage terms behind login → memory only until read; rate limit 120/min per search-indexed docs (unverified) |
| opt-in yfinance | $0 | OPRA 15 min → `D15` | P1 | personal use, unofficial |
| Massive Options Starter | $29/month | D15 chain snapshots with Greeks/IV/OI | "solely for your own personal, non-business and non-commercial use" | over budget |

### 3.21 Exchange MiFIR delayed data (free, raw trades; later option for EU/Nordic)
| Venue group | Access | Terms (quote) | Catch |
|---|---|---|---|
| Deutsche Börse: Xetra, Frankfurt, Tradegate, Eurex — [file service](https://mfs.deutsche-boerse.com/index.html) | per-minute JSON trade files + daily post-trade file, no key | licence "only granted free of charge if the Delayed Data User does not commercialize" | click-through "I agree" — **the user must accept it, the app must not**; storage not addressed; raw trades → we build bars; no index levels |
| Euronext: Paris, Amsterdam, Brussels, Lisbon, Dublin, Milan, Oslo — [trades file](https://marketdata.euronext.com/data-reporting-service/trades-file) | web UI file generation, no documented endpoint | delayed-data terms "do not impose any restrictions on the Use" except distribution ([PDF](https://www.euronext.com/sites/default/files/stld/terms_and_conditions_for_delayed_data.pdf)) | general site terms ban robots; unclear whether they cover marketdata.euronext.com → ask databyeuronext@euronext.com first |
| Nasdaq Nordic: Copenhagen, Stockholm, Helsinki — [tradereports](https://tradereports.nasdaq.com/) | CSV, free | nasdaq.com terms forbid any "process, whether automated or manual, to capture data" ([legal](https://www.nasdaq.com/legal)) | **needs prior written approval** (dataeurope@nasdaq.com); retention 24 h |
All three: `D15`, trades only (no quotes, no indices), and we would need a trades-to-bars aggregator and our own store.

### 3.22 Index members — Wikipedia and SEC N-PORT
- **Wikipedia** "List of NASDAQ-100 companies" (and the S&P 500 list, same mechanism; that page not separately checked) via the MediaWiki API (`action=parse`, table id `constituents`, columns by header name, ISIN optional; sanity-check 100–103 rows). Licence: "Creative Commons Attribution-ShareAlike 4.0 License" ([reuse](https://en.wikipedia.org/wiki/Wikipedia:Reusing_Wikipedia_content)) → credit with a link to the pinned revision (`oldid`), state the CC BY-SA licence and that we converted it to CSV. Etiquette: one request at a time, descriptive User-Agent with contact, gzip, cache ([API:Etiquette](https://www.mediawiki.org/wiki/API:Etiquette)). On 2026-11-09 revision 1381716526 had 101 rows and matched the 2026-10-22 change. Label "community-edited list, as of DATE".
- **SEC N-PORT-P** of Invesco QQQ Trust (CIK 0001067839) as a lagging cross-check with quarter-end weights: "considered public information and may be copied or further distributed" ([sec.gov/privacy](https://www.sec.gov/privacy)). Latest public as of 2026-06-30 (filed 2026-08-28); filter non-equity lines (it holds an NQ future); join on ISIN. Label "proxy: fund holdings, as of DATE"; amber after ~100 days.
- **Manual CSV import** of any issuer holdings file stays available (P9, P14).

## 4. Required notices (for the HELP → "Data sources" page)
- FRED API: not-endorsed notice (exact text on the [API terms](https://fred.stlouisfed.org/docs/api/terms_of_use.html) page) + per-series copyright/citation.
- BEA Data API (if used): not-endorsed notice ([API ToS](https://apps.bea.gov/API/_pdf/bea_api_tos.pdf)).
- CoinGecko: "Powered by CoinGecko" + link, next to the data.
- ExchangeRate-API (if kept): "Rates By Exchange Rate API" + link.
- GDELT: cite and link the GDELT Project.
- ECB, Eurostat, Statistics Denmark, World Bank, NBU, SEC, US Treasury: source citation; derived values labelled as derived.
- BLS (only if BLS itself is called — not since Phase 3 step 2, its dates come via FRED): access date + "cannot vouch for derived data" disclaimer.
- BEA release dates, Federal Reserve FOMC calendar (ECO): source citation.
- Tiingo: credit Tiingo as the source of `RT·REF` values (HELP page and hover card).
- Wikipedia member lists: CC BY-SA 4.0 credit with a link to the revision used, licence notice, "converted to CSV".
- yfinance (when enabled): "Unofficial source, enabled by you, personal use" + Yahoo's no-redistribution note.
- EODHD / Massive: source citation; no attribution clause found.
- TradingView lightweight-charts: attribution per its NOTICE (not a data provider; SPEC §3).

---

## 5. v1 sources that are not in §6.2

| Source | v1 use | Verified facts | Recommendation |
|---|---|---|---|
| ExchangeRate-API open (`open.er-api.com`) | last-resort FX (`erapi.py`), hourly refetch | no key; "rate limited" (no number), 429 → wait 20 min; updates once/day; **attribution required**; no redistribution; no programmatic re-exposure. [docs](https://www.exchangerate-api.com/docs/free) | Drop in favour of ECB EXR + NBU (or keep as labelled tertiary with attribution and 24 h cache). |
| FRED `fredgraph.csv` | keyless FRED fallback | not a documented endpoint | Drop; require a FRED key. |
| Yahoo econ calendar (`/v1/finance/visualization`) | only ECO source; shows Yahoo consensus as "expected" | undocumented endpoint; consensus licensing unknown; ToS P1 | Replace with official calendars; survey `N.A.`. |
| Yahoo screener / insiders / filings list / news search | EQS, INS, CF fallback, N | undocumented; ToS P1 | Insiders/filings → SEC; screener → local data (EQS Phase 4). |

---

## 6. Proposed token-bucket budgets (feed into §6.3 limiter)

| Provider | Documented limit | Budget we use |
|---|---|---|
| Finnhub | 60/min + 30/s; WS 50 symbols, 1 conn | 55/min, burst 10; WS ≤ 50 symbols |
| Tiingo Starter | 50/hour, 1,000/day, 500 symbols/month, 1 GB/month | 40/hour; symbol counter per month |
| Massive Basic | 5/min | 4/min |
| EODHD Free | 20/day (reset time for Free not stated) | 18/day, one EOD call per symbol after the close |
| MarketData.app Free (not used, D15) | 100 credits/day | — |
| Wikipedia (MediaWiki API) | no hard limit; serial requests | 1 at a time, ≤ 1 refresh/day |
| Yahoo/yfinance | not documented | 60/min, burst 10 (*self-imposed*) |
| Binance | 6000 weight/min/IP; WS 5 msg/s, 1024 streams | 3000 weight/min; 3 ctrl msg/s |
| Coinbase | 8 conn/s, 8 msg/s | 4 msg/s |
| CoinGecko Demo | 100/min, 10 000/month | 30/min + monthly counter |
| ECB | not documented | 30/min |
| ECB calendars + SDMX for ECO ("ecbstat") | not documented | 20/min |
| Federal Reserve (FOMC page) | not documented | 10/min |
| NBU | not documented | 10/min |
| FRED | 120/min | 100/min |
| US Treasury | not documented | 10/min |
| Eurostat | fair use, concurrency 1 | 10/min, concurrency 1 |
| Statistics Denmark | not documented | 30/min |
| World Bank | not documented | 30/min |
| BLS v2 | 500/day, 50 req/10 s | 400/day |
| BEA | 100/min | 60/min |
| SEC EDGAR | 10/s per user | 5/s |
| GDELT | not documented (~1/5 s reported) | 6/min |
| Alpha Vantage | 25/day | 20/day, backfill only |

---

## 7. v1 routing and TTLs (legacy, for reference)
v1 (tag `v1-baseline`) routed through `server/ndx_server/providers/registry.py`: equity quotes
Yahoo → Finnhub → Alpha Vantage; FX Yahoo → Alpha Vantage → ExchangeRate-API; crypto Binance →
Yahoo; filings/fundamentals SEC → Yahoo; macro FRED API → FRED CSV. TTLs: quotes 3–8 s, intraday
bars 30 s, daily bars 15 min, news 2 min, filings 1 h, macro 3 h, profile/fundamentals 6 h. These
differ from SPEC §6.2/§6.3 and are replaced from Phase 2.

---

## 8. EU/Nordic default — options considered (2026-11-09)
Request: a source whose terms allow this personal use, free or up to ~$10/month, with a terms quote.
**Finding: none at ≤ ~$10/month covers stocks + indices + futures + FX intraday with clean terms** (P15).

| Option | Cost | What you get | Terms quote |
|---|---|---|---|
| **A. EODHD Free** — **chosen 2026-11-09** | $0 | EOD for a small watchlist (20 calls/day, 1 year); no intraday | "Private display to yourself on your own devices is personal use." |
| **B. EODHD All World** (recommended if budget stretches) | $19.99/month ($16.58 annual) | EOD for CO/ST/HE/OL/XETRA/LSE/PA/AS/SW + FX, `D20` stock quotes, `D1` FX, 100k calls/day, storage allowed | "permitted to store, manipulate, and analyze the data for private, non-commercial purposes" |
| C. Exchange MiFIR files (§3.21) | $0 | `D15` trades for Xetra/Eurex (DB) and Euronext; Copenhagen only with Nasdaq's written approval | "only granted free of charge if the Delayed Data User does not commercialize" (Deutsche Börse) |
| D. opt-in yfinance only | $0 | everything, unofficial | Yahoo ToS forbid automated collection (P1) |

Rejected with reasons in the research log: Marketstack (Nordic unconfirmed, US-only intraday), Twelve Data
(free = non-display; Nordic from $99), FMP (global data $139; restrictive), Alpha Vantage (25/day; backfill
only), Stooq (CAPTCHA wall), Investing.com/MarketWatch (no API, terms forbid), LSE DMD, Börse Stuttgart.

**Decision (2026-11-09): A — EODHD Free.** I created the account and entered the key. Use: one EOD
call per symbol per day after the local close, ≤ 18 symbols/day, priority open windows → watchlists; store
closes in the bar store (storage allowed, §3.19). Upgrade to B later needs no code change (same adapter).
Before relying on index symbols (`.INDX`), check them with the key (P16 still applies on Free).
