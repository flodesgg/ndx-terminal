/**
 * The shared formatters (SPEC §4.2). Every number, date and time on screen goes through here.
 *
 * - Missing values (`null`, `undefined`, non-finite) render as `N.A.` — never as 0 or a blank.
 * - Negative numbers carry a real minus (U+2212); signed values always show `+` or `−`.
 *   Copy/export goes through `toAscii` so the clipboard gets ASCII `-`.
 * - Precision by instrument class; large numbers as K/M/B/T with 2 dp.
 * - Times are stored in UTC; grids pass the exchange zone, news/status use the user zone
 *   (default Europe/Copenhagen). Dates are `YYYY-MM-DD`.
 */

import futuresCsv from "../../../data/symbology/futures.csv?raw";
import { venueTz } from "./venue";

export const NA = "N.A.";
export const MINUS = "−";
export const DEFAULT_TZ = "Europe/Copenhagen";

// ---------- configuration ----------

let group = ",";
let decimal = ".";
let userTz = DEFAULT_TZ;

/** Separators are configurable (SPEC §4.2); defaults are `,` thousands and `.` decimal. */
export function setNumberFormat(opts: { group?: string; decimal?: string }): void {
  if (opts.group !== undefined) group = opts.group;
  if (opts.decimal !== undefined) decimal = opts.decimal;
}

export function setUserTimeZone(tz: string): void {
  userTz = tz;
}

export function userTimeZone(): string {
  return userTz;
}

// ---------- core ----------

export function isNA(v: number | null | undefined): v is null | undefined {
  return v === null || v === undefined || !Number.isFinite(v);
}

/** Fixed-point with grouping, unsigned (`abs` must be >= 0). */
function fixed(abs: number, dp: number): string {
  const [int, frac] = abs.toFixed(dp).split(".");
  const grouped = int!.replace(/\B(?=(\d{3})+(?!\d))/g, group);
  return frac ? `${grouped}${decimal}${frac}` : grouped;
}

/** True when `v` rounds to zero at `dp` decimals (so no sign is shown: never `−0.00`). */
function roundsToZero(v: number, dp: number): boolean {
  return Number(Math.abs(v).toFixed(dp)) === 0;
}

function signed(v: number, body: string, dp: number, plus: boolean): string {
  if (roundsToZero(v, dp)) return body;
  if (v < 0) return `${MINUS}${body}`;
  return plus ? `+${body}` : body;
}

/** Plain number: grouping, `−` for negatives, no `+`. */
export function fmtNum(v: number | null | undefined, digits = 2): string {
  if (isNA(v)) return NA;
  return signed(v, fixed(Math.abs(v), digits), digits, false);
}

/** Always-signed number (`+1.23`, `−0.45`, `0.00`). */
export function fmtSigned(v: number | null | undefined, digits = 2): string {
  if (isNA(v)) return NA;
  return signed(v, fixed(Math.abs(v), digits), digits, true);
}

// ---------- instrument classes & precision ----------

export type PriceClass = "equity" | "etf" | "index" | "fx" | "crypto" | "yield" | "future";

const PRICE_CLASSES = new Set<string>([
  "equity",
  "etf",
  "index",
  "fx",
  "crypto",
  "yield",
  "future",
]);

// Mirrors server/ndx_server/symbols.py classify() until the security master (SPEC §5) supplies
// the class with every instrument.
const CURRENCIES = new Set(
  (
    "USD EUR JPY GBP CHF CAD AUD NZD SEK NOK DKK PLN CZK HUF UAH TRY CNY CNH HKD SGD KRW INR " +
    "MXN BRL ZAR ILS RON BGN ISK THB TWD IDR MYR PHP SAR AED RUB"
  ).split(" "),
);
const CRYPTO_RE = /^[A-Z0-9]{2,12}(USDT|USDC|FDUSD)$/;

/**
 * Futures tick sizes from the contract table (data/symbology/futures.csv), keyed by canonical
 * code (`NG1`) and provider symbol (`NG=F`): §4.2 "futures by tick size from the contract table".
 */
const TICKS: ReadonlyMap<string, number> = (() => {
  const rows = futuresCsv.split("\n").filter((l) => l.trim() && !l.startsWith("#"));
  const header = rows.shift()?.split(",") ?? [];
  const [id, yahoo, tick] = ["id", "yahoo", "tick_size"].map((c) => header.indexOf(c));
  const out = new Map<string, number>();
  for (const r of rows) {
    const cols = r.split(",");
    const t = Number(cols[tick!]);
    if (!Number.isFinite(t) || t <= 0) continue;
    out.set(cols[id!]!.trim(), t);
    if (cols[yahoo!]) out.set(cols[yahoo!]!.trim(), t);
  }
  return out;
})();

export interface PriceSpec {
  cls: PriceClass;
  /** FX pair with JPY on either side: 2 dp instead of 4. */
  jpy?: boolean;
  /** Futures tick size from the contract table; its decimals set the precision. */
  tick?: number;
}

/**
 * Instrument class from a canonical ID (`SPX INDEX`, `EURUSD CURNCY`, `CL1 COMDTY`) or a
 * provider symbol (`^GSPC`, `EURUSD`, `BTCUSDT`, `CL=F`).
 */
export function priceClassOf(symbol: string): PriceSpec {
  const parts = symbol.trim().toUpperCase().split(/\s+/);
  if (parts.length >= 2) {
    const sector = parts[parts.length - 1]!;
    const code = parts[0]!;
    if (sector === "INDEX")
      return /^[A-Z]{2}1$/.test(code) ? { cls: "future", tick: TICKS.get(code) } : { cls: "index" };
    if (sector === "COMDTY") return { cls: "future", tick: TICKS.get(code) };
    if (sector === "GOVT") return { cls: "yield" };
    if (sector === "CURNCY") {
      const a = code.slice(0, 3);
      const b = code.slice(3);
      if (code.length === 6 && CURRENCIES.has(a) && CURRENCIES.has(b))
        return { cls: "fx", jpy: a === "JPY" || b === "JPY" };
      return { cls: "crypto" };
    }
    return { cls: "equity" };
  }
  const s = parts[0] ?? "";
  if (s.startsWith("^")) return { cls: "index" };
  if (/^[A-Z0-9]{1,6}=F$/.test(s)) return { cls: "future", tick: TICKS.get(s) };
  const fx = s.replace(/=X$/, "").replace("/", "");
  if (fx.length === 6) {
    const a = fx.slice(0, 3);
    const b = fx.slice(3);
    if (a !== b && CURRENCIES.has(a) && CURRENCIES.has(b))
      return { cls: "fx", jpy: a === "JPY" || b === "JPY" };
  }
  if (CRYPTO_RE.test(s)) return { cls: "crypto" };
  return { cls: "equity" };
}

/** `PriceClass` name, a symbol, or a full spec; omitted = equity rules. */
export type PriceArg = PriceClass | string | PriceSpec | undefined;

function toSpec(arg: PriceArg): PriceSpec {
  if (arg === undefined) return { cls: "equity" };
  if (typeof arg !== "string") return arg;
  return PRICE_CLASSES.has(arg) ? { cls: arg as PriceClass } : priceClassOf(arg);
}

function tickDecimals(tick: number): number {
  const s = String(tick);
  if (s.includes("e-")) return Number(s.split("e-")[1]);
  return s.includes(".") ? s.split(".")[1]!.length : 0;
}

/**
 * Decimal places for a price (SPEC §4.2): equities/ETFs/indices 2 (4 below 1.00); FX 4 (JPY
 * pairs 2); crypto 2 at or above 1,000, up to 4 between 1 and 1,000, 6 significant digits below
 * 1; yields 3; futures by tick size (default 2).
 */
export function priceDigits(v: number, arg?: PriceArg): number {
  const spec = toSpec(arg);
  const a = Math.abs(v);
  switch (spec.cls) {
    case "fx":
      return spec.jpy ? 2 : 4;
    case "crypto":
      if (a >= 1000) return 2;
      if (a >= 1) return 4;
      if (a === 0) return 2;
      return Math.min(12, 5 - Math.floor(Math.log10(a)));
    case "yield":
      return 3;
    case "future":
      return spec.tick ? tickDecimals(spec.tick) : 2;
    default:
      return a < 1 && a !== 0 ? 4 : 2;
  }
}

/** Crypto between 1 and 1,000 shows 2–4 dp: trailing zeros past the second are dropped. */
function trimCrypto(body: string, v: number, spec: PriceSpec): string {
  const a = Math.abs(v);
  if (spec.cls !== "crypto" || a < 1 || a >= 1000) return body;
  const [i, f = ""] = body.split(decimal);
  return `${i}${decimal}${f.replace(/0{1,2}$/, "").padEnd(2, "0")}`;
}

/** A price at its class precision; negatives with `−` (spreads, futures). */
export function fmtPrice(v: number | null | undefined, arg?: PriceArg): string {
  if (isNA(v)) return NA;
  const spec = toSpec(arg);
  const dp = priceDigits(v, spec);
  return signed(v, trimCrypto(fixed(Math.abs(v), dp), v, spec), dp, false);
}

/**
 * Price format for chart libraries (axis ticks, last-value and crosshair labels), so a chart
 * renders through `fmtPrice` at class precision instead of the library's 2 dp default (§4.2).
 * `ref` is a typical price (e.g. the last close): it sets the tick step for crypto below 1.
 */
export function chartPriceFormat(
  arg: PriceArg | undefined,
  ref: number | null | undefined,
): { type: "custom"; formatter: (p: number) => string; minMove: number } {
  const dp = Math.min(12, priceDigits(isNA(ref) ? 1 : ref, arg));
  return { type: "custom", formatter: (p: number) => fmtPrice(p, arg), minMove: 10 ** -dp };
}

/**
 * A signed price change. Precision follows the price level (`ref`, e.g. the last price), not the
 * size of the change: a −0.87 move on a 461.50 index is `−0.87`, not `−0.8700`.
 */
export function fmtChange(
  v: number | null | undefined,
  arg?: PriceArg,
  ref?: number | null,
): string {
  if (isNA(v)) return NA;
  const spec = toSpec(arg);
  const level = isNA(ref) ? v : ref;
  const dp =
    isNA(ref) && (spec.cls === "equity" || spec.cls === "etf" || spec.cls === "index")
      ? 2
      : priceDigits(level, spec);
  return signed(v, fixed(Math.abs(v), dp), dp, true);
}

/** Percentage, 2 dp, signed by default (`+1.23%`, `−0.45%`). */
export function fmtPct(v: number | null | undefined, digits = 2, sign = true): string {
  if (isNA(v)) return NA;
  return `${signed(v, fixed(Math.abs(v), digits), digits, sign)}%`;
}

/** Yield in percent, 3 dp (`4.125`). */
export function fmtYield(v: number | null | undefined): string {
  return fmtNum(v, 3);
}

/** Large numbers: `2.95T`, `12.35M`, `−1.20B`; below 1,000 as an integer. */
export function fmtBig(v: number | null | undefined, digits = 2): string {
  if (isNA(v)) return NA;
  const a = Math.abs(v);
  const units: [number, string][] = [
    [1e3, "K"],
    [1e6, "M"],
    [1e9, "B"],
    [1e12, "T"],
  ];
  let i = -1;
  units.forEach(([n], k) => {
    if (a >= n) i = k;
  });
  if (i < 0) return fmtNum(v, 0);
  // Promote when rounding reaches the next unit: 999,999 → 1.00M, not 1,000.00K.
  if (i < units.length - 1 && Number((a / units[i]![0]).toFixed(digits)) >= 1000) i += 1;
  const [n, u] = units[i]!;
  return `${signed(v, fixed(a / n, digits), digits, false)}${u}`;
}

/** Signed big number for P&L: `+1.23K`, `−456`, `0` (the sign carries direction, §4.2). */
export function fmtBigSigned(v: number | null | undefined, digits = 2): string {
  if (isNA(v)) return NA;
  const body = fmtBig(v, digits);
  return v > 0 && /[1-9]/.test(body) ? `+${body}` : body;
}

/**
 * Up/down colour for a signed value. Pass the text shown (`shown`) when it is rounded: a value
 * that rounds to zero shows no sign, so it gets no colour either (§4.2: never colour alone).
 */
export function signClass(v: number | null | undefined, shown?: string): string {
  if (isNA(v) || v === 0) return "";
  if (shown !== undefined && !shown.startsWith("+") && !shown.startsWith(MINUS)) return "";
  return v > 0 ? "up" : "down";
}

/** Clipboard/export form: real minus back to ASCII `-`. */
export function toAscii(text: string): string {
  return text.replaceAll(MINUS, "-");
}

/** Copy handler: selections copied from the app carry ASCII minus signs (SPEC §4.2). */
export function installAsciiCopy(doc: Document = document): () => void {
  const onCopy = (e: ClipboardEvent) => {
    const text = doc.getSelection()?.toString() ?? "";
    if (!text.includes(MINUS) || !e.clipboardData) return;
    e.clipboardData.setData("text/plain", toAscii(text));
    e.preventDefault();
  };
  doc.addEventListener("copy", onCopy);
  return () => doc.removeEventListener("copy", onCopy);
}

// ---------- dates & times ----------

const dtfCache = new Map<string, Intl.DateTimeFormat>();

function dtf(kind: "time" | "hm" | "date" | "weekday", tz: string): Intl.DateTimeFormat {
  const key = `${kind}|${tz}`;
  let f = dtfCache.get(key);
  if (!f) {
    f =
      kind === "weekday"
        ? new Intl.DateTimeFormat("en-GB", { weekday: "short", timeZone: tz })
        : kind === "date"
          ? new Intl.DateTimeFormat("en-CA", {
              year: "numeric",
              month: "2-digit",
              day: "2-digit",
              timeZone: tz,
            })
          : new Intl.DateTimeFormat("en-GB", {
              hour: "2-digit",
              minute: "2-digit",
              ...(kind === "time" ? { second: "2-digit" } : {}),
              hourCycle: "h23",
              timeZone: tz,
            });
    dtfCache.set(key, f);
  }
  return f;
}

function parse(iso: string | number | Date | null | undefined): Date | null {
  if (iso === null || iso === undefined || iso === "") return null;
  const d = iso instanceof Date ? iso : new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** `YYYY-MM-DD` in `tz` (default: user zone). Date-only strings are returned unchanged. */
export function fmtDate(iso: string | number | Date | null | undefined, tz = userTz): string {
  if (typeof iso === "string" && DATE_ONLY.test(iso)) return iso;
  const d = parse(iso);
  return d ? dtf("date", tz).format(d) : NA;
}

/**
 * `HH:MM:SS` in `tz` (grids pass the exchange zone; default is the user zone). With
 * `withDate`, values from another day become `YYYY-MM-DD HH:MM`.
 */
export function fmtTime(
  iso: string | number | Date | null | undefined,
  withDate = false,
  tz = userTz,
  now: number = Date.now(),
): string {
  const d = parse(iso);
  if (!d) return NA;
  if (withDate && fmtDate(d, tz) !== fmtDate(now, tz))
    return `${fmtDate(d, tz)} ${dtf("hm", tz).format(d)}`;
  return dtf("time", tz).format(d);
}

/**
 * Grid TIME cell (§4.2): exchange-local `HH:MM:SS` for the symbol's venue (equities, indices,
 * futures); FX, crypto and rates have no single venue and use the user zone. Another day shows
 * the date.
 */
export function fmtVenueTime(
  iso: string | number | Date | null | undefined,
  symbol: string,
  now: number = Date.now(),
): string {
  return fmtTime(iso, true, venueTz(symbol) ?? userTz, now);
}

/** Lightweight-charts tick kinds (TickMarkType), mirrored so this module needs no chart import. */
const TICK = { year: 0, month: 1, day: 2, time: 3, seconds: 4 } as const;

function zoneLabel(d: Date, tz: string): string {
  const key = `zone|${tz}`;
  let f = dtfCache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "short" });
    dtfCache.set(key, f);
  }
  return f.formatToParts(d).find((p) => p.type === "timeZoneName")?.value ?? tz;
}

/** UTC offset of `tz` at `epochS`, in seconds (DST-aware, from Intl). */
function offsetAt(tz: string, epochS: number): number {
  const key = `parts|${tz}`;
  let f = dtfCache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    dtfCache.set(key, f);
  }
  const p: Record<string, number> = {};
  for (const part of f.formatToParts(new Date(epochS * 1000))) p[part.type] = Number(part.value);
  const wall = Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!) / 1000;
  return wall - epochS;
}

/** A bar time encoded as `tz` wall-clock seconds (server `wall_clock`) back to a real epoch. */
export function unwallClock(t: number, tz: string): number {
  if (tz === "UTC") return t;
  const guess = t - offsetAt(tz, t);
  const off = offsetAt(tz, guess);
  return t - off;
}

/**
 * Chart time (§4.2, review 1a #10): the time axis and the crosshair go through the shared
 * date/time formatters instead of the library's own. Bar times arrive as wall-clock seconds in
 * the series zone (`seriesTz`; Binance and DEMO send real UTC). Intraday bars are shown in the
 * grids' zone: the exchange zone of a listed security (`venueTz`), else the user zone (FX,
 * crypto); the crosshair names the zone. The chart library places day/month/year ticks on the
 * UTC date changes of the times it is given, so `toChart` hands it display-zone wall-clock
 * times (kept strictly ascending across DST changes) and the labels show each bar's real
 * instant in that zone: ticks and labels share one clock (re-verify N7).
 * Daily and longer bars are calendar dates at 00:00, so they show as dates and never shift.
 */
export function chartTimeFormat(
  symbol: string,
  intraday: boolean,
  seriesTz = "UTC",
): {
  zone: string;
  toChart: (t: number) => number;
  timeFormatter: (time: unknown) => string;
  tickMarkFormatter: (time: unknown, type: number) => string;
} {
  const tz = intraday ? (venueTz(symbol) ?? userTz) : "UTC";
  // Wall clock is not monotonic: in a DST fall-back hour two real instants share one wall time,
  // and the chart needs strictly ascending times. Each bar time is mapped once (same result in
  // every pass: candles, volume, lines, MACD, live updates); a later bar that would not move
  // forward gets previous + 1 s, and labels read the bar's real instant back from `realOf`.
  const chartOf = new Map<number, number>();
  const realOf = new Map<number, number>();
  let lastT = -Infinity;
  let lastChart = -Infinity;
  const toChart = (t: number): number => {
    if (!intraday) return t;
    const known = chartOf.get(t);
    if (known !== undefined) return known;
    const real = unwallClock(t, seriesTz);
    let c = real + offsetAt(tz, real);
    if (t > lastT) {
      if (c <= lastChart) c = lastChart + 1;
      lastT = t;
      lastChart = c;
    }
    chartOf.set(t, c);
    realOf.set(c, real);
    return c;
  };
  // Intraday: the bar's real instant, read in `tz` (a time between bars: chart time as wall
  // clock). Daily: the calendar date, read in UTC.
  const at = (time: unknown): { d: Date; zone: string } | null => {
    if (typeof time !== "number" || !Number.isFinite(time)) return null;
    if (!intraday) return { d: new Date(time * 1000), zone: "UTC" };
    return { d: new Date((realOf.get(time) ?? unwallClock(time, tz)) * 1000), zone: tz };
  };
  return {
    zone: tz,
    toChart,
    timeFormatter: (time) => {
      const a = at(time);
      if (!a) return NA;
      const { d, zone } = a;
      if (!intraday) return fmtDate(d, zone);
      return `${fmtDate(d, zone)} ${dtf("hm", zone).format(d)} ${zoneLabel(d, zone)}`;
    },
    tickMarkFormatter: (time, type) => {
      const a = at(time);
      if (!a) return NA;
      const { d, zone } = a;
      const date = fmtDate(d, zone);
      if (type === TICK.year) return date.slice(0, 4);
      if (type === TICK.month) return date.slice(0, 7);
      if (type === TICK.day) return date.slice(5);
      if (type === TICK.seconds) return dtf("time", zone).format(d);
      return dtf("hm", zone).format(d);
    },
  };
}

/**
 * Scale for a series in price units that swings around zero (MACD): one precision for the whole
 * series, the price class's digits at the typical price `ref`, not per value (re-verify N8).
 */
export function chartSpreadFormat(
  arg: PriceArg | undefined,
  ref: number | null | undefined,
): { type: "custom"; formatter: (v: number) => string; minMove: number } {
  return chartNumberFormat(Math.min(12, priceDigits(isNA(ref) ? 1 : ref, arg)));
}

/** Oscillator scale (RSI 0–100) through the shared number formatter, not the library default. */
export function chartNumberFormat(digits = 2): {
  type: "custom";
  formatter: (v: number) => string;
  minMove: number;
} {
  return { type: "custom", formatter: (v: number) => fmtNum(v, digits), minMove: 10 ** -digits };
}

/** Day header for calendars: `Mon 2026-11-09`. */
export function fmtDayHeader(iso: string | number | Date | null | undefined, tz = userTz): string {
  const d = parse(iso);
  return d ? `${dtf("weekday", tz).format(d)} ${fmtDate(d, tz)}` : NA;
}

/** Same calendar day as `now` in `tz`. */
export function isSameDay(
  iso: string | number | Date | null | undefined,
  tz = userTz,
  now: number = Date.now(),
): boolean {
  const d = parse(iso);
  return d !== null && fmtDate(d, tz) === fmtDate(now, tz);
}

/** `HH:MM` in `tz` (news lists, status bar clocks). */
export function fmtHM(iso: string | number | Date | null | undefined, tz = userTz): string {
  const d = parse(iso);
  return d ? dtf("hm", tz).format(d) : NA;
}

/** Age as `12s`, `5m`, `3h`, `2d`. */
export function relTime(iso: string | null | undefined, now: number = Date.now()): string {
  const d = parse(iso);
  if (!d) return NA;
  const s = (now - d.getTime()) / 1000;
  if (s < 60) return `${Math.max(0, Math.round(s))}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

/** Time until a moment, for countdowns: `2d 3h`, `1h 05m`, `4m 07s`, `0s` once it passed. */
export function fmtCountdown(ms: number): string {
  if (!Number.isFinite(ms)) return NA;
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n: number) => String(n).padStart(2, "0");
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${pad(m)}m`;
  if (m > 0) return `${m}m ${pad(s % 60)}s`;
  return `${s}s`;
}

/** Direction glyph next to a value whose colour shows its change (never colour alone, §4.2). */
export function directionMark(change: number | null | undefined): string {
  if (isNA(change) || change === 0) return "";
  return change > 0 ? "▲" : "▼";
}
