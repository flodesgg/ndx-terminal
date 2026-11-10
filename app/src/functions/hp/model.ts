/** HP — historical price table (SPEC §7, §8): periodicity, window, rows and summary. */
import type { Bar } from "@/core/live";
import { dateSec, isDate, rangeStart, type Interval } from "@/functions/gp/args";

export const PERIODS = ["D", "W", "M"] as const;
export type Period = (typeof PERIODS)[number];
export const PERIOD_INTERVAL: Record<Period, Interval> = { D: "1d", W: "1wk", M: "1mo" };
export const PERIOD_LABEL: Record<Period, string> = { D: "Daily", W: "Weekly", M: "Monthly" };

/** Windows HP offers (GP's tokens; intraday ones make no sense for a daily table). */
export const HP_RANGES = ["1M", "3M", "6M", "YTD", "1Y", "2Y", "5Y", "MAX"] as const;
const RANGE_DAYS: Record<string, number> = {
  "1M": 31,
  "3M": 92,
  "6M": 183,
  "1Y": 366,
  "2Y": 731,
  "5Y": 1827,
};

export interface HpState {
  per: Period;
  range?: string;
  from?: string;
  to?: string;
}

export const DEFAULT_HP: HpState = { per: "D", range: "3M" };

export function parseHpArgs(args: readonly string[]): HpState {
  const st: HpState = { ...DEFAULT_HP };
  for (const raw of args) {
    const a = raw.toUpperCase();
    if ((PERIODS as readonly string[]).includes(a)) st.per = a as Period;
    else if ((HP_RANGES as readonly string[]).includes(a)) st.range = a;
    else if (a.startsWith("FROM=") && isDate(a.slice(5))) st.from = a.slice(5);
    else if (a.startsWith("TO=") && isDate(a.slice(3))) st.to = a.slice(3);
  }
  if (st.from) delete st.range;
  if (st.to && !st.from) delete st.to;
  return st;
}

export function formatHpArgs(st: HpState): string[] {
  const out: string[] = [st.per];
  if (st.from) {
    out.push(`FROM=${st.from}`);
    if (st.to) out.push(`TO=${st.to}`);
  } else if (st.range) out.push(st.range);
  return out;
}

/** Days of history to ask for: the window plus a margin for the bar before it (its change). */
export function hpLookback(st: HpState, nowMs: number): number {
  const margin = st.per === "D" ? 10 : st.per === "W" ? 21 : 62;
  if (st.from) return Math.ceil((nowMs / 1000 - dateSec(st.from)) / 86400) + margin;
  if (st.range === "YTD") {
    const jan1 = Date.UTC(new Date(nowMs).getUTCFullYear(), 0, 1) / 1000;
    return Math.ceil((nowMs / 1000 - jan1) / 86400) + margin;
  }
  if (st.range === "MAX") return 365 * 30;
  return (RANGE_DAYS[st.range ?? "3M"] ?? 92) + margin;
}

export interface HpRow {
  bar: Bar;
  /** Close minus the previous bar's close; null for the first bar loaded. */
  chg: number | null;
  pct: number | null;
}

/** The window's bars, newest first, each with its change against the bar before. */
export function hpRows(bars: readonly Bar[], st: HpState): HpRow[] {
  if (!bars.length) return [];
  const last = bars[bars.length - 1]!.t;
  const start = st.from ? dateSec(st.from) : st.range ? (rangeStart(st.range, last) ?? 0) : 0;
  const end = st.from && st.to ? dateSec(st.to) + 86400 : Infinity;
  const out: HpRow[] = [];
  bars.forEach((b, i) => {
    if (b.t < start || b.t >= end) return;
    const prev = i > 0 ? bars[i - 1]!.c : null;
    out.push({
      bar: b,
      chg: prev === null ? null : b.c - prev,
      pct: prev ? (b.c / prev - 1) * 100 : null,
    });
  });
  return out.reverse();
}

export interface HpSummary {
  n: number;
  high: { v: number; t: number } | null;
  low: { v: number; t: number } | null;
  avgClose: number | null;
  /** Last close against the close before the window (N.A. when that bar is not loaded). */
  chg: number | null;
  pct: number | null;
  avgVolume: number | null;
}

export function hpSummary(rows: readonly HpRow[]): HpSummary {
  const n = rows.length;
  if (!n)
    return { n, high: null, low: null, avgClose: null, chg: null, pct: null, avgVolume: null };
  let high = { v: -Infinity, t: 0 };
  let low = { v: Infinity, t: 0 };
  let sum = 0;
  let vol = 0;
  let vols = 0;
  for (const r of rows) {
    if (r.bar.h > high.v) high = { v: r.bar.h, t: r.bar.t };
    if (r.bar.l < low.v) low = { v: r.bar.l, t: r.bar.t };
    sum += r.bar.c;
    if (r.bar.v != null) {
      vol += r.bar.v;
      vols++;
    }
  }
  const oldest = rows[n - 1]!;
  const base = oldest.chg === null ? null : oldest.bar.c - oldest.chg;
  const lastClose = rows[0]!.bar.c;
  return {
    n,
    high,
    low,
    avgClose: sum / n,
    chg: base === null ? null : lastClose - base,
    pct: base ? (lastClose / base - 1) * 100 : null,
    // Bars without volume (an index) are left out; none at all is N.A., never 0.
    avgVolume: vols ? vol / vols : null,
  };
}
