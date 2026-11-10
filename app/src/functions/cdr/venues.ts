/** CDR data transforms: filtering, hours in the venue's own zone, countdowns. */
import type { Schemas } from "@/core/api";
import { fmtDate, fmtHM, NA } from "@/lib/format";

export type Venue = Schemas["VenueInfo"];
export type Session = Schemas["SessionTimes"];
export type VenueState = NonNullable<Venue["state"]>;

/** `CDR [WORDS]`: venues whose code, MIC, name or country contains every word. */
export function filterVenues(venues: Venue[], args: readonly string[]): Venue[] {
  const words = args.map((a) => a.toUpperCase()).filter(Boolean);
  if (!words.length) return venues;
  return venues.filter((v) => {
    const hay = `${v.code} ${v.mic} ${v.name} ${v.country}`.toUpperCase();
    return words.every((w) => hay.includes(w));
  });
}

/** Colour class of a state (§4.2): open up-colour, break/holiday amber, closed dim. */
export function stateClass(state: Venue["state"]): string {
  if (state === "OPEN") return "up";
  if (state === "BREAK" || state === "HOLIDAY") return "amber";
  return "dim";
}

/** `09:00–17:00` in the venue's zone, with the lunch break and an early-close mark. */
export function fmtHours(s: Session | null | undefined, tz: string): string {
  if (!s) return NA;
  let out = `${fmtHM(s.open, tz)}–${fmtHM(s.close, tz)}`;
  if (s.break_start && s.break_end)
    out += ` (break ${fmtHM(s.break_start, tz)}–${fmtHM(s.break_end, tz)})`;
  if (s.early_close) out += " early close";
  return out;
}

/** Time until `iso`: `in 2h 05m`, `in 3d 4h`, `now`. */
export function countdown(iso: string | null | undefined, now: number): string {
  if (!iso) return NA;
  const s = Math.round((new Date(iso).getTime() - now) / 1000);
  if (s <= 0) return "now";
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `in ${d}d ${h}h`;
  if (h > 0) return `in ${h}h ${String(m).padStart(2, "0")}m`;
  return `in ${m}m`;
}

/** UTC offset as `UTC+1`, `UTC−5`, `UTC+5:30`. */
export function fmtOffset(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return NA;
  const sign = seconds < 0 ? "−" : "+";
  const abs = Math.abs(seconds);
  const h = Math.floor(abs / 3600);
  const m = Math.floor((abs % 3600) / 60);
  return `UTC${sign}${h}${m ? `:${String(m).padStart(2, "0")}` : ""}`;
}

/** The first holiday or early close ahead, as one line. */
export function nextSpecial(v: Venue): string {
  const d = v.special[0];
  if (!d) return NA;
  return describeSpecial(d, v.tz);
}

export function describeSpecial(d: Schemas["SpecialDay"], tz: string): string {
  if (d.kind === "early_close") return `${d.day} early close ${d.close ? fmtHM(d.close, tz) : NA}`;
  return `${d.day} ${d.name ?? "holiday"}`;
}

/** The clock change ahead, e.g. `2027-03-14 → UTC−4`. */
export function fmtDst(v: Venue): string {
  if (!v.dst_change) return "none";
  return `${fmtDate(v.dst_change, v.tz)} → ${fmtOffset(v.dst_offset_s)}`;
}
