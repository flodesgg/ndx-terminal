/** GP event markers (SPEC §8 `E/D/S`): which bar each earnings, dividend or split falls on. */
import type { Schemas } from "@/core/api";
import type { EventKind } from "./args";

export type ChartEvent = Schemas["ChartEvent"];

/** Venue-local date (YYYY-MM-DD) → the day number bar times use (`floor(t / 86400)`). */
const dayOf = (date: string) => Math.floor(Date.parse(`${date}T00:00:00Z`) / 86_400_000);

/**
 * Events of the wanted kinds placed on bars: the last bar starting on or before the event's
 * date (a daily bar is that day, an intraday bar that day's last, a weekly bar its week).
 * Events before the first bar or after the last bar's day are left out (and counted).
 */
export function placeEvents(
  barTimes: readonly number[],
  events: readonly ChartEvent[],
  kinds: readonly EventKind[],
): { byBar: Map<number, ChartEvent[]>; outside: number } {
  const byBar = new Map<number, ChartEvent[]>();
  let outside = 0;
  const n = barTimes.length;
  if (!n) return { byBar, outside: events.filter((e) => kinds.includes(e.kind)).length };
  const lastDay = Math.floor(barTimes[n - 1]! / 86400);
  for (const e of events) {
    if (!kinds.includes(e.kind)) continue;
    const day = dayOf(e.date);
    if (!Number.isFinite(day) || day < Math.floor(barTimes[0]! / 86400) || day > lastDay) {
      outside++;
      continue;
    }
    // Last bar whose day is <= the event's day.
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (Math.floor(barTimes[mid]! / 86400) <= day) lo = mid;
      else hi = mid - 1;
    }
    const t = barTimes[lo]!;
    const list = byBar.get(t);
    if (list) list.push(e);
    else byBar.set(t, [e]);
  }
  return { byBar, outside };
}
