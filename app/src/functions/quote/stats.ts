/** Q values the quote itself may not carry, computed from bars (SPEC §8 `Q`). Bar `t` is the
 * venue's wall-clock time encoded as unix seconds, so `floor(t / 86400)` is the venue date. */
import { lastSession } from "@/lib/series";

export interface OhlcvBar {
  t: number;
  h: number;
  l: number;
  c: number;
  v?: number | null;
}

const day = (t: number) => Math.floor(t / 86400);

/** Session VWAP from intraday bars of the last session: Σ(typical price × volume) / Σ volume.
 * Null when the bars carry no volume (indices, FX): VWAP needs traded volume. */
export function sessionVwap(bars: readonly OhlcvBar[]): number | null {
  let pv = 0;
  let vol = 0;
  for (const b of lastSession(bars)) {
    if (!b.v || b.v <= 0) continue;
    pv += ((b.h + b.l + b.c) / 3) * b.v;
    vol += b.v;
  }
  return vol > 0 ? pv / vol : null;
}

/** A session VWAP lies between the session's low and high; outside it, the bars are not the
 * quote's session (a stale or other-day series), so the value would be wrong: none. */
export function vwapForSession(
  vwap: number | null,
  low: number | null | undefined,
  high: number | null | undefined,
): number | null {
  if (vwap === null || low === null || low === undefined || high === null || high === undefined)
    return vwap;
  const slack = (high - low) * 0.001;
  return vwap >= low - slack && vwap <= high + slack ? vwap : null;
}

/** Average daily volume of the last `n` full sessions before `sessionDay` (the venue date of
 * the session in progress, whose volume is partial). Null unless all `n` sessions have volume. */
export function avgVolume(
  daily: readonly OhlcvBar[],
  n: number,
  sessionDay: number | null,
): number | null {
  const done = daily.filter((b) => sessionDay === null || day(b.t) < sessionDay);
  const last = done.slice(-n);
  if (last.length < n || last.some((b) => !b.v || b.v <= 0)) return null;
  return last.reduce((s, b) => s + (b.v ?? 0), 0) / n;
}

/** The venue date of the newest intraday bar: the session in progress or last traded. */
export function sessionDayOf(intraday: readonly OhlcvBar[]): number | null {
  const last = intraday[intraday.length - 1];
  return last ? day(last.t) : null;
}

/** 52-week low/high from daily bars within 365 days of the newest one. */
export function range52w(daily: readonly OhlcvBar[]): { low: number; high: number } | null {
  const last = daily[daily.length - 1];
  if (!last) return null;
  const from = last.t - 365 * 86400;
  const span = daily.filter((b) => b.t > from);
  // Less than ~11 months of history is not a 52-week range.
  if (!span.length || last.t - span[0]!.t < 330 * 86400) return null;
  return {
    low: Math.min(...span.map((b) => b.l)),
    high: Math.max(...span.map((b) => b.h)),
  };
}

/** Today's volume as a percentage of the 30-day average. */
export function volumeVsAvgPct(
  volume: number | null | undefined,
  avg: number | null | undefined,
): number | null {
  if (volume === null || volume === undefined || !avg) return null;
  return (volume / avg) * 100;
}
