/**
 * Symbols the client keeps (the session's windows and history, recently used tickers) move to
 * canonical IDs, like the server's user.db migration (SPEC §5, §14 1a). Runs on every index load
 * and is idempotent: canonical IDs stay as they are, and a symbol the index cannot place is kept
 * as stored (it still works as a provider symbol), to be picked up once the seeds arrive.
 */
import { useWorkspace } from "./layout/store";
import { mapViews } from "./layout/session";
import { parseCanonical } from "./secmaster";
import { onSecIndex, resolveBare, secIndex, type SecIndex } from "./secindex";
import { recentTickers, replaceRecentTickers } from "@/lib/recent";

/** A stored symbol → its canonical ID, or the symbol unchanged when the index cannot place it. */
export function canonicalTicker(sym: string, ix: SecIndex): string {
  const t = sym.trim().toUpperCase();
  const tokens = t.split(/\s+/);
  if (tokens.length > 1 && parseCanonical(tokens)) return t;
  const byAlias = ix.byKey.get(t);
  if (byAlias?.length === 1) return byAlias[0]!.id;
  const r = resolveBare(t, ix, { suggest: false });
  return r.status === "known" ? r.id : sym;
}

export function migrateClientSymbols(ix: SecIndex): void {
  if (!ix.items.length) return;
  const { session } = useWorkspace.getState();
  const migrated = mapViews(session, (v) => {
    if (!v.ticker) return v;
    const c = canonicalTicker(v.ticker, ix);
    return c === v.ticker ? v : { ...v, ticker: c };
  });
  if (migrated !== session) useWorkspace.setState({ session: migrated });
  const recent = recentTickers();
  const next = [...new Set(recent.map((r) => canonicalTicker(r, ix)))];
  if (next.join("\n") !== recent.join("\n")) replaceRecentTickers(next);
}

export function startClientMigration(): () => void {
  migrateClientSymbols(secIndex());
  const offIndex = onSecIndex(() => migrateClientSymbols(secIndex()));
  // The session restores from user.db after launch, maybe after the index has loaded.
  const offSession = useWorkspace.subscribe((s, prev) => {
    if (s.ready && !prev.ready) migrateClientSymbols(secIndex());
  });
  return () => {
    offIndex();
    offSession();
  };
}
