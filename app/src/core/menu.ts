/**
 * MENU (SPEC §7, §4.4): hierarchical, numbered menus generated from the function registry.
 *
 *   MENU                 top: the sector menus (F-key order), then the global functions
 *   MENU <SECTOR>        that sector's functions, by menu path
 *   <SECURITY> / MENU    with a security: its sector's functions that take a security, run on it
 *
 * Rows that can run are numbered 1…N (N + Enter runs them, §4.8). ⌘↑ goes up one level.
 */
import type { PanelSpec } from "./layout/tree";
import { SECTORS, type Sector } from "./secmaster";
import { allFunctions, functionsForSector, menuPath, type FunctionDef } from "./registry";
import { SECTOR_KEYS, SECTOR_TOKENS, sectorToken, type SectorToken } from "./sectors";

export interface MenuEntry {
  /** Item number; undefined for a row that cannot run here (needs a security). */
  n?: number;
  label: string;
  desc: string;
  /** Menu path, e.g. `Market › FX`; the sector's key for a sector row. */
  path: string;
  target?: PanelSpec;
}

const SECURITY_SECTORS: ReadonlySet<string> = new Set(SECTORS);

/** The sector of a canonical ID (`EURUSD CURNCY` → CURNCY; listed shares end in EQUITY). */
export function sectorOfId(id: string): Sector {
  const last = id.split(" ").pop() ?? "";
  return SECURITY_SECTORS.has(last) ? (last as Sector) : "EQUITY";
}

const byPath = (a: FunctionDef, b: FunctionDef) =>
  menuPath(a).join(" ").localeCompare(menuPath(b).join(" ")) || a.code.localeCompare(b.code);

function numbered(rows: Omit<MenuEntry, "n">[]): MenuEntry[] {
  let n = 0;
  return rows.map((r) => (r.target && n < 94 ? { ...r, n: ++n } : r));
}

function fnRow(f: FunctionDef, target: PanelSpec | undefined): Omit<MenuEntry, "n"> {
  return { label: f.code, desc: f.name, path: menuPath(f).join(" › "), target };
}

/** The menu a MENU window shows. */
export function menuEntries(panel: PanelSpec): MenuEntry[] {
  const sec = panel.ticker;
  if (sec) {
    const fns = functionsForSector(sectorOfId(sec))
      .filter((f) => f.ticker !== "none")
      .sort(byPath);
    return numbered(fns.map((f) => fnRow(f, { fn: f.code, ticker: sec, args: [] })));
  }
  const sector = panel.args[0] ? sectorToken(panel.args[0]) : undefined;
  if (sector) {
    const fns = functionsForSector(sector).sort(byPath);
    return numbered(
      fns.map((f) => fnRow(f, f.ticker === "required" ? undefined : { fn: f.code, args: [] })),
    );
  }
  const sectors = SECTOR_TOKENS.map((t) => {
    const k = SECTOR_KEYS.find((s) => s.token === t)!;
    return {
      label: t,
      desc: `${k.covers} · ${functionsForSector(t).length} functions`,
      path: k.key,
      target: { fn: "MENU", args: [t] },
    };
  });
  const globals = allFunctions()
    .filter((f) => f.sectors.length === 0)
    .sort(byPath)
    .map((f) => fnRow(f, { fn: f.code, args: [] }));
  return numbered([...sectors, ...globals]);
}

/** ⌘↑ (SPEC §4.5): function → its security menu → its sector menu → MENU. Null at the top. */
export function menuParent(panel: PanelSpec): PanelSpec | null {
  if (panel.fn !== "MENU") {
    return panel.ticker ? { fn: "MENU", ticker: panel.ticker, args: [] } : { fn: "MENU", args: [] };
  }
  if (panel.ticker) return { fn: "MENU", args: [sectorOfId(panel.ticker)] };
  if (panel.args.length) return { fn: "MENU", args: [] };
  return null;
}

/** The MENU window's title: where in the hierarchy it is. */
export function menuTitle(panel: PanelSpec): string {
  if (panel.ticker) return `Functions for ${panel.ticker}`;
  const s = panel.args[0] ? sectorToken(panel.args[0]) : undefined;
  return s ? `${s} sector menu` : "Main menu";
}

export type { SectorToken };
