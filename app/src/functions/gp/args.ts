import { MAX_COMPARE, cmpSymbol, cmpToken } from "./compare";
/** GP panel state <-> command args (so layouts and history restore the full chart setup). */

export type Interval = "1m" | "5m" | "15m" | "30m" | "1h" | "4h" | "1d" | "1wk" | "1mo";

export interface Timeframe {
  key: Interval;
  label: string;
  tokens: string[];
  seconds: number;
  /** default lookback in days */
  lookback: number;
}

export const TIMEFRAMES: Timeframe[] = [
  { key: "1m", label: "1m", tokens: ["1", "1MIN"], seconds: 60, lookback: 3 },
  { key: "5m", label: "5m", tokens: ["5", "5MIN"], seconds: 300, lookback: 20 },
  { key: "15m", label: "15m", tokens: ["15", "15MIN"], seconds: 900, lookback: 45 },
  { key: "30m", label: "30m", tokens: ["30", "30MIN"], seconds: 1800, lookback: 59 },
  { key: "1h", label: "1H", tokens: ["60", "1H", "H"], seconds: 3600, lookback: 240 },
  { key: "4h", label: "4H", tokens: ["240", "4H"], seconds: 14400, lookback: 540 },
  // Daily bars are `D`: `1D` is the one-day range (SPEC §8 GP ranges).
  { key: "1d", label: "D", tokens: ["D"], seconds: 86400, lookback: 1825 },
  { key: "1wk", label: "W", tokens: ["W", "1W"], seconds: 604800, lookback: 7300 },
  // Monthly bars are `1MO` (or `M`): `1M` is the one-month range (SPEC §8 GP ranges).
  { key: "1mo", label: "1MO", tokens: ["M", "1MO"], seconds: 2592000, lookback: 21900 },
];

/**
 * Ranges (`GP 1Y`, SPEC §4.3, §8): the visible window. Without an explicit timeframe a range
 * also picks the bar size. The first nine are GP's numbered items `1)`–`9)` (SPEC §8).
 */
export interface Range {
  token: string;
  /** Window length in days; null = everything loaded (MAX), since 1 January (YTD) or the
   * last session (1D). */
  days: number | null;
  tf: Interval;
}

export const RANGES: Range[] = [
  { token: "1D", days: null, tf: "5m" },
  { token: "5D", days: 5, tf: "30m" },
  { token: "1M", days: 30, tf: "1h" },
  { token: "3M", days: 91, tf: "1d" },
  { token: "6M", days: 182, tf: "1d" },
  { token: "YTD", days: null, tf: "1d" },
  { token: "1Y", days: 365, tf: "1d" },
  { token: "5Y", days: 1826, tf: "1d" },
  { token: "MAX", days: null, tf: "1wk" },
  // Accepted as args, not numbered.
  { token: "2Y", days: 730, tf: "1d" },
  { token: "3Y", days: 1095, tf: "1d" },
  { token: "10Y", days: 3652, tf: "1wk" },
];

/** The numbered ranges, in item order (1 = 1D … 9 = MAX). */
export const NUMBERED_RANGES = RANGES.slice(0, 9);

/** Start of a range's window (bar-time seconds) given the newest bar's time, or null for
 * "everything loaded". Bar times are venue wall clock, so a day starts at a multiple of 86400. */
export function rangeStart(token: string, lastSec: number): number | null {
  const r = RANGES.find((x) => x.token === token);
  if (!r) return null;
  if (r.token === "YTD") return Date.UTC(new Date(lastSec * 1000).getUTCFullYear(), 0, 1) / 1000;
  if (r.token === "1D") return lastSec - (lastSec % 86400);
  return r.days === null ? null : lastSec - r.days * 86400;
}

export const INDICATORS = ["SMA", "EMA", "BB", "VWAP", "RSI", "MACD", "ATR"] as const;
export type Indicator = (typeof INDICATORS)[number];

/** Studies drawn in their own pane below the price. */
export const LOWER_PANE: readonly Indicator[] = ["RSI", "MACD", "ATR"];

export const CHART_TYPES = ["CANDLE", "OHLC", "LINE", "AREA"] as const;
export type ChartType = (typeof CHART_TYPES)[number];

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A custom date field value: YYYY-MM-DD that is a real date. */
export function isDate(s: string): boolean {
  if (!DATE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(s);
}

/** Bar-time seconds of a YYYY-MM-DD at 00:00 (bar times are wall clock, encoded as UTC). */
export function dateSec(s: string): number {
  return Date.parse(`${s}T00:00:00Z`) / 1000;
}

export interface GpState {
  tf: Interval;
  /** Range token (`1Y`…) or undefined for the timeframe's default window. */
  range?: string;
  /** Custom window (amber date fields): replaces the range when set. */
  from?: string;
  to?: string;
  type: ChartType;
  ind: Indicator[];
  log: boolean;
  vol: boolean;
  lines: number[];
  /** Compare overlays (`CMP=`), up to MAX_COMPARE symbols. */
  cmp: string[];
  /** Event markers shown (`EV=`): earnings, dividends, splits. */
  ev: EventKind[];
}

export const EVENT_KINDS = ["E", "D", "S"] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export const DEFAULT_GP: GpState = {
  tf: "1d",
  type: "CANDLE",
  ind: [],
  log: false,
  vol: true,
  lines: [],
  cmp: [],
  ev: ["E", "D", "S"],
};

/** Days of history to ask for so a custom window starting at `from` is loaded. */
export function lookbackFor(from: string, nowMs: number): number {
  return Math.max(1, Math.ceil((nowMs / 1000 - dateSec(from)) / 86400) + 7);
}

export function timeframe(key: Interval): Timeframe {
  return TIMEFRAMES.find((t) => t.key === key) ?? TIMEFRAMES[6]!;
}

export function isIntraday(tf: Interval): boolean {
  return !["1d", "1wk", "1mo"].includes(tf);
}

export function parseGpArgs(args: string[]): GpState {
  const st: GpState = { ...DEFAULT_GP, ind: [], lines: [], cmp: [], ev: [...DEFAULT_GP.ev] };
  let explicitTf = false;
  for (const raw of args) {
    const a = raw.toUpperCase();
    const tf = TIMEFRAMES.find((t) => t.tokens.includes(a));
    const range = RANGES.find((r) => r.token === a);
    if (tf) {
      st.tf = tf.key;
      explicitTf = true;
    } else if (range) {
      st.range = range.token;
      if (!explicitTf) st.tf = range.tf;
    } else if ((INDICATORS as readonly string[]).includes(a)) {
      if (!st.ind.includes(a as Indicator)) st.ind.push(a as Indicator);
    } else if ((CHART_TYPES as readonly string[]).includes(a)) st.type = a as ChartType;
    else if (a.startsWith("FROM=") && isDate(a.slice(5))) st.from = a.slice(5);
    else if (a.startsWith("TO=") && isDate(a.slice(3))) st.to = a.slice(3);
    else if (a.startsWith("CMP=") && a.length > 4) {
      const sym = cmpSymbol(a.slice(4));
      if (!st.cmp.includes(sym) && st.cmp.length < MAX_COMPARE) st.cmp.push(sym);
    } else if (a.startsWith("EV=")) {
      const v = a.slice(3);
      st.ev = v === "NONE" ? [] : EVENT_KINDS.filter((k) => v.includes(k));
    } else if (a === "LOG") st.log = true;
    else if (a === "NOVOL") st.vol = false;
    else if (a.startsWith("HL=")) {
      const p = Number(a.slice(3));
      if (Number.isFinite(p) && p > 0) st.lines.push(p);
    }
  }
  st.ind = INDICATORS.filter((i) => st.ind.includes(i));
  if (st.from) delete st.range; // the custom window wins
  if (st.to && !st.from) delete st.to;
  return st;
}

export function formatGpArgs(st: GpState): string[] {
  const out: string[] = [timeframe(st.tf).tokens[st.tf === "1mo" ? 1 : 0]!];
  if (st.from) {
    out.push(`FROM=${st.from}`);
    if (st.to) out.push(`TO=${st.to}`);
  } else if (st.range) out.push(st.range);
  if (st.type !== "CANDLE") out.push(st.type);
  out.push(...INDICATORS.filter((i) => st.ind.includes(i)));
  if (st.log) out.push("LOG");
  if (!st.vol) out.push("NOVOL");
  for (const l of st.lines) out.push(`HL=${+l.toPrecision(10)}`);
  for (const c of st.cmp) out.push(cmpToken(c));
  if (st.ev.length < EVENT_KINDS.length) out.push(`EV=${st.ev.join("") || "NONE"}`);
  return out;
}

export function toggle<T>(list: T[], x: T): T[] {
  return list.includes(x) ? list.filter((y) => y !== x) : [...list, x];
}

/**
 * Bucket start (wall-clock seconds) of a live tick, anchored on the last known bar so that
 * session-aligned bars (e.g. 09:30 hourly) stay aligned. Returns null for ticks before it.
 */
export function bucketFor(lastBarT: number, tickWall: number, tf: Interval): number | null {
  if (tickWall < lastBarT) return null;
  if (!isIntraday(tf)) {
    const day = tickWall - (tickWall % 86400);
    if (tf === "1d") return day >= lastBarT ? day : null;
    // weekly/monthly: only update the current bar, never invent a new period
    return lastBarT;
  }
  const sec = timeframe(tf).seconds;
  const n = Math.floor((tickWall - lastBarT) / sec);
  const sameDay = Math.floor(tickWall / 86400) === Math.floor(lastBarT / 86400);
  // A new day starts a new session: anchor to the tick itself rounded to the interval.
  return sameDay ? lastBarT + n * sec : tickWall - (tickWall % sec);
}
