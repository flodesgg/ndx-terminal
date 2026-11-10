/**
 * Function registry (SPEC §12): every function is a self-contained module registered here with
 * mnemonic, title, sectors, requires-security flag, menu path, args, numbered actions and help
 * text. HELP pages, autocomplete, sector menus and argument errors are all generated from it.
 */
import type { ComponentType } from "react";
import type { FunctionEntry } from "./command/autocomplete";
import type { FunctionInfo, ParsedCommand, TickerMode } from "./command/parser";
import type { PanelSpec } from "./layout/tree";
import type { SectorToken } from "./sectors";

export interface PanelProps {
  id: string;
  panel: PanelSpec;
  active: boolean;
  /** Replace this panel's spec (e.g. change timeframe) without adding history. */
  update: (panel: PanelSpec) => void;
}

export type Category = "Market" | "Research" | "Macro" | "Tools" | "System";

/**
 * One kind of argument. A token is valid if it is in `values`, or matches `pattern`; a spec with
 * neither accepts any token (names, symbols, notes).
 */
export interface ArgSpec {
  name: string;
  help: string;
  values?: readonly string[];
  pattern?: RegExp;
  /** How `pattern` reads in help and errors, e.g. `HL=<price>`. */
  form?: string;
}

/** A numbered item `N)` (SPEC §4.8); 95–99 are the title-bar actions every window has. */
export interface NumberedAction {
  n: number;
  label: string;
  /** Function items (1–94): the view this item opens in the window; null hides the item. */
  to?: (panel: PanelSpec) => PanelSpec | null;
  /** A row of the function's content (menu rows, help topics), not a toolbar button. */
  content?: boolean;
}

export const TITLE_BAR_ACTIONS: readonly NumberedAction[] = [
  { n: 95, label: "Actions" },
  { n: 96, label: "Export" },
  { n: 97, label: "Settings" },
  { n: 98, label: "Note" },
  { n: 99, label: "Help" },
];

export interface FunctionDef {
  /** Mnemonic, e.g. `GP`. */
  code: string;
  /** Title, e.g. "Price chart". */
  name: string;
  /** Help text: what it shows and where the data comes from. */
  description: string;
  /** Requires-security flag: required / optional / none. */
  ticker: TickerMode;
  syntax: string;
  examples: string[];
  category: Category;
  /** Sector menus this function appears in (empty = global, e.g. HELP). */
  sectors: readonly SectorToken[];
  /** Menu path below the category, e.g. `["Charts"]` → Market › Charts. */
  menu: readonly string[];
  args: readonly ArgSpec[];
  /** Function-specific numbered items (1–94); title-bar items 95–99 are added for every window. */
  actions: readonly NumberedAction[];
  /** Items generated from the window's view (rows of a menu); numbered after `actions`. */
  items?: (panel: PanelSpec) => NumberedAction[];
  hidden?: boolean;
  /** Panel UI. */
  component?: ComponentType<PanelProps>;
  /**
   * Optional action handler. Return `true` when fully handled (no panel opens),
   * or `false` to open the panel normally. Throw to report an error.
   */
  run?: (cmd: ParsedCommand) => boolean | Promise<boolean>;
  /** Free-text args: true when `args` is a structured form (subcommand, rule), see parser. */
  structuredArgs?: (args: string[]) => boolean;
  /** Title shown in the panel header. */
  title?: (panel: PanelSpec) => string;
}

// ---- arg spec helpers ----

export const oneOf = (name: string, values: readonly string[], help: string): ArgSpec => ({
  name,
  values,
  help,
});
export const matching = (name: string, pattern: RegExp, form: string, help: string): ArgSpec => ({
  name,
  pattern,
  form,
  help,
});
export const anyText = (name: string, help: string): ArgSpec => ({ name, help });

const defs = new Map<string, FunctionDef>();

/** Every code in the SPEC §7 catalogue. Those not registered are not built in this version
 * (scope cut of 2026-11-10): typing one says so instead of "unknown" (docs/FUNCTIONS.md). */
const SPEC_CODES = new Set(
  (
    "ALRT ASK BETA BT BTMM CALC CDR CF CHEAT CN COMP CORR CRYPTO DES DVD ECDR ECO ECST EE EM EQS " +
    "ERN EVTS FA FLDS FXC G GIP GLCO GP GRAB HDS HELP HP IMAP INS JRNL KEYS LAYOUT LINK LOG " +
    "MEMB MENU MGMT MON MOST MOV N NOTE NSE OMON OVME PDF POP PORT PROP PROV PRTU PY Q REPLAY " +
    "RISK RV SI SRCH TOP TQL TRA VAP W WB WEI WFX YC"
  ).split(" "),
);

export function notBuilt(code: string): boolean {
  const c = code.toUpperCase();
  return SPEC_CODES.has(c) && !defs.has(c);
}

export function registerFunction(def: FunctionDef): void {
  if (defs.has(def.code)) throw new Error(`function ${def.code} registered twice`);
  defs.set(def.code, def);
}

export function getFunction(code: string): FunctionDef | undefined {
  return defs.get(code.toUpperCase());
}

export function allFunctions(includeHidden = false): FunctionDef[] {
  return [...defs.values()]
    .filter((d) => includeHidden || !d.hidden)
    .sort((a, b) => a.code.localeCompare(b.code));
}

export function lookupInfo(code: string): FunctionInfo | undefined {
  const d = defs.get(code);
  return d
    ? {
        code: d.code,
        ticker: d.ticker,
        validate: (args) => validateArgs(d, args),
        structured: d.structuredArgs,
      }
    : undefined;
}

export function menuPath(def: FunctionDef): string[] {
  return [def.category, ...def.menu];
}

/** Functions listed in a sector's menu (SPEC §4.4). */
export function functionsForSector(sector: SectorToken): FunctionDef[] {
  return allFunctions().filter((d) => d.sectors.includes(sector));
}

/** Every numbered item a window of this function shows (`panel`: its content rows too). */
export function numberedActions(def: FunctionDef, panel?: PanelSpec): NumberedAction[] {
  const rows = panel && def.items ? def.items(panel).filter((i) => i.n < 95) : [];
  return [...def.actions, ...rows, ...TITLE_BAR_ACTIONS];
}

function accepts(spec: ArgSpec, token: string): boolean {
  if (!spec.values && !spec.pattern) return true;
  return !!spec.values?.includes(token) || !!spec.pattern?.test(token);
}

function allowed(spec: ArgSpec): string {
  const forms = [...(spec.values ?? []), ...(spec.form ? [spec.form] : [])];
  return `${spec.name}: ${forms.join(" ")}`;
}

/**
 * Validate a command's args against the registry (SPEC §4.3: "an invalid arg gives an inline
 * error listing the allowed values"). Returns the error text, or null when every token is valid.
 */
export function validateArgs(def: FunctionDef, args: readonly string[]): string | null {
  for (const raw of args) {
    const a = raw.toUpperCase();
    if (def.args.some((s) => accepts(s, a))) continue;
    if (def.args.length === 0) return `${def.code} takes no arguments ("${raw}")`;
    return `${def.code}: "${raw}" is not valid. Allowed — ${def.args.map(allowed).join(" · ")}`;
  }
  return null;
}

/** The generated HELP page for one function (SPEC §12). */
export function helpText(def: FunctionDef): string[] {
  const need = { required: "required", optional: "optional", none: "none" }[def.ticker];
  const lines = [
    `${def.code} — ${def.name}`,
    def.description,
    "",
    `Syntax:    ${def.syntax}`,
    `Security:  ${need}`,
    `Sectors:   ${def.sectors.length ? def.sectors.join(" ") : "all (global)"}`,
    `Menu:      ${menuPath(def).join(" › ")}`,
  ];
  if (def.args.length) {
    lines.push("Arguments:");
    for (const s of def.args) {
      const forms = [...(s.values ?? []), ...(s.form ? [s.form] : [])].join(" ");
      lines.push(`  ${s.name.padEnd(12)} ${forms ? `${forms} — ` : ""}${s.help}`);
    }
  }
  lines.push(
    `Actions:   ${numberedActions(def)
      .map((a) => `${a.n}) ${a.label}`)
      .join("  ")}`,
  );
  if (def.examples.length) lines.push(`Examples:  ${def.examples.join(" · ")}`);
  return lines;
}

/** What autocomplete needs from each visible function (mnemonic, title, sectors, arg values). */
export function functionEntries(): FunctionEntry[] {
  return allFunctions().map((d) => ({
    code: d.code,
    name: d.name,
    ticker: d.ticker,
    sectors: d.sectors,
    argValues: d.args.flatMap((a) => a.values ?? []),
  }));
}
