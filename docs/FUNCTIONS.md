# Functions

In-app `HELP` is the live reference (syntax, examples, sources per function); this page is the
written summary as of 2026-11-10.

**Syntax:** `<SECURITY> <FUNCTION> [ARGS]` or `<FUNCTION> [ARGS]`. A bare security opens its
default function. Commands are case-insensitive; every token autocompletes. `Enter` runs in the
active panel, `⇧Enter` in a new one. Securities: `AAPL US EQUITY` or `AAPL`, `NOVOB DC`,
`EURDKK CURNCY`, `BTCUSD`, indices such as `SPX INDEX` / `OMXC25`; `PDF EXCH` sets the default
exchange for bare non-US tickers.

**Every data panel** starts with a provenance line: freshness tag (`RT`, `DELAYED 15m`, `EOD`,
`CACHE hh:mm`, `STALE`), source, the data's own timestamp, fetch time, and `FALLBACK (a → b)`
when a backup provider answered. Missing values are `N.A.` (hover for the reason); errors show
as a red banner; DEMO mode shows a `DEMO` badge.

**Keys:** `/` or `Esc` command line · `?` keys of the active panel · `KEYS` the whole keymap
(rebindable; reserved macOS chords are refused) · `MENU` numbered menus · panels split,
maximize, close and focus from the keyboard.

---

## Market

| Code | Syntax | What it shows |
| --- | --- | --- |
| `GP` | `<SEC> GP [RANGE \| FROM=<date> [TO=]] [TF] [CANDLE OHLC LINE AREA] [SMA EMA BB VWAP RSI MACD ATR] [LOG] [NOVOL] [HL=<price>] [CMP=<sec>] [EV=EDS]` | Chart: ranges 1D–MAX or custom dates, 1m–1MO bars, overlays and panes, horizontal lines, compare, earnings/dividend/split events |
| `GIP` | `<SEC> GIP [1D \| 5D \| 1M] [TF]` | GP on today's session (5-minute bars), US extended hours shaded |
| `Q` | `<SEC> Q` | Last, change, bid/ask with sizes (`N.A.` where free feeds have none), OHLC, VWAP, volume vs 30-day average, ranges, sparkline, time & sales, headlines |
| `HP` | `<SEC> HP [D \| W \| M] [1M … MAX \| FROM=]` | Historical OHLC, change and volume table with window stats |
| `MON` / `W` | `MON [NAME] · MON ADD <SYM…\|#GROUP> · MON DEL · MON NEW · MON DROP · MON COLS <field…>` | Monitors (watchlists) with live updates, configurable columns (`FLDS` names), CSV copy |
| `WEI` | `WEI` | World indices (Americas, EMEA incl. OMXC25, APAC), % YTD, session state; US futures while cash is closed |
| `WFX` | `WFX` | FX monitor: majors, EUR crosses, Nordic pairs, UAH, CEE; source per row |
| `GLCO` | `GLCO` | Commodities: front-month futures (opt-in source only) and official spot prices from FRED |
| `CRYPTO` | `CRYPTO [N]` | Top coins by market cap (CoinGecko) with live Binance prices |
| `CDR` | `CDR [WORDS]` | Exchange hours (DST-aware), session state, holidays, early closes |

## Research

| Code | Syntax | What it shows |
| --- | --- | --- |
| `DES` | `<SEC> DES` | Description (simple version): profile, sector/industry, key stats (`N.A.` where no source), 52-week range, next earnings date, numbered items 1)–4) |
| `FA` | `<SEC> FA [INCOME\|BALANCE\|CASHFLOW\|RATIOS] [Q]` | Financial statements, latest period first, annual or quarterly, ratios, CSV export (`E`) |
| `TOP` | `TOP [region] [asset] [topic] [MY]` | Ranked headlines: near-duplicate clusters ("+N similar"), `NEW` < 5 min, ticker chips, filters, reader pane, keyword alerts |
| `N` | `N · <SEC> N` | News menu: numbered rows open `TOP` with a filter; with a security, its company news |
| `CN` | `<SEC> CN` | Company news, newest first |
| `EQS` | `EQS [REGION=XX] [SECTOR=…] [MCAP>10B] [PE<25] [CHG>2] [VOL>1M] [SORT=…] [ASC]` | Equity screener (opt-in Yahoo screener) |
| `CF` | `<SEC> CF` | Filings with links (SEC EDGAR when `EDGAR_USER_AGENT` is set) |
| `INS` | `<SEC> INS` | Insider transactions with 6-month totals |
| `CORR` | `CORR [SYMBOLS…] [D=DAYS]` | Correlation of daily returns (default: first monitor) |

**FA sources.** SEC EDGAR XBRL (US filers; foreign 20-F/40-F filers annual) when
`EDGAR_USER_AGENT` is set; otherwise the opt-in yfinance source. When nothing covers the
security (e.g. crypto, or a non-SEC company with yfinance off) the panel says `N.A.` and why.
Fiscal Q4 and quarterly cash flows are derived from year-to-date figures; total debt excludes
lease liabilities. Not built: TTM column, YoY toggle, mini bars, unit switch, XLSX, per-column
source.

## Macro

| Code | Syntax | What it shows |
| --- | --- | --- |
| `ECO` | `ECO [US\|EZ\|DE\|DK\|UK\|JP\|CN] [MED\|HIGH] [WEEK\|TODAY\|2W\|PAST]` | Economic calendar from official release calendars |
| `ECST` | `ECST [indicator]` (e.g. `ECST US-CPI-YOY`, `ECST DK-CPI-YOY`) | History of the official series behind an ECO line |
| `YC` | `YC` | US Treasury par yield curve now vs 1 month and 1 year ago, 2s10s and 3m10y |

**ECO.** Release dates from BEA, the Federal Reserve (FOMC), FRED release dates (BLS, Census),
Eurostat, the ECB and Statistics Denmark; times in your zone (Copenhagen by default), `*` marks
the issuer's standard time where the calendar gives only a date, `(t)` a tentative date. Actual
and prior come from the official series; **survey and revised are always `N.A.`** (no official
consensus; no data vintages kept). Keys: `c` country, `i` importance, `d` date range, `n` jump to
the next release (live countdown), `Enter` opens the line's series in `ECST`, `⇧R` refresh.
Countries without a connected calendar (DE, UK, JP, CN) show an explicit `N.A.` line.

**ECST.** Left: every mapped indicator grouped by country; right: chart (`1`–`4` = 2Y / 5Y / 10Y
/ MAX), last, change, when the source updated the series, last and next release with countdown,
the last 12 observations. Values are the series after the ECO line's transform (level, % m/m,
% y/y, change); `STALE` depends on the series' frequency.

## Tools

| Code | Syntax | What it does |
| --- | --- | --- |
| `PORT` | `PORT · PORT BUY\|SELL <SYM> <QTY> [@PRICE] · PORT DEL <TRADE_ID>` · `I` import CSV | Paper portfolio |
| `ALRT` | `<SEC> ALRT >PRICE \| <PRICE \| %>PCT \| %<PCT [NOTE] · ALRT · ALRT DEL <ID> · ALRT REARM <ID>` | Price and day-change alerts |
| `JRNL` | `JRNL` | Trade journal |
| `NOTE` | `NOTE · <SEC> NOTE` | Markdown research notes per security (autosaved) |
| `BT` | `BT · BT <SCRIPT.PY> [ARGS…]` | Runs a Python backtest from `BT_RESEARCH_DIR` and plots its equity curve |

**PORT.** Manual trades fill at `@PRICE` or at the current quote (the note records its source
and delay). Average-cost accounting, no shorts; values in the portfolio's base currency with live FX. Shows unrealized,
realized and day P&L, exposure by sector and asset class, volatility, max drawdown and beta vs
SPY from current holdings.
**CSV import** (`I` or the IMPORT CSV button): header `date,security,side,qty,price[,fees][,note]`
— `date` as `YYYY-MM-DD`, `side` `BUY` or `SELL`, positive `qty` and `price`. Fees are folded into
the price (a buy costs more, a sell receives less), so P&L includes them. Rows apply oldest
first and the import is **all or nothing**: one bad row, an unknown security or an oversell
imports nothing and lists the errors by line.

```csv
date,security,side,qty,price,fees,note
2026-01-05,AAPL,BUY,10,200,5,first lot
2026-02-10,AAPL,SELL,4,230,2,
```

**ALRT.** The server checks armed alerts every 10 s with the same quotes (and delays) as `Q`; a
fired alert disarms itself, shows in the command line and as a native macOS notification (`T`
sends a test one). Alerts run only while the app is running.

**JRNL.** One row per trade: symbol, side (LONG/SHORT), size, entry, exit (empty = open), opened
date, setup tags and mistake tags (comma-separated), thesis, post-mortem. Type in the amber
fields and press `Enter` to save; `N` new, `Enter` on a row edits it, `⌫` deletes. P&L is in the
trade's own currency and return % is signed by side; win rate and average return are computed
over closed trades, overall and per tag (by return %, so currencies are never summed). These
are your records — no market data is involved.

**BT script contract.** Top-level `*.py` files in `BT_RESEARCH_DIR` (names starting with `_` are
hidden) run as `uv run <script> [args…]` in that folder (PEP 723 inline dependencies work). The
environment has `NDX_BT_OUTPUT` (where to write the result), `NDX_API_URL` and `NDX_API_TOKEN`
(the terminal's data API, header `x-ndx-token`). The result is JSON written to `$NDX_BT_OUTPUT`
or printed as the last stdout line:

```json
{
  "equity": [{"t": "2024-01-02", "v": 10000.0}],
  "benchmark": [{"t": "2024-01-02", "v": 10000.0}],
  "stats": {"CAGR %": 12.1, "Sharpe": 0.9, "Max drawdown %": -18.7}
}
```

10-minute limit; stdout/stderr tails show in the panel. Example:
[`docs/examples/bt/sma_cross.py`](examples/bt/sma_cross.py) — `BT SMA_CROSS.PY SPY 50 200`.

## System

| Code | Purpose |
| --- | --- |
| `HELP [FUNCTION\|CATEGORY\|SECTOR\|SOURCES] · HELP SEARCH [WORDS]` | Function list with syntax and examples; `HELP SOURCES` lists data sources and required notices |
| `SRCH <WORDS>` | Search functions, securities (offline index), notes and headlines |
| `MENU [SECTOR] · <SECURITY>` | Numbered menus by sector and per security |
| `KEYS [RESET]` | Every key binding; rebind or restore |
| `LAYOUT [SAVE\|DEL] <NAME> · LAYOUT <NAME> · LAYOUT [LIST\|RESET\|CLASSIC\|WORKSPACE]` | Named layouts; the last session restores on launch |
| `LINK [NONE\|RED\|GREEN\|BLUE\|YELLOW]` | Link windows by colour: loading a security loads it in every window of that colour |
| `POP` | Copy the active function into the workspace as a small free window |
| `PDF [COLORS] · PDF EXCH <CODE> · PDF YFINANCE ON\|DK\|OFF · PDF NEWS` | Personal defaults: default exchange, colour palette, opt-in providers, news feeds |
| `PROV` | Providers: state, freshness, latency, errors, quota, circuit breaker, key present (never the key) |
| `FLDS [WORDS]` | Field dictionary and which providers delivered each field |
| `LOG [LINES] [LEVEL]` | Structured log, secrets redacted |
| `OFF` | Save the session and quit |

## Not built

These codes are in the spec but not in this version. They are not in `HELP`, `MENU` or
autocomplete; typing one says "*X is not built in this version*".

`ASK` `BETA` `BTMM` `CALC` `CHEAT` `COMP` `DVD` `ECDR` `EE` `EM` `ERN` `EVTS` `FXC` `G` `GRAB`
`HDS` `IMAP` `MEMB` `MGMT` `MOST` `MOV` `NSE` `OMON` `OVME` `PROP` `PRTU` `PY` `REPLAY` `RISK`
`RV` `SI` `TQL` `TRA` `VAP` `WB` — plus tear-off windows and the euro-area/Danish curves in `YC`.
