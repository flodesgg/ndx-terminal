/** GP compare overlays (SPEC §8: "up to 5 normalized compare overlays"). */

export const MAX_COMPARE = 5;

export interface CBar {
  t: number;
  c: number;
}

export interface ComparePoint {
  /** Main series bar time. */
  t: number;
  /** The other close rebased onto the main's price at the base bar (plotted on its scale). */
  value: number;
  /** % change of the other since the base bar. */
  pct: number;
}

/**
 * Align `other` onto `main`'s bar times and rebase it so both start equal at the first common
 * bar at or after `fromT`. Bar times are each venue's wall clock: intraday bars are shifted by
 * the two series' UTC offsets so the same instant lines up; daily and longer bars match by date.
 */
export function rebase(
  main: readonly CBar[],
  mainOffsetS: number,
  other: readonly CBar[],
  otherOffsetS: number,
  fromT: number,
  intraday: boolean,
): ComparePoint[] {
  const shift = intraday ? mainOffsetS - otherOffsetS : 0;
  const byT = new Map(other.map((b) => [b.t + shift, b.c]));
  const start = main.findIndex((b) => b.t >= fromT && byT.has(b.t));
  if (start < 0) return [];
  const base = main[start]!;
  const otherBase = byT.get(base.t)!;
  if (!otherBase || !base.c) return [];
  const out: ComparePoint[] = [];
  for (let i = start; i < main.length; i++) {
    const c = byT.get(main[i]!.t);
    if (c === undefined) continue;
    out.push({ t: main[i]!.t, value: (c / otherBase) * base.c, pct: (c / otherBase - 1) * 100 });
  }
  return out;
}

/** `CMP=` arg value <-> symbol: spaces are written as `_` so a full ID fits one token. */
export const cmpToken = (symbol: string) =>
  `CMP=${symbol.trim().toUpperCase().replace(/\s+/g, "_")}`;
export const cmpSymbol = (value: string) => value.replace(/_/g, " ");
