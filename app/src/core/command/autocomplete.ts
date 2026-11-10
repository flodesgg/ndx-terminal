/**
 * Local autocomplete (SPEC §4.7): functions, securities, sector menus, saved layouts and notes,
 * ranked exact mnemonic > exact ticker > recently used > prefix > fuzzy. Everything is in
 * memory (the security index, the registry), so it works offline and answers in < 30 ms even
 * over tens of thousands of securities: tickers sit in a sorted array (binary-searched
 * prefixes), names in a word-start list; the fuzzy pass runs only when those come up short.
 */
import type { Sector } from "@/core/secmaster";
import { addIndexWarmer, resolveBare, type SecIndex, type SecItem } from "@/core/secindex";
import { SECTOR_KEYS, sectorToken, type SectorToken } from "@/core/sectors";
import { fuzzyScore } from "./fuzzy";
import { hasCyrillic, layoutFixed } from "./layouts";
import { normalizeInput, parse, type ParseContext } from "./parser";

export type CompletionKind =
  "FIXED" | "FUNCTION" | "SECURITY" | "SECTOR" | "ARG" | "LAYOUT" | "NOTE" | "SEARCH";

export interface Completion {
  key: string;
  kind: CompletionKind;
  label: string;
  desc: string;
  /** Text that replaces what is being typed (Tab). */
  insert: string;
  /** Sector chip shown on a security row. */
  sector?: Sector;
  /** The security's primary listing (rule 6: what the bare ticker resolves to). */
  primary?: boolean;
  score: number;
}

export interface FunctionEntry {
  code: string;
  name: string;
  ticker: "required" | "optional" | "none";
  sectors: readonly string[];
  argValues: readonly string[];
}

export interface CompleteContext extends ParseContext {
  index: SecIndex;
  functions: readonly FunctionEntry[];
  /** Most recent first: canonical IDs or commands. */
  recent?: readonly string[];
  layouts?: readonly string[];
  notes?: readonly string[];
  /** Sector chip from a sector key: filters securities and functions. */
  sector?: SectorToken;
}

// ---- per-index precomputation (cached; the index object is replaced on refresh) ----

interface Prepared {
  keys: { key: string; item: SecItem }[]; // ticker + aliases, sorted
  words: { word: string; item: SecItem; upper: string }[]; // name word starts, sorted
}
const prepared = new WeakMap<SecIndex, Prepared>();
/** Separators between the words of a security name ("A.P. Moller - Maersk A/S B"). */
const NAME_SEP = /[\s,.()&/-]+/;

function prepare(ix: SecIndex): Prepared {
  let p = prepared.get(ix);
  if (p) return p;
  const keys: Prepared["keys"] = [];
  const words: Prepared["words"] = [];
  for (const item of ix.items) {
    keys.push({ key: item.ticker, item });
    for (const a of item.aliases) keys.push({ key: a.toUpperCase(), item });
    const upper = item.name.toUpperCase();
    for (const w of upper.split(NAME_SEP)) {
      if (w.length >= 2) words.push({ word: w, item, upper });
    }
  }
  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  keys.sort((a, b) => cmp(a.key, b.key));
  words.sort((a, b) => cmp(a.word, b.word));
  p = { keys, words };
  prepared.set(ix, p);
  return p;
}

// Built when an index is loaded, before it replaces the old one (not on the first keystroke).
addIndexWarmer((ix) => void prepare(ix));

function lowerBound<T>(arr: T[], q: string, get: (t: T) => string): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (get(arr[mid]!) < q) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** [lo, hi): the entries whose key starts with `q`. */
function prefixRange<T>(arr: T[], q: string, get: (t: T) => string): [number, number] {
  return [lowerBound(arr, q, get), lowerBound(arr, `${q}\uffff`, get)];
}

function* prefixed<T>(arr: T[], q: string, get: (t: T) => string, cap: number): Generator<T> {
  let n = 0;
  for (let i = lowerBound(arr, q, get); i < arr.length && n < cap; i++, n++) {
    if (!get(arr[i]!).startsWith(q)) return;
    yield arr[i]!;
  }
}

// ---- sources ----

const TIER = { exactFn: 1000, exactTicker: 900, recent: 800, prefix: 600, name: 500 } as const;

function isPrimary(item: SecItem, ix: SecIndex, defaultExchange?: string): boolean {
  const r = resolveBare(item.ticker, ix, { suggest: false, defaultExchange });
  return r.status === "known" && r.id === item.id;
}

function securityRow(
  item: SecItem,
  score: number,
  ix: SecIndex,
  defaultExchange?: string,
): Completion {
  const where = item.exchange ? ` · ${item.exchange}` : "";
  const usdt = item.aliases.find((a) => a.endsWith("USDT"));
  return {
    key: `sec:${item.id}`,
    kind: "SECURITY",
    label: item.id,
    desc: `${item.name || "N.A."}${where}${usdt ? ` · ${usdt} (quoted in USDT)` : ""}`,
    insert: item.id,
    sector: item.sector,
    // What the bare ticker resolves to (rule 6); none when it is ambiguous (review 1a #18).
    primary: isPrimary(item, ix, defaultExchange),
    score,
  };
}

function securities(q: string, cx: CompleteContext, limit: number): Completion[] {
  const ix = cx.index;
  const p = prepare(ix);
  const want = cx.sector && cx.sector !== "CLIENT" ? (cx.sector as string) : undefined;
  const ok = (it: SecItem) => !want || it.sector === want;
  const out = new Map<string, Completion>();
  const add = (it: SecItem, score: number) => {
    if (!ok(it)) return;
    const prev = out.get(it.id);
    if (!prev || prev.score < score) {
      out.set(it.id, securityRow(it, score, ix, cx.defaultExchange));
    }
  };
  const exact = ix.byId.get(q);
  if (exact) add(exact, TIER.exactTicker + 50);
  const [first = "", ...more] = q.split(" ");
  if (!more.length) {
    for (const it of ix.byKey.get(q) ?? []) add(it, TIER.exactTicker);
    for (const { key, item } of prefixed(p.keys, q, (k) => k.key, 200)) {
      add(item, TIER.prefix - Math.min(99, key.length - q.length));
    }
  }
  if (first.length >= 2) {
    // Names: every typed word starts a word of the name, in any order ("novo nord" → Novo
    // Nordisk B, "ishares russell" → iShares Russell 2000). Walk the word with the fewest
    // index entries, so a common first word ("ISHARES", "FIRST") never hides the match.
    // Typed words split like the index words, so "apple inc." / "maersk a.p." still match
    // (re-verify R7); fragments under two letters are dropped on both sides.
    const words = [first, ...more].flatMap((w) => w.split(NAME_SEP)).filter((w) => w.length >= 2);
    if (!words.length) return [...out.values()];
    const ranges = words.map((w) => [w, ...prefixRange(p.words, w, (x) => x.word)] as const);
    const [lead, lo, hi] = ranges.reduce((a, b) => (b[2] - b[1] < a[2] - a[1] ? b : a));
    const rest = words.filter((w) => w !== lead);
    // Enough matches to rank is enough: past that the user has to type more anyway.
    for (let i = lo, found = 0; i < hi && found < limit * 5; i++) {
      const { word, item, upper } = p.words[i]!;
      if (out.has(item.id) || !ok(item)) continue;
      if (rest.every((w) => upper.includes(w))) {
        add(item, TIER.name - Math.min(99, word.length - lead.length));
        found++;
      }
    }
  }
  if (out.size < limit && q.length >= 3 && !more.length) {
    // Fuzzy fallback over the whole index (≈ 3 ms on 30k); the ranking keeps the best ones.
    for (const it of ix.items) {
      if (!ok(it) || out.has(it.id)) continue;
      const s = fuzzyScore(q, it.ticker);
      if (s !== null && s >= 150) add(it, Math.min(TIER.name - 100, s));
    }
  }
  return [...out.values()];
}

function functionsFor(
  q: string,
  cx: CompleteContext,
  filter: (f: FunctionEntry) => boolean,
): Completion[] {
  const out: Completion[] = [];
  for (const f of cx.functions) {
    if (!filter(f)) continue;
    if (cx.sector && !f.sectors.includes(cx.sector)) continue;
    let score: number | null;
    if (!q) score = TIER.prefix;
    else if (f.code === q) score = TIER.exactFn;
    else if (f.code.startsWith(q)) score = TIER.prefix + 50 - (f.code.length - q.length);
    else {
      const s = fuzzyScore(q, f.name);
      score = s === null ? null : Math.min(TIER.name, s * 0.6);
    }
    if (score === null) continue;
    out.push({
      key: `fn:${f.code}`,
      kind: "FUNCTION",
      label: f.code,
      desc: f.name,
      insert: f.code,
      score,
    });
  }
  return out;
}

function sectors(q: string): Completion[] {
  if (!q) return [];
  return SECTOR_KEYS.filter((s) => s.token !== "HELP")
    .filter((s) => s.token.startsWith(q) || s.aliases.some((a: string) => a.startsWith(q)))
    .map((s) => ({
      key: `sector:${s.token}`,
      kind: "SECTOR" as const,
      label: s.token,
      desc: `${s.covers} · sector menu (${s.key})`,
      insert: s.token,
      score: s.token === q || sectorToken(q) === s.token ? TIER.exactTicker : TIER.prefix - 10,
    }));
}

function named(
  kind: "LAYOUT" | "NOTE",
  names: readonly string[] | undefined,
  q: string,
): Completion[] {
  if (!names || q.length < 2) return [];
  return names
    .map((n) => [n, fuzzyScore(q, n)] as const)
    .filter(([, s]) => s !== null && s >= 400)
    .map(([n, s]) => ({
      key: `${kind}:${n}`,
      kind,
      label: kind === "LAYOUT" ? `LAYOUT LOAD ${n.toUpperCase()}` : `${n} NOTE`,
      desc: kind === "LAYOUT" ? "saved layout" : "note",
      insert: kind === "LAYOUT" ? `LAYOUT LOAD ${n.toUpperCase()}` : `${n} NOTE`,
      score: Math.min(TIER.name - 50, s!),
    }));
}

function rank(rows: Completion[], recent: readonly string[] | undefined, limit: number) {
  const seen = new Set<string>();
  const pos = new Map((recent ?? []).map((r, i) => [r, i]));
  for (const r of rows) {
    const i = pos.get(r.insert);
    // Recently used beats a plain prefix match, never an exact one.
    if (i !== undefined && r.score < TIER.recent) r.score = TIER.recent - Math.min(i, 50);
  }
  rows.sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));
  return rows.filter((r) => (seen.has(r.key) ? false : (seen.add(r.key), true))).slice(0, limit);
}

/**
 * "Search for '…'" (§4.7): the last row for any typed text that is not a command being
 * completed (a function code first, or a number). It runs SRCH with the text as typed.
 */
function searchRow(text: string, cx: CompleteContext): Completion | null {
  const typed = text.trim().replace(/\s+/g, " ");
  if (!typed || /^\d+$/.test(typed)) return null;
  if (cx.lookup(normalizeInput(typed)[0] ?? "")) return null;
  return {
    key: "search",
    kind: "SEARCH",
    label: `Search for '${typed}'`,
    desc: "functions, securities, notes, news (SRCH)",
    insert: `SRCH ${typed}`,
    score: -Infinity,
  };
}

/** Completions for the command-line text (chips already applied by the caller). */
export function complete(text: string, cx: CompleteContext, limit = 10): Completion[] {
  const search = searchRow(text, cx);
  const rows = completeText(text, cx, search ? limit - 1 : limit, false);
  return search ? [...rows, search] : rows;
}

function completeText(
  text: string,
  cx: CompleteContext,
  limit: number,
  fixedPass: boolean,
): Completion[] {
  // Only the kind of what was typed matters here; "did you mean" is for Enter.
  const quiet: ParseContext = { ...cx, suggest: false };
  // One layout-fixed pass only: letters outside both maps (`Ё` on ANSI, `ў`) stay Cyrillic.
  if (!fixedPass && hasCyrillic(text)) {
    // §4.6: the layout-fixed variant first, when it is a valid command.
    const fixed = parse(text, quiet);
    // A valid command as typed (Cyrillic only in its free text) completes as typed (#11).
    if (!fixed.fixed && fixed.kind !== "search") return completeText(text, cx, limit, true);
    const rest = completeText(layoutFixed(text), cx, limit - 1, true);
    if (!fixed.fixed) return rest;
    // Show what Enter will run, resolved (`ФФЗД ПЗ` → `AAPL US EQUITY GP`).
    const runs =
      fixed.kind === "function"
        ? [fixed.security, fixed.fn, ...fixed.args].filter(Boolean).join(" ")
        : fixed.kind === "security"
          ? fixed.security
          : fixed.fixed;
    const head: Completion = {
      key: `fixed:${runs}`,
      kind: "FIXED",
      label: runs,
      desc: `typed on a Cyrillic layout (${fixed.fixed}) — Enter runs this`,
      insert: runs,
      score: Infinity,
    };
    return [head, ...rest.filter((r) => r.insert !== runs)].slice(0, limit);
  }
  const tokens = normalizeInput(text);
  const editingNew = /\s$/.test(text);
  const current = editingNew ? "" : (tokens[tokens.length - 1] ?? "");
  const before = editingNew ? tokens : tokens.slice(0, -1);
  if (!tokens.length && !cx.sector) return [];

  if (before.length) {
    const head = parse(before.join(" "), quiet);
    if (head.kind === "security") {
      // `NOVOB DC EQUITY ▮` → that sector's functions that take a security.
      const sec = head.sector;
      const rows = functionsFor(current, cx, (f) => f.ticker !== "none" && f.sectors.includes(sec));
      return rank(rows, undefined, limit);
    }
    if (head.kind === "function") {
      // `GP ▮` / `AAPL US EQUITY GP 1▮` → the function's argument values.
      const f = cx.functions.find((x) => x.code === head.fn);
      const vals = (f?.argValues ?? []).filter((v) => v.startsWith(current) && v !== current);
      return vals.slice(0, limit).map((v, i) => ({
        key: `arg:${v}`,
        kind: "ARG" as const,
        label: v,
        desc: `${head.fn} argument`,
        insert: v,
        score: TIER.prefix - i,
      }));
    }
  }
  // First token, or free text such as a company name: everything.
  const q = tokens.join(" ");
  const rows = [
    ...(before.length ? [] : functionsFor(current, cx, () => true)),
    ...(before.length ? [] : sectors(current)),
    ...securities(q, cx, limit),
    ...named("LAYOUT", cx.layouts, q),
    ...named("NOTE", cx.notes, q),
  ];
  return rank(rows, cx.recent, limit);
}
