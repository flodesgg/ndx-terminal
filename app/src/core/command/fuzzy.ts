/**
 * Tiny fuzzy matcher for the command line. Higher score = better match; null = no match.
 * Ranking: exact > prefix > word-prefix > substring > subsequence.
 */
export function fuzzyScore(query: string, target: string): number | null {
  const q = query.trim().toUpperCase();
  const t = target.toUpperCase();
  if (!q) return 0;
  if (t === q) return 1000;
  if (t.startsWith(q)) return 800 - (t.length - q.length);
  const words = t.split(/[\s\-_/.]+/);
  if (words.some((w) => w.startsWith(q))) return 600 - (t.length - q.length);
  const idx = t.indexOf(q);
  if (idx >= 0) return 400 - idx;
  // Subsequence: every query char appears in order.
  let ti = 0;
  let gaps = 0;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found < 0) return null;
    gaps += found - ti;
    ti = found + 1;
  }
  return Math.max(1, 200 - gaps);
}

export interface FuzzyItem {
  key: string;
  /** Strings to match against; best score wins. The first is the primary label. */
  fields: string[];
}

export function fuzzyRank<T extends FuzzyItem>(query: string, items: T[], limit = 10): T[] {
  const scored: { item: T; score: number }[] = [];
  for (const item of items) {
    let best: number | null = null;
    item.fields.forEach((f, i) => {
      const s = fuzzyScore(query, f);
      // Secondary fields (names, descriptions) weigh less than the code itself.
      const weighted = s === null ? null : i === 0 ? s : s * 0.6;
      if (weighted !== null && (best === null || weighted > best)) best = weighted;
    });
    if (best !== null) scored.push({ item, score: best });
  }
  scored.sort((a, b) => b.score - a.score || a.item.key.localeCompare(b.item.key));
  return scored.slice(0, limit).map((s) => s.item);
}
