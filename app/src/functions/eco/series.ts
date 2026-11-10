/**
 * ECST (SPEC §8) — pure helpers for the economic-series history view: chart ranges, x values,
 * the change between observations. Values arrive transformed from the server (`/eco/indicators/
 * {key}`, server/ndx_server/eco.py); nothing is computed here but differences for display.
 */
import type { Schemas } from "@/core/api";
import { COUNTRIES } from "./model";

export type EcoIndicator = Schemas["EcoIndicator"];
export type EcoHistory = Schemas["EcoHistoryResponse"];
export type EcoIndicatorsResponse = Schemas["EcoIndicatorsResponse"];
export type EcoObservation = Schemas["EcoObservation"];

export const ECST_RANGES = [
  { token: "2Y", years: 2 },
  { token: "5Y", years: 5 },
  { token: "10Y", years: 10 },
  { token: "MAX", years: null },
] as const;
export type EcstRange = (typeof ECST_RANGES)[number]["token"];

/** Observations inside the range, counted back from the newest one (not from today, so a
 * stale series still shows its last years). */
export function inRange(data: readonly EcoObservation[], range: EcstRange): EcoObservation[] {
  const r = ECST_RANGES.find((x) => x.token === range);
  if (!r || r.years === null || !data.length) return [...data];
  const last = data[data.length - 1]!.date;
  const from = `${Number(last.slice(0, 4)) - r.years}${last.slice(4)}`;
  return data.filter((o) => o.date > from);
}

/** Chart x: unix seconds of the period's first day (UTC). */
export function toSeconds(date: string): number {
  return Date.parse(`${date.slice(0, 10)}T00:00:00Z`) / 1000;
}

/** Newest first, each with the change from the observation before it. */
export function recent(
  data: readonly EcoObservation[],
  n: number,
): { obs: EcoObservation; chg: number | null }[] {
  const out: { obs: EcoObservation; chg: number | null }[] = [];
  for (let i = data.length - 1; i >= 0 && out.length < n; i--) {
    const prev = data[i - 1];
    out.push({ obs: data[i]!, chg: prev ? data[i]!.value - prev.value : null });
  }
  return out;
}

/** Indicators ordered as the ECO country filter, then by importance, then name. */
export function sortIndicators(xs: readonly EcoIndicator[]): EcoIndicator[] {
  const rank = (c: string) => {
    const i = (COUNTRIES as readonly string[]).indexOf(c);
    return i < 0 ? 99 : i;
  };
  return [...xs].sort(
    (a, b) =>
      rank(a.country) - rank(b.country) ||
      b.importance - a.importance ||
      a.event.localeCompare(b.event),
  );
}
