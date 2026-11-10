# Test fixtures

Tests never touch the network: provider adapters are tested against the files in this folder.

**Included (synthetic or without market data):**

- `finnhub_*.json`, `alphavantage_*.json`, `gdelt_artlist_synthetic.json` — hand-written to the
  providers' documented response formats.
- `fred_unrate.csv` — FRED's CSV layout (header, 36 monthly dates, an empty unpublished month)
  with synthetic values 5.00, 5.01, …
- `tiingo_ws_level4.json` — the message order, timestamps and field layout of Tiingo's IEX
  WebSocket at threshold level 4, every number replaced (prices from 100/200/300 in 0.01 steps);
  `tiingo_ws_resubscribe.json` holds only control messages. `_rx_s` is a receive offset.
- `eodhd_user*.json` (call counters only), `eodhd_eod_unknown.json`, `massive_today_403.json`,
  `massive_unknown.json` — error and empty answers, identifiers replaced.

**Not included: recorded provider responses.** The adapters for Yahoo, Binance, Coinbase,
CoinGecko, ExchangeRate-API, ECB, NBU, U.S. Treasury, EODHD and Massive bars, Finnhub WebSocket,
SEC EDGAR, RSS and the official release calendars (BEA, Federal Reserve, Eurostat, ECB,
Statistics Denmark) were tested against real responses that are not redistributed here (provider
terms). Tests that need them are **skipped** (`tests/helpers.py: fixture_file`) with the file
name as the reason.

To run them, record the files locally (keys from your own `.env`; the recorder strips account
details and never writes keys):

```bash
uv run python tests/fixtures/record.py            # Yahoo, Binance, CoinGecko, ER-API, RSS
uv run python tests/fixtures/record.py phase3     # Treasury, SEC, FRED layout
uv run python tests/fixtures/record.py fx         # ECB, NBU
uv run python tests/fixtures/record.py sec        # needs EDGAR_USER_AGENT
uv run python tests/fixtures/record.py sec-facts  # needs EDGAR_USER_AGENT
uv run python tests/fixtures/record.py massive    # needs MASSIVE_API_KEY
uv run python tests/fixtures/record.py eodhd      # needs EODHD_API_KEY
```

The calendar pages (`bea_release_dates.json`, `fomc_calendar.html`, `ecb_statscal.html`,
`ecb_meetings.html`, `eurostat_euroind.ics`, `eurostat_prc_hicp_minr.json`,
`dst_planlagte.html`, `dst_pris01.csv`) and the WebSocket captures (`finnhub_ws_trades.json`,
`coinbase_ws_ticker.json`) are not covered by the recorder; save them from the sources yourself.
Recorded values are test data, not market data.
