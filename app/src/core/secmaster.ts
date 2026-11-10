/**
 * Canonical IDs on the client (SPEC §5): `AAPL US EQUITY`, `SPX INDEX`, `EURUSD CURNCY`…
 * Exchange codes come straight from the server's curated table (data/symbology/exchanges.csv),
 * so client and server cannot drift. Resolution to provider symbols stays on the server.
 */
import exchangesCsv from "../../../data/symbology/exchanges.csv?raw";

export const SECTORS = ["EQUITY", "INDEX", "COMDTY", "CURNCY", "GOVT"] as const;
export type Sector = (typeof SECTORS)[number];

function codes(csv: string): Set<string> {
  const rows = csv.split("\n").filter((l) => l.trim() && !l.startsWith("#"));
  const header = rows.shift()?.split(",") ?? [];
  const i = header.indexOf("code");
  return new Set(rows.map((r) => r.split(",")[i]!.trim()).filter(Boolean));
}

export const EXCHANGES: ReadonlySet<string> = codes(exchangesCsv);
const SECTOR_SET: ReadonlySet<string> = new Set(SECTORS);

export interface CanonicalParts {
  ticker: string;
  exchange?: string;
  sector: Sector;
}

/** `["AAPL","US","EQUITY"]` → parts; equity is the default sector after an exchange code. */
export function parseCanonical(tokens: string[]): { parts: CanonicalParts; used: number } | null {
  const [a, b, c] = tokens.map((t) => t.toUpperCase());
  if (!a || !b) return null;
  if (EXCHANGES.has(b)) {
    return c === "EQUITY"
      ? { parts: { ticker: a, exchange: b, sector: "EQUITY" }, used: 3 }
      : { parts: { ticker: a, exchange: b, sector: "EQUITY" }, used: 2 };
  }
  if (SECTOR_SET.has(b) && b !== "EQUITY")
    return { parts: { ticker: a, sector: b as Sector }, used: 2 };
  return null;
}

export function formatCanonical(p: CanonicalParts): string {
  return p.exchange ? `${p.ticker} ${p.exchange} ${p.sector}` : `${p.ticker} ${p.sector}`;
}

/** Canonical form of a whole string, or null if it is not a canonical ID. */
export function canonical(s: string): string | null {
  const tokens = s.trim().split(/\s+/);
  const r = parseCanonical(tokens);
  return r && r.used === tokens.length ? formatCanonical(r.parts) : null;
}

/**
 * Merge a leading canonical ID into one token so the command grammar sees one security:
 * `["NOVOB","DC","EQUITY","GP"]` → `["NOVOB DC EQUITY","GP"]`.
 */
export function mergeLeadingId(tokens: string[]): string[] {
  const r = parseCanonical(tokens);
  if (!r) return tokens;
  return [formatCanonical(r.parts), ...tokens.slice(r.used)];
}
