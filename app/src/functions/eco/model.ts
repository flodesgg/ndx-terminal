/**
 * ECO (SPEC §8) — pure helpers: filter tokens (country, importance, date range), the next
 * event, value labels. Events, times and actual/prior come from the server (`/eco`,
 * server/ndx_server/eco.py, data/symbology/eco_events.csv).
 */
import type { Schemas } from "@/core/api";
import { fmtDate, fmtNum, NA } from "@/lib/format";

export type EcoEvent = Schemas["EcoEvent"];
export type EcoResponse = Schemas["EcoResponse"];

export const COUNTRIES = ["US", "EZ", "DE", "DK", "UK", "JP", "CN"] as const;
export type Country = (typeof COUNTRIES)[number];
export const COUNTRY_LABEL: Record<Country, string> = {
  US: "United States",
  EZ: "Euro area",
  DE: "Germany",
  DK: "Denmark",
  UK: "United Kingdom",
  JP: "Japan",
  CN: "China",
};

/** Minimum importance: `HIGH` = 3 only, `MED` = 2 and up. */
export const IMPORTANCE = [
  { token: "MED", min: 2, label: "●● and up" },
  { token: "HIGH", min: 3, label: "●●● only" },
] as const;

export const RANGES = [
  { token: "WEEK", label: "Yesterday + 6 days", from: -1, to: 6 },
  { token: "TODAY", label: "Today", from: 0, to: 0 },
  { token: "2W", label: "Next 2 weeks", from: 0, to: 14 },
  { token: "PAST", label: "Past week", from: -7, to: 0 },
] as const;
export type RangeToken = (typeof RANGES)[number]["token"];

/** The window the server is asked for once; ranges filter it locally. */
export const FETCH_DAYS_BACK = 7;
export const FETCH_DAYS_AHEAD = 14;

export interface EcoFilter {
  country: Country | null;
  minImportance: 1 | 2 | 3;
  range: RangeToken;
}

export const NO_FILTER: EcoFilter = { country: null, minImportance: 1, range: "WEEK" };

export function filterFromArgs(args: readonly string[]): EcoFilter {
  const f: EcoFilter = { ...NO_FILTER };
  for (const raw of args) {
    const a = raw.toUpperCase();
    if ((COUNTRIES as readonly string[]).includes(a)) f.country = a as Country;
    const imp = IMPORTANCE.find((x) => x.token === a);
    if (imp) f.minImportance = imp.min;
    const r = RANGES.find((x) => x.token === a);
    if (r) f.range = r.token;
  }
  return f;
}

export const FILTER_TOKENS: readonly string[] = [
  ...COUNTRIES,
  ...IMPORTANCE.map((x) => x.token),
  ...RANGES.map((x) => x.token),
];

const DAY = 86_400_000;

/** Events inside the filter; days are counted in the user's zone (default Copenhagen). */
export function applyFilter(events: readonly EcoEvent[], f: EcoFilter, now: number): EcoEvent[] {
  const r = RANGES.find((x) => x.token === f.range) ?? RANGES[0];
  const from = fmtDate(now + r.from * DAY);
  const to = fmtDate(now + r.to * DAY);
  return events.filter((e) => {
    const day = fmtDate(e.time);
    return (
      day >= from &&
      day <= to &&
      (!f.country || e.country === f.country) &&
      e.importance >= f.minImportance
    );
  });
}

/** The first event not yet released (the server's clock). */
export function nextEvent(events: readonly EcoEvent[], now: number): EcoEvent | undefined {
  return events.find((e) => Date.parse(e.time) > now);
}

/** `2.2%`, `221K`, `-78.3bn`, or N.A. */
export function fmtValue(v: number | null | undefined, unit: string, digits: number): string {
  if (v === null || v === undefined) return NA;
  const n = fmtNum(v, digits);
  return unit ? `${n}${unit}` : n;
}

export function importanceDots(n: number): string {
  return "●".repeat(Math.max(0, Math.min(3, n)));
}
