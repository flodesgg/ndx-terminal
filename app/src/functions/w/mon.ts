/**
 * MON (SPEC §8): the pure parts — columns from FLDS, group headers, sort within groups,
 * reordering, the add row's input and the full-list CSV.
 */
import type { Schemas } from "@/core/api";
import {
  fmtBig,
  fmtChange,
  fmtNum,
  fmtPct,
  fmtPrice,
  fmtVenueTime,
  NA,
  toAscii,
} from "@/lib/format";

export type FieldInfo = Schemas["FieldInfo"];
type Quote = Schemas["Quote"];
type Profile = Schemas["Profile"];

/** Group headers are rows written "#<name>" in the list's order (server: db.HEADER). */
export const HEADER = "#";
export const isHeader = (row: string) => row.startsWith(HEADER);
export const headerName = (row: string) => row.slice(HEADER.length);

/** SPEC §8 default: Ticker, Name, Last, Chg, %Chg, Bid, Ask, Volume, Time, Tag. Ticker and Tag
 * are always shown; the rest are FLDS ids. */
export const DEFAULT_COLS: readonly string[] = [
  "name",
  "px_last",
  "chg_net_1d",
  "chg_pct_1d",
  "px_bid",
  "px_ask",
  "volume",
  "last_update",
];
export const MAX_COLS = 16;

/** Short grid headers for common fields; any other field shows its FLDS name. */
const SHORT: Record<string, string> = {
  name: "NAME",
  px_last: "LAST",
  px_open: "OPEN",
  px_high: "HIGH",
  px_low: "LOW",
  px_close_1d: "PREV",
  chg_net_1d: "CHG",
  chg_pct_1d: "CHG%",
  px_bid: "BID",
  px_ask: "ASK",
  bid_size: "BID SZ",
  ask_size: "ASK SZ",
  volume: "VOLUME",
  volume_avg: "AVG VOL",
  last_update: "TIME",
  px_ext: "EXT",
  high_52w: "52W HI",
  low_52w: "52W LO",
  mkt_cap: "MKT CAP",
  pe_ttm: "P/E",
  pe_fwd: "FWD P/E",
  eps_ttm: "EPS",
  div_yield: "DIV YLD",
  shares_out: "SHARES",
  currency: "CCY",
};

export function colLabel(f: Pick<FieldInfo, "id" | "name">): string {
  return SHORT[f.id] ?? f.name.toUpperCase();
}

/** Stored column choice → known field ids, in order, deduplicated; empty or broken → default. */
export function parseCols(raw: unknown, known: ReadonlySet<string> | null): string[] {
  const list =
    raw && typeof raw === "object" && Array.isArray((raw as { cols?: unknown }).cols)
      ? (raw as { cols: unknown[] }).cols
      : null;
  if (!list) return [...DEFAULT_COLS];
  const out: string[] = [];
  for (const c of list) {
    if (typeof c !== "string" || out.includes(c)) continue;
    if (known && !known.has(c)) continue;
    out.push(c);
  }
  return out.length ? out.slice(0, MAX_COLS) : [...DEFAULT_COLS];
}

export const colsKey = (listId: number) => `mon-cols.${listId}`;

/** A field's value for one row: quote fields from the live quote, the rest from the profile. */
/** Reference fields the local security master states: no provider call, no profile. */
export const MASTER_FIELDS: readonly string[] = ["name", "currency", "exchange"];
export type MasterRecord = Partial<Record<"name" | "currency" | "exchange", string | null>>;

const pick = (o: unknown, k: string): unknown => {
  const v = o ? (o as Record<string, unknown>)[k] : null;
  return v === "" || v === undefined ? null : v;
};

/** A cell's value: quote fields from the quote; the rest from the profile; name, currency and
 * exchange fall back to the quote, then to the security master (a feed's /quote often has no
 * name: Finnhub's has none). */
export function fieldValue(
  f: Pick<FieldInfo, "id" | "domain" | "attr">,
  quote: Quote | null | undefined,
  profile: Profile | null | undefined,
  master?: MasterRecord | null,
): unknown {
  if (f.domain === "quotes") return pick(quote, f.attr);
  const v = pick(profile, f.attr);
  if (v !== null || !MASTER_FIELDS.includes(f.id)) return v;
  return pick(quote, f.attr) ?? pick(master, f.id);
}

const num = (v: unknown) => (typeof v === "number" ? v : null);

/** Display text through the shared formatters (§4.2); missing is N.A. */
export function fmtField(
  f: Pick<FieldInfo, "kind">,
  v: unknown,
  symbol: string,
  ref?: number | null,
): string {
  switch (f.kind) {
    case "price":
      return fmtPrice(num(v), symbol);
    case "change":
      return fmtChange(num(v), symbol, ref);
    case "pct":
      return fmtPct(num(v));
    case "volume":
    case "money":
      return fmtBig(num(v));
    case "ratio":
      return fmtNum(num(v));
    case "time":
      return typeof v === "string" || typeof v === "number" ? fmtVenueTime(v, symbol) : NA;
    case "text":
      return typeof v === "string" && v.trim() ? v : NA;
  }
}

export interface Group {
  /** Header row text without "#", or null for the rows before the first header. */
  header: string | null;
  symbols: string[];
}

export function groupRows(rows: readonly string[]): Group[] {
  const groups: Group[] = [{ header: null, symbols: [] }];
  for (const r of rows) {
    if (isHeader(r)) groups.push({ header: headerName(r), symbols: [] });
    else groups[groups.length - 1]!.symbols.push(r);
  }
  return groups[0]!.symbols.length ? groups : groups.slice(1);
}

export type DisplayRow =
  { kind: "header"; row: string; name: string } | { kind: "sym"; row: string };

/** Header rows stay where they are; with a sort, symbols sort inside their own group. */
export function displayRows(
  rows: readonly string[],
  cmp: ((a: string, b: string) => number) | null,
): DisplayRow[] {
  const out: DisplayRow[] = [];
  for (const g of groupRows(rows)) {
    if (g.header !== null) out.push({ kind: "header", row: HEADER + g.header, name: g.header });
    const syms = cmp ? [...g.symbols].sort(cmp) : g.symbols;
    for (const s of syms) out.push({ kind: "sym", row: s });
  }
  return out;
}

/** Comparator on a value getter: missing values last whatever the direction. */
export function sortBy(
  get: (sym: string) => number | string | null,
  desc: boolean,
): (a: string, b: string) => number {
  return (a, b) => {
    const x = get(a);
    const y = get(b);
    if (x === null && y === null) return 0;
    if (x === null) return 1;
    if (y === null) return -1;
    const c =
      typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y));
    return desc ? -c : c;
  };
}

/** Move one row (symbol or header) up or down the list order; null when it cannot move. */
export function moveRow(rows: readonly string[], row: string, delta: -1 | 1): string[] | null {
  const i = rows.indexOf(row);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= rows.length) return null;
  const next = [...rows];
  [next[i], next[j]] = [next[j]!, next[i]!];
  return next;
}

/**
 * The amber add row: "AAPL MSFT" adds symbols, "#Banks" (or "# Banks") a group header.
 * Inserted after `after` (the selected row) or at the end.
 */
export function parseAdd(text: string): { header: string | null; symbols: string[] } {
  const t = text.trim();
  if (t.startsWith(HEADER)) {
    const name = t.slice(1).trim().replace(/\s+/g, " ");
    return { header: name || null, symbols: [] };
  }
  return { header: null, symbols: t.split(/[\s,]+/).filter(Boolean) };
}

export function insertRows(
  rows: readonly string[],
  add: readonly string[],
  after?: string,
): string[] {
  const fresh = add.filter((r) => !rows.includes(r));
  const i = after ? rows.indexOf(after) : -1;
  if (i < 0) return [...rows, ...fresh];
  return [...rows.slice(0, i + 1), ...fresh, ...rows.slice(i + 1)];
}

function csvCell(text: string): string {
  const t = toAscii(text).replace(/\s+/g, " ").trim();
  return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
}

/** The whole list as CSV (every row, not only those on screen); each line carries its group. */
export function monCsv(
  head: readonly string[],
  rows: readonly DisplayRow[],
  cells: (sym: string) => readonly string[],
): string {
  const lines = [["GROUP", "TICKER", ...head].map(csvCell).join(",")];
  let group = "";
  for (const r of rows) {
    if (r.kind === "header") {
      group = r.name;
      continue;
    }
    lines.push([group, r.row, ...cells(r.row)].map(csvCell).join(","));
  }
  return lines.join("\n");
}
