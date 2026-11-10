/** GLCO spot block: official daily/monthly commodity prices from FRED series (SPEC §7). */
import type { Schemas } from "@/core/api";

export interface SpotSeries {
  id: string;
  label: string;
  group: string;
}

/** FRED series ids (checked on fred.stlouisfed.org): EIA spot prices, IMF monthly metals. */
export const SPOT_SERIES: readonly SpotSeries[] = [
  { id: "DCOILWTICO", label: "WTI crude, Cushing spot", group: "ENERGY" },
  { id: "DCOILBRENTEU", label: "Brent crude, Europe spot", group: "ENERGY" },
  { id: "DHHNGSP", label: "Henry Hub natural gas spot", group: "ENERGY" },
  { id: "PCOPPUSDM", label: "Copper, global price", group: "METALS" },
  { id: "PALUMUSDM", label: "Aluminium, global price", group: "METALS" },
];

export interface SpotRow {
  last: number | null;
  date: string | null;
  prev: number | null;
  prevDate: string | null;
  chg: number | null;
  pct: number | null;
}

/** The last observation against the one before it (points come oldest first). */
export function spotRow(series: Schemas["MacroSeries"] | undefined): SpotRow {
  const pts = series?.data ?? [];
  const a = pts[pts.length - 1];
  const b = pts[pts.length - 2];
  const last = a ? a.value : null;
  const prev = b ? b.value : null;
  const chg = last !== null && prev !== null ? last - prev : null;
  const pct = chg !== null && prev ? (chg / prev) * 100 : null;
  return { last, date: a?.date ?? null, prev, prevDate: b?.date ?? null, chg, pct };
}
