/**
 * Venue time zones for grid TIME columns (SPEC §4.2: "Grids show exchange-local HH:MM:SS").
 * Read from the curated tables the server also uses, so they cannot drift:
 * - equities `TICKER EXCH EQUITY` → exchanges.csv `tz`;
 * - indices `SPX INDEX` / `^GSPC` → indices.csv `tz`;
 * - futures `CL1 COMDTY` / `CL=F` → the contract's exchange (futures.csv) → FUTURES_TZ below.
 * FX, crypto, rates and anything unknown have no single venue: `undefined`, and callers fall back
 * to the user zone.
 */
import exchangesCsv from "../../../data/symbology/exchanges.csv?raw";
import futuresCsv from "../../../data/symbology/futures.csv?raw";
import indicesCsv from "../../../data/symbology/indices.csv?raw";

function table(csv: string): Record<string, string>[] {
  const rows = csv.split("\n").filter((l) => l.trim() && !l.startsWith("#"));
  const header = (rows.shift() ?? "").split(",").map((h) => h.trim());
  return rows.map((r) => {
    const cols = r.split(",");
    return Object.fromEntries(header.map((h, i) => [h, (cols[i] ?? "").trim()]));
  });
}

/** Where the futures exchanges in futures.csv sit (CME Group venues). */
const FUTURES_TZ: Readonly<Record<string, string>> = {
  CME: "America/Chicago",
  CBOT: "America/Chicago",
  NYMEX: "America/New_York",
  COMEX: "America/New_York",
};

const BY_EXCHANGE = new Map(table(exchangesCsv).map((r) => [r.code!, r.tz!]));
const BY_SYMBOL: ReadonlyMap<string, string> = (() => {
  const out = new Map<string, string>();
  for (const r of table(indicesCsv)) {
    if (!r.tz) continue;
    out.set(`${r.id} INDEX`, r.tz);
    if (r.yahoo) out.set(r.yahoo, r.tz);
  }
  for (const r of table(futuresCsv)) {
    const tz = FUTURES_TZ[r.exchange ?? ""];
    if (!tz) continue;
    out.set(`${r.id} ${r.sector}`, tz);
    if (r.yahoo) out.set(r.yahoo, tz);
  }
  return out;
})();

/** Exchange zone of a canonical ID or provider symbol; `undefined` when it has no single venue. */
export function venueTz(symbol: string): string | undefined {
  const s = symbol.trim().toUpperCase();
  const known = BY_SYMBOL.get(s);
  if (known) return known;
  const parts = s.split(/\s+/);
  if (parts.length === 3 && parts[2] === "EQUITY") return BY_EXCHANGE.get(parts[1]!) || undefined;
  return undefined;
}
