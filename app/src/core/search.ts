/**
 * SRCH (SPEC §7): global search over functions, securities, notes and news. Functions and
 * securities come from the local registry and index (offline); notes from user.db; news from
 * the headlines the news providers returned. A hit needs every word (case-insensitive).
 */
import { complete } from "./command/autocomplete";
import { allFunctions, lookupInfo, type FunctionDef } from "./registry";
import type { SecIndex, SecItem } from "./secindex";

/** SRCH args → upper-case words (the parser upper-cases args; typed text keeps its letters). */
export function searchWords(args: readonly string[]): string[] {
  return args.flatMap((a) => a.toUpperCase().split(/\s+/)).filter(Boolean);
}

const hasAll = (text: string, words: readonly string[]) => {
  const upper = text.toUpperCase();
  return words.every((w) => upper.includes(w));
};

export function searchFunctions(words: readonly string[]): FunctionDef[] {
  if (!words.length) return [];
  const exact = words.length === 1 ? words[0] : undefined;
  return allFunctions()
    .filter((f) => f.code === exact || hasAll(`${f.code} ${f.name} ${f.description}`, words))
    .sort((a, b) => Number(b.code === exact) - Number(a.code === exact));
}

export function searchSecurities(words: readonly string[], index: SecIndex, limit = 20): SecItem[] {
  if (!words.length) return [];
  return complete(words.join(" "), { lookup: lookupInfo, index, functions: [] }, limit + 1)
    .filter((c) => c.kind === "SECURITY")
    .map((c) => index.byId.get(c.label))
    .filter((x): x is SecItem => x !== undefined);
}

export function matchNotes<T extends { symbol: string; body: string }>(
  words: readonly string[],
  notes: readonly T[],
): T[] {
  return words.length ? notes.filter((n) => hasAll(`${n.symbol} ${n.body}`, words)) : [];
}

export function matchNews<T extends { headline: string; summary?: string | null }>(
  words: readonly string[],
  news: readonly T[],
): T[] {
  return words.length ? news.filter((n) => hasAll(`${n.headline} ${n.summary ?? ""}`, words)) : [];
}
