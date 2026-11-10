/**
 * Local security index (SPEC §4.3 rule 6, §4.7): resolves what the user typed to a canonical ID
 * without a round trip. Loaded once from `/secmaster/index` (tables + runtime seeds; DEMO:
 * fixtures) and refreshed in the background; an empty index degrades to "unverified" (the
 * providers decide), never to a guess.
 */
import { api, clientLog, errorMessage, type Schemas } from "./api";
import { fuzzyScore } from "./command/fuzzy";
import { EXCHANGES, formatCanonical, type Sector } from "./secmaster";

export interface SecItem {
  id: string;
  ticker: string;
  exchange?: string;
  sector: Sector;
  name: string;
  aliases: readonly string[];
}

export interface SecIndex {
  items: readonly SecItem[];
  byId: ReadonlyMap<string, SecItem>;
  /** Ticker or provider alias → items (several when a ticker is listed in several places). */
  byKey: ReadonlyMap<string, readonly SecItem[]>;
  complete: ReadonlySet<string>;
  fiat: ReadonlySet<string>;
}

export type Resolution =
  | { status: "known"; id: string; item: SecItem }
  /** Not in an exhaustive list we hold: passed on as typed, providers decide. */
  | { status: "unverified"; id: string }
  | { status: "unknown"; query: string; suggestions: string[] }
  | { status: "ambiguous"; query: string; options: string[] };

export function buildIndex(
  raw: Pick<Schemas["SecIndex"], "items" | "complete" | "fiat">,
): SecIndex {
  const items: SecItem[] = [];
  const byId = new Map<string, SecItem>();
  const byKey = new Map<string, SecItem[]>();
  const key = (k: string, it: SecItem) => {
    const list = byKey.get(k);
    if (!list) byKey.set(k, [it]);
    else if (!list.includes(it)) list.push(it);
  };
  for (const [id, name, ...aliases] of raw.items) {
    if (!id) continue;
    const parts = id.split(" ");
    const sector = parts[parts.length - 1] as Sector;
    const it: SecItem = {
      id,
      ticker: parts[0]!,
      exchange: parts.length === 3 ? parts[1] : undefined,
      sector,
      name: name ?? "",
      aliases,
    };
    items.push(it);
    byId.set(id, it);
    key(it.ticker, it);
    for (const a of aliases) key(a.toUpperCase(), it);
  }
  return { items, byId, byKey, complete: new Set(raw.complete), fiat: new Set(raw.fiat) };
}

export const EMPTY_INDEX: SecIndex = buildIndex({ items: [], complete: [], fiat: [] });

let current: SecIndex = EMPTY_INDEX;
const listeners = new Set<() => void>();

export function secIndex(): SecIndex {
  return current;
}

export function setSecIndex(ix: SecIndex): void {
  current = ix;
  listeners.forEach((l) => l());
}

export function onSecIndex(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/**
 * Work to do on a freshly built index before it goes live (the autocomplete's sorted arrays), so
 * the first keystroke after a refresh does not pay for it (§2: suggestions < 30 ms).
 */
const warmers = new Set<(ix: SecIndex) => void>();
export function addIndexWarmer(w: (ix: SecIndex) => void): void {
  warmers.add(w);
}

/** Load at startup and refresh periodically (seeds download in the background on first run). */
export function startSecIndex(refreshMs = 15 * 60_000): () => void {
  let stopped = false;
  const load = async () => {
    try {
      const raw = await api.get<Schemas["SecIndex"]>("/secmaster/index");
      if (stopped) return;
      const ix = buildIndex(raw);
      warmers.forEach((w) => w(ix));
      setSecIndex(ix);
    } catch (e) {
      clientLog("warn", `security index unavailable: ${errorMessage(e)}`);
    }
  };
  void load();
  const first = setTimeout(() => void load(), 60_000); // seeds usually land within a minute
  const timer = setInterval(() => void load(), refreshMs);
  return () => {
    stopped = true;
    clearTimeout(first);
    clearInterval(timer);
  };
}

// ---------- resolution ----------

function universe(it: { sector: Sector; exchange?: string; ticker: string }, ix: SecIndex) {
  if (it.sector === "EQUITY") return it.exchange ?? "";
  if (it.sector === "CURNCY") return isFiatPair(it.ticker, ix) ? "FIAT" : "CRYPTO";
  return it.sector;
}

function isFiatPair(t: string, ix: SecIndex): boolean {
  return t.length === 6 && ix.fiat.has(t.slice(0, 3)) && ix.fiat.has(t.slice(3));
}

/** Up to `n` nearby IDs for an unknown security (same ticker elsewhere, then fuzzy). */
export function suggest(query: string, ix: SecIndex, sector?: Sector, n = 5): string[] {
  const t = query.split(" ")[0]!;
  const scored: [number, string][] = [];
  for (const it of ix.items) {
    if (sector && it.sector !== sector) continue;
    const s = Math.max(
      fuzzyScore(t, it.ticker) ?? 0,
      (fuzzyScore(it.ticker, t) ?? 0) * 0.8, // a typo with an extra letter: ZZZZ → ZZZ
      (fuzzyScore(t, it.name) ?? 0) * 0.5,
    );
    if (s >= 200) scored.push([s, it.id]);
  }
  scored.sort((a, b) => b[0] - a[0] || a[1].localeCompare(b[1]));
  return scored.slice(0, n).map(([, id]) => id);
}

/** A canonical ID typed in full (`AAPL US EQUITY`, `CL1 COMDTY`, `EURUSD CURNCY`). */
export function resolveCanonical(
  parts: { ticker: string; exchange?: string; sector: Sector },
  ix: SecIndex,
  opts: { suggest?: boolean } = {},
): Resolution {
  const id = formatCanonical(parts);
  const near = (s: Sector) => (opts.suggest === false ? [] : suggest(id, ix, s));
  const hit = ix.byId.get(id);
  if (hit) return { status: "known", id, item: hit };
  if (parts.sector === "CURNCY" && isFiatPair(parts.ticker, ix)) {
    const item: SecItem = { id, ticker: parts.ticker, sector: "CURNCY", name: "", aliases: [] };
    return { status: "known", id, item };
  }
  if (ix.complete.has(universe(parts, ix))) {
    return { status: "unknown", query: id, suggestions: near(parts.sector) };
  }
  // Not a pair of known fiat codes and not a crypto quote form: unknown, once we know the codes.
  if (ix.fiat.size && parts.sector === "CURNCY" && !/USD[CT]?$|FDUSD$/.test(parts.ticker)) {
    return { status: "unknown", query: id, suggestions: near("CURNCY") };
  }
  return { status: "unverified", id };
}

/**
 * Rule 6: a ticker without exchange (or without sector) → its primary listing: US for US
 * names, else the user's default exchange; a unique match runs, several give a picker.
 */
export function resolveBare(
  raw: string,
  ix: SecIndex,
  opts: { sector?: Sector; defaultExchange?: string; suggest?: boolean } = {},
): Resolution {
  const t = raw.toUpperCase();
  let hits = [...(ix.byKey.get(t) ?? [])];
  if (opts.sector) hits = hits.filter((h) => h.sector === opts.sector);
  if (!opts.sector || opts.sector === "CURNCY") {
    if (isFiatPair(t, ix) && !hits.some((h) => h.id === `${t} CURNCY`)) {
      hits.push({ id: `${t} CURNCY`, ticker: t, sector: "CURNCY", name: "", aliases: [] });
    }
  }
  if (hits.length > 1) {
    const exact = hits.filter((h) => h.ticker === t);
    if (exact.length >= 1 && exact.length < hits.length) hits = exact;
  }
  // The same code in different sectors (`DAX` index vs a US ETF, `CAC` index vs a US stock):
  // the user picks; preferring the US listing applies among equities only (rule 6).
  if (!opts.sector && new Set(hits.map((h) => h.sector)).size > 1) {
    return { status: "ambiguous", query: t, options: hits.map((h) => h.id).sort() };
  }
  if (hits.length > 1) {
    const pick =
      hits.find((h) => h.sector === "EQUITY" && h.exchange === "US") ??
      hits.find((h) => h.sector === "EQUITY" && h.exchange === opts.defaultExchange);
    if (pick) return { status: "known", id: pick.id, item: pick };
    return { status: "ambiguous", query: t, options: hits.map((h) => h.id).sort() };
  }
  if (hits.length === 1) return { status: "known", id: hits[0]!.id, item: hits[0]! };
  // A provider-style symbol we cannot map (`ENI.MI`, `ZZ=F`, `^XYZ`): passed on as typed.
  if (/[.^=]/.test(t)) return { status: "unverified", id: t };
  const sector = opts.sector ?? "EQUITY";
  const where = sector === "EQUITY" ? "US" : universe({ ticker: t, sector }, ix);
  if (ix.complete.has(where)) {
    const suggestions = opts.suggest === false ? [] : suggest(t, ix, opts.sector);
    return { status: "unknown", query: t, suggestions };
  }
  return { status: "unverified", id: t };
}

export function isExchangeCode(s: string): boolean {
  return EXCHANGES.has(s);
}
