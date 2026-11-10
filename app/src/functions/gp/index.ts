import { matching, oneOf, registerFunction, type ArgSpec } from "@/core/registry";
import { drill } from "@/core/items";
import type { PanelSpec } from "@/core/layout/tree";
import {
  CHART_TYPES,
  INDICATORS,
  NUMBERED_RANGES,
  RANGES,
  TIMEFRAMES,
  formatGpArgs,
  parseGpArgs,
  timeframe,
} from "./args";
import { GIP, GP } from "./GP";

const GP_ARGS: ArgSpec[] = [
  oneOf(
    "range",
    RANGES.map((r) => r.token),
    "visible window",
  ),
  oneOf(
    "timeframe",
    TIMEFRAMES.flatMap((t) => t.tokens),
    "bar size (1M = monthly bars)",
  ),
  oneOf("study", INDICATORS, "overlay or lower pane"),
  oneOf("type", CHART_TYPES, "candles · OHLC bars · line · area"),
  oneOf("option", ["LOG", "NOVOL"], "log scale · hide volume"),
  matching("line", /^HL=\d+(\.\d+)?$/, "HL=<price>", "horizontal line"),
  matching("from", /^FROM=\d{4}-\d{2}-\d{2}$/, "FROM=YYYY-MM-DD", "custom window start"),
  matching("to", /^TO=\d{4}-\d{2}-\d{2}$/, "TO=YYYY-MM-DD", "custom window end"),
  matching("compare", /^CMP=\S+$/, "CMP=<ticker>", "compare overlay (up to 5; _ for spaces)"),
  matching("events", /^EV=(NONE|[EDS]{1,3})$/, "EV=EDS", "event markers shown (NONE hides)"),
];

export function registerGP(): void {
  registerFunction({
    code: "GP",
    name: "Price chart",
    description:
      "Candles/OHLC/line/area, ranges 1D–MAX and custom dates, 1m–1MO bars, SMA/EMA/BB/VWAP " +
      "overlays, RSI/MACD/ATR panes, horizontal lines, log scale",
    ticker: "required",
    syntax:
      "<TICKER> GP [RANGE | FROM=<date> [TO=<date>]] [TF] [CANDLE OHLC LINE AREA] " +
      "[SMA EMA BB VWAP RSI MACD ATR] [LOG] [NOVOL] [HL=<price>] [CMP=<ticker>] [EV=EDS]",
    examples: [
      "AAPL US EQUITY GP",
      "NOVOB DC EQUITY GP 1Y",
      "EURUSD CURNCY GP 1H RSI",
      "BTCUSD CURNCY GP 5 VWAP MACD",
      "SPX INDEX GP W LOG",
    ],
    category: "Market",
    sectors: ["EQUITY", "INDEX", "COMDTY", "CURNCY"],
    menu: ["Charts"],
    args: GP_ARGS,
    // 1)–9) the ranges (SPEC §8), then the drill-downs.
    actions: [
      ...NUMBERED_RANGES.map((r, i) => ({
        n: i + 1,
        label: r.token,
        to: (p: PanelSpec) => ({
          ...p,
          args: formatGpArgs({
            ...parseGpArgs(p.args),
            range: r.token,
            tf: r.tf,
            from: undefined,
            to: undefined,
          }),
        }),
      })),
      drill(10, "Description", "DES"),
      drill(11, "Quote", "Q"),
      drill(12, "News", "CN"),
    ],
    component: GP,
    title: (p) => `Price chart ${timeframe(parseGpArgs(p.args).tf).label}`,
  });
}

export function registerGIP(): void {
  registerFunction({
    code: "GIP",
    name: "Intraday chart",
    description:
      "GP opened on today's session: 5-minute bars over the last day (1D), every GP tool " +
      "available; US extended hours shaded",
    ticker: "required",
    syntax: "<TICKER> GIP [1D | 5D | 1M] [1 5 15 30 60 240] [GP options]",
    examples: ["AAPL US EQUITY GIP", "NOVOB DC EQUITY GIP 5D", "BTCUSD CURNCY GIP 1"],
    category: "Market",
    sectors: ["EQUITY", "INDEX", "COMDTY", "CURNCY"],
    menu: ["Charts"],
    args: GP_ARGS,
    actions: [
      ...NUMBERED_RANGES.slice(0, 3).map((r, i) => ({
        n: i + 1,
        label: r.token,
        to: (p: PanelSpec) => ({
          ...p,
          args: formatGpArgs({ ...parseGpArgs(p.args), range: r.token, tf: r.tf }),
        }),
      })),
      {
        n: 4,
        label: "Daily chart (GP)",
        to: (p: PanelSpec) => ({ fn: "GP", ticker: p.ticker, args: [] }),
      },
      drill(11, "Quote", "Q"),
      drill(12, "News", "CN"),
    ],
    component: GIP,
    title: (p) => `Intraday chart ${timeframe(parseGpArgs(gipArgs(p.args)).tf).label}`,
  });
}

/** GIP without arguments is the last session in 5-minute bars. */
export const gipArgs = (args: string[]) => (args.length ? args : ["1D"]);
