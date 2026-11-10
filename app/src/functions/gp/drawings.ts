/**
 * GP drawings (SPEC §8: "Drawings (horizontal line, trend, rectangle, Fibonacci, text)
 * persisted per security"). Anchors are bar times (venue wall clock, as the bars endpoint
 * gives them) and prices, so a drawing made on one bar size shows on every other.
 */

export const DRAW_KINDS = ["HLINE", "TREND", "RECT", "FIB", "TEXT"] as const;
export type DrawKind = (typeof DRAW_KINDS)[number];

export const DRAW_LABEL: Record<DrawKind, string> = {
  HLINE: "Horizontal line",
  TREND: "Trend line",
  RECT: "Rectangle",
  FIB: "Fibonacci retracement",
  TEXT: "Text",
};

/** Points a tool needs before it is a drawing. */
export const DRAW_POINTS: Record<DrawKind, 1 | 2> = {
  HLINE: 1,
  TREND: 2,
  RECT: 2,
  FIB: 2,
  TEXT: 1,
};

export interface Anchor {
  t: number;
  p: number;
}

export interface Drawing {
  kind: DrawKind;
  a: Anchor;
  /** Second point (two-point tools). */
  b?: Anchor;
  /** Text tool only. */
  text?: string;
}

/** Most drawings kept per security; the oldest go first. */
export const MAX_DRAWINGS = 100;
export const MAX_TEXT = 80;

/** Retracement levels, 0 at the second point, 1 at the first. */
export const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1] as const;
export const FIB_LABELS = ["0%", "23.6%", "38.2%", "50%", "61.8%", "78.6%", "100%"] as const;

export function fibPrices(a: Anchor, b: Anchor): number[] {
  return FIB_LEVELS.map((l) => b.p + (a.p - b.p) * l);
}

const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const anchor = (v: unknown): Anchor | null => {
  const o = v as Record<string, unknown> | null;
  return o && num(o.t) && num(o.p) ? { t: o.t, p: o.p } : null;
};

/** A stored value → valid drawings; anything malformed is dropped, never guessed. */
export function parseDrawings(raw: unknown): Drawing[] {
  const items = (raw as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) return [];
  const out: Drawing[] = [];
  for (const it of items) {
    const o = it as Record<string, unknown> | null;
    const kind = o?.kind as DrawKind;
    if (!o || !DRAW_KINDS.includes(kind)) continue;
    const a = anchor(o.a);
    if (!a) continue;
    if (DRAW_POINTS[kind] === 2) {
      const b = anchor(o.b);
      if (b) out.push({ kind, a, b });
    } else if (kind === "TEXT") {
      const text = typeof o.text === "string" ? o.text.trim().slice(0, MAX_TEXT) : "";
      if (text) out.push({ kind, a, text });
    } else {
      out.push({ kind, a });
    }
  }
  return out.slice(-MAX_DRAWINGS);
}

/** user.db setting key for a security's drawings ("/" would end the URL path segment). */
export const drawingsKey = (symbol: string) =>
  `gp-drawings.${symbol.trim().toUpperCase().replace(/\//g, "_")}`;

/** Typical bar spacing at one end: the smallest of the last few gaps (weekends are not bars). */
function spacing(times: readonly number[], atEnd: boolean): number {
  const n = times.length;
  let best = Infinity;
  for (let k = 1; k <= Math.min(5, n - 1); k++) {
    const i = atEnd ? n - k : k;
    best = Math.min(best, times[i]! - times[i - 1]!);
  }
  return best > 0 && Number.isFinite(best) ? best : 86400;
}

/**
 * Fractional bar index of time `t` among ascending bar `times`: between bars it interpolates,
 * beyond either end it continues at the typical bar spacing. Null without bars.
 */
export function logicalOf(times: readonly number[], t: number): number | null {
  const n = times.length;
  if (!n) return null;
  if (n === 1) return (t - times[0]!) / 86400;
  if (t <= times[0]!) return (t - times[0]!) / spacing(times, false);
  if (t >= times[n - 1]!) return n - 1 + (t - times[n - 1]!) / spacing(times, true);
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid]! <= t) lo = mid;
    else hi = mid;
  }
  return lo + (t - times[lo]!) / (times[hi]! - times[lo]!);
}

/** Bar time at a (possibly fractional or out-of-range) bar index: the inverse of logicalOf. */
export function timeAtLogical(times: readonly number[], l: number): number | null {
  const n = times.length;
  if (!n) return null;
  if (n === 1) return times[0]! + l * 86400;
  if (l <= 0) return times[0]! + l * spacing(times, false);
  if (l >= n - 1) return times[n - 1]! + (l - (n - 1)) * spacing(times, true);
  const i = Math.floor(l);
  return times[i]! + (l - i) * (times[i + 1]! - times[i]!);
}
