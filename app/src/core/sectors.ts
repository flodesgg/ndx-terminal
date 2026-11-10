/**
 * Sector keys (SPEC §4.4): canonical tokens, their aliases and default F-keys. One table, used
 * by the parser (sector menus, `AAPL EQ DES`), the function registry (which sectors a function
 * belongs to) and the keymap (F1–F12 insert a sector chip).
 */

export interface SectorKey {
  /** Default key (`KEYS` may remap it, e.g. CURNCY off F11 which macOS uses for Show Desktop). */
  key: string;
  token: string;
  aliases: readonly string[];
  covers: string;
}

export const SECTOR_KEYS = [
  { key: "F1", token: "HELP", aliases: [], covers: "help; double press = help search" },
  { key: "F2", token: "GOVT", aliases: [], covers: "government yields/bonds" },
  { key: "F3", token: "CORP", aliases: [], covers: "corporate bonds (mostly N.A. on free data)" },
  { key: "F4", token: "MTGE", aliases: [], covers: "placeholder page: no free source" },
  { key: "F5", token: "M-MKT", aliases: ["MMKT"], covers: "policy & money-market rates" },
  { key: "F6", token: "MUNI", aliases: [], covers: "placeholder" },
  { key: "F7", token: "PFD", aliases: [], covers: "placeholder" },
  { key: "F8", token: "EQUITY", aliases: ["EQ"], covers: "stocks, ETFs" },
  { key: "F9", token: "COMDTY", aliases: ["CMDTY"], covers: "commodities, futures" },
  { key: "F10", token: "INDEX", aliases: ["IDX"], covers: "indices" },
  { key: "F11", token: "CURNCY", aliases: ["CCY"], covers: "FX and crypto" },
  { key: "F12", token: "CLIENT", aliases: [], covers: "my portfolios, lists, notes" },
] as const satisfies readonly SectorKey[];

/** Every sector-menu token (HELP is an F-key but not a sector). */
export type SectorToken = Exclude<(typeof SECTOR_KEYS)[number]["token"], "HELP">;

export const SECTOR_TOKENS: readonly SectorToken[] = SECTOR_KEYS.map((s) => s.token).filter(
  (t): t is SectorToken => t !== "HELP",
);

const BY_NAME = new Map<string, SectorToken>();
for (const s of SECTOR_KEYS) {
  if (s.token === "HELP") continue;
  BY_NAME.set(s.token, s.token);
  for (const a of s.aliases) BY_NAME.set(a, s.token);
}

/** `EQ` → `EQUITY`, `CCY` → `CURNCY`, `M-MKT` → `M-MKT`; anything else → undefined. */
export function sectorToken(word: string): SectorToken | undefined {
  return BY_NAME.get(word.toUpperCase());
}
