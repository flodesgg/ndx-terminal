/**
 * Command grammar (SPEC §4.3):
 *
 *   input         := number_select | security_form | function_form | sector_menu | search
 *   security_form := SECURITY [FUNCTION [ARG ...]]
 *   SECURITY      := TICKER [EXCH] SECTOR  |  TICKER [EXCH]
 *   function_form := FUNCTION [ARG ...]          (uses the window's loaded security if needed)
 *   sector_menu   := SECTOR
 *   number_select := INTEGER
 *   search        := anything else               (original text)
 *
 * Cyrillic input (§4.6) is also tried as its layout-fixed variant (physical keys → U.S.); the
 * variant wins only when it is a valid command, otherwise the original text goes to search.
 */
import { SECTORS, type Sector } from "@/core/secmaster";
import {
  EMPTY_INDEX,
  isExchangeCode,
  resolveBare,
  resolveCanonical,
  type Resolution,
  type SecIndex,
} from "@/core/secindex";
import { sectorToken, type SectorToken } from "@/core/sectors";
import { hasCyrillic, layoutFixed } from "./layouts";

export type TickerMode = "required" | "optional" | "none";

export interface FunctionInfo {
  code: string;
  ticker: TickerMode;
  /** Arg validation from the registry: error text, or null when valid. */
  validate?: (args: string[]) => string | null;
  /** Free-text functions: true when the args are one of the function's structured forms
   * (`W ADD AAPL`, `ALRT >200`, `HELP GP`), not a free name or note. Decides Cyrillic args. */
  structured?: (args: string[]) => boolean;
}

/** What a function handler receives. `ticker` is the canonical ID when one was resolved. */
export interface ParsedCommand {
  fn: string;
  ticker?: string;
  args: string[];
}

export type Parsed = (
  | { kind: "number"; n: number }
  | { kind: "function"; fn: string; security?: string; args: string[] }
  | { kind: "security"; security: string; sector: Sector }
  | { kind: "sector"; sector: SectorToken }
  | { kind: "search"; text: string }
  | { kind: "error"; error: string; hint?: string; suggestions?: string[] }
) & {
  /** Parsed from the layout-fixed variant of Cyrillic input (shown first in autocomplete). */
  fixed?: string;
};

export interface ParseContext {
  lookup: (code: string) => FunctionInfo | undefined;
  /** Security loaded in the active window (canonical ID), used by `function_form`. */
  loaded?: string;
  /** Numbered item check for `number_select`; absent = the screen has no numbered items. */
  hasItem?: (n: number) => boolean;
  index?: SecIndex;
  /** The user's default exchange for non-US names (rule 6). */
  defaultExchange?: string;
  /**
   * false: skip "did you mean" suggestions for unknown securities (a full index scan). The
   * autocomplete parses on every keystroke and only needs the kind of what was typed.
   */
  suggest?: boolean;
  /** A SPEC catalogue code this version does not build: say so instead of "unknown". */
  notBuilt?: (code: string) => boolean;
}

const notBuiltError = (code: string): Parsed => ({
  kind: "error",
  error: `${code} is not built in this version`,
  hint: "HELP lists the functions that are",
});

const TICKER_RE = /^\^?[A-Z0-9][A-Z0-9.\-=/]{0,15}$/;
const SECURITY_SECTORS: ReadonlySet<string> = new Set(SECTORS);

export function isValidTicker(s: string): boolean {
  return TICKER_RE.test(s);
}

/** Rule 1: trim, collapse spaces, uppercase. */
export function normalizeInput(input: string): string[] {
  return input.trim().toUpperCase().split(/\s+/).filter(Boolean);
}

function securitySector(token: string | undefined): Sector | undefined {
  if (token === undefined) return undefined;
  const s = sectorToken(token);
  return s && SECURITY_SECTORS.has(s) ? (s as Sector) : undefined;
}

/** A leading `TICKER [EXCH] SECTOR`: the parts and how many tokens it used. */
function leadingSecurity(
  t: string[],
): { ticker: string; exchange?: string; sector: Sector; used: number } | null {
  const [a, b, c] = t;
  if (a === undefined || !isValidTicker(a)) return null;
  if (b !== undefined && isExchangeCode(b) && securitySector(c) === "EQUITY") {
    return { ticker: a, exchange: b, sector: "EQUITY", used: 3 };
  }
  // `SPX US INDEX`: only equities carry an exchange in their ID, so the code is dropped
  // instead of reading `SPX US EQUITY` + function INDEX (review 1a #40).
  const other = securitySector(c);
  if (b !== undefined && isExchangeCode(b) && other) return { ticker: a, sector: other, used: 3 };
  const s = securitySector(b);
  if (s) return { ticker: a, sector: s, used: 2 };
  return null;
}

function resolutionError(r: Resolution): Parsed | null {
  if (r.status === "unknown") {
    return {
      kind: "error",
      error: `Unknown security ${r.query}`,
      suggestions: r.suggestions,
      hint: r.suggestions.length ? `Did you mean ${r.suggestions[0]}?` : undefined,
    };
  }
  if (r.status === "ambiguous") {
    return {
      kind: "error",
      error: `${r.query} is listed in several places`,
      suggestions: r.options,
      hint: "Pick one",
    };
  }
  return null;
}

/** The ID to run once `resolutionError` returned null. */
function idOf(r: Resolution): string {
  return r.status === "known" || r.status === "unverified" ? r.id : "";
}

function sectorOfId(id: string): Sector {
  const last = id.split(" ").pop()!;
  return SECURITY_SECTORS.has(last) ? (last as Sector) : "EQUITY";
}

/** `SECURITY [FUNCTION ARGS]` once the security is resolved. */
function securityForm(security: string, rest: string[], ctx: ParseContext): Parsed {
  const [f, ...args] = rest;
  if (f === undefined) return { kind: "security", security, sector: sectorOfId(security) };
  const info = ctx.lookup(f);
  if (!info && ctx.notBuilt?.(f)) return notBuiltError(f);
  if (!info) {
    return {
      kind: "error",
      error: `Unknown function ${f}`,
      hint: `Type ${security} and pick from its menu, or HELP`,
    };
  }
  if (info.ticker === "none") {
    return { kind: "error", error: `${info.code} does not take a security`, hint: info.code };
  }
  return functionForm(info, security, args);
}

function functionForm(info: FunctionInfo, security: string | undefined, args: string[]): Parsed {
  const bad = info.validate?.(args);
  if (bad) return { kind: "error", error: bad };
  return { kind: "function", fn: info.code, security, args };
}

function parseTokens(t: string[], original: string, ctx: ParseContext): Parsed {
  const ix = ctx.index ?? EMPTY_INDEX;
  const search: Parsed = { kind: "search", text: original.trim() };
  const [t0, t1] = t;
  if (t0 === undefined) return { kind: "error", error: "Empty command" };

  // Rule 2: digits only → numbered item.
  if (t.length === 1 && /^\d+$/.test(t0)) {
    const n = Number(t0);
    return ctx.hasItem?.(n) ? { kind: "number", n } : { kind: "error", error: `No item ${n}` };
  }

  // A full `TICKER EXCH EQUITY` always names a security, even when TICKER is a function code
  // (rows #19, #20: `N US EQUITY`, `GP US EQUITY GP`). A two-token `X SECTOR` names a security
  // only when X is not a function (`HELP CURNCY` stays HELP with an arg).
  const lead = leadingSecurity(t);
  if (lead && (lead.used === 3 || !ctx.lookup(t0))) {
    const r =
      lead.exchange || lead.sector !== "EQUITY"
        ? resolveCanonical(lead, ix, ctx)
        : resolveBare(lead.ticker, ix, { ...ctx, sector: "EQUITY" });
    const err = resolutionError(r);
    if (err) return err;
    return securityForm(idOf(r), t.slice(lead.used), ctx);
  }

  // Rule 3/4: a function (function names beat tickers).
  const info = ctx.lookup(t0);
  if (info) {
    const args = t.slice(1);
    if (info.ticker !== "required") return functionForm(info, undefined, args);
    if (ctx.loaded) return functionForm(info, ctx.loaded, args);
    return {
      kind: "error",
      error: `${info.code} needs a security`,
      hint: `Load one first, e.g. AAPL US EQUITY ${info.code}`,
    };
  }

  // Rule 3: a lone sector token → sector menu.
  if (t.length === 1) {
    const s = sectorToken(t0);
    if (s) return { kind: "sector", sector: s };
  }

  // Rule 6: TICKER [EXCH] [FUNCTION ARGS] without a sector.
  if (!isValidTicker(t0)) return search;
  if (t1 !== undefined && isExchangeCode(t1)) {
    const r = resolveCanonical({ ticker: t0, exchange: t1, sector: "EQUITY" }, ix, ctx);
    const err = resolutionError(r);
    if (err) return err;
    return securityForm(idOf(r), t.slice(2), ctx);
  }
  if (t1 !== undefined && !ctx.lookup(t1)) return search; // rule 7: nothing valid
  const r = resolveBare(t0, ix, ctx);
  if (r.status === "unknown" && t.length === 1)
    return ctx.notBuilt?.(t0) ? notBuiltError(t0) : search;
  return resolutionError(r) ?? securityForm(idOf(r), t.slice(1), ctx);
}

/** Valid = rules 2–6 produced something runnable or a function-level error, not search. */
function isValid(p: Parsed): boolean {
  if (p.kind === "search") return false;
  if (p.kind !== "error") return true;
  return !p.error.startsWith("Unknown security") && !p.error.includes("several places");
}

function isKnownForFixed(p: Parsed, t: string[], ctx: ParseContext): boolean {
  // A fixed variant that names no function is search, not an error ("цены дт сегодня").
  if (p.kind === "error" && p.error.startsWith("Unknown function")) return false;
  // A security guessed from Cyrillic words must be in the index ("нефть" is not YTANM, and
  // "цены дт" is not WTYS LN EQUITY): only an explicit sector token ("… УЙГШЕН") skips it.
  const sec = p.kind === "security" || p.kind === "function" ? p.security : undefined;
  if (!sec || leadingSecurity(t)) return true;
  return sec === ctx.loaded || (ctx.index ?? EMPTY_INDEX).byId.has(sec);
}

/**
 * A Latin function token with args typed on the Cyrillic layout (`W фвв ффзд` after Tab-accepting
 * a FIXED `W`): the fixed args win when they are one of the function's structured forms and the
 * typed ones are not (`W ADD AAPL`, `ALRT >200`, `HELP GP`) — re-verify R6. Only the shortest run
 * of leading args that makes the form structured is fixed; the free text after it stays as typed
 * (`ALRT Ю200 прорыв` → `ALRT >200 ПРОРЫВ`, `W туц утро` → `W NEW УТРО`) — re-verify N6.
 * Returns the args to run, or null to keep the line as typed.
 */
function fixedStructuredArgs(original: Parsed, fixed: Parsed, ctx: ParseContext): string[] | null {
  if (original.kind !== "function" || fixed.kind !== "function" || fixed.fn !== original.fn) {
    return null;
  }
  const structured = ctx.lookup(original.fn)?.structured;
  if (!structured || structured(original.args) || original.args.length !== fixed.args.length) {
    return null;
  }
  for (let k = 1; k <= fixed.args.length; k++) {
    const args = [...fixed.args.slice(0, k), ...original.args.slice(k)];
    if (structured(args)) return args;
  }
  return null;
}

export function parse(input: string, ctx: ParseContext): Parsed {
  if (hasCyrillic(input)) {
    // A valid command as typed keeps its Cyrillic free text (layout or watchlist names, alert
    // notes): only the fixed variant of an invalid line is considered (§4.6, review 1a #11).
    const ot = normalizeInput(input);
    const fixedText = layoutFixed(input);
    const ft = normalizeInput(fixedText);
    const fixed = parseTokens(ft, fixedText, ctx);
    const fixedOk = isValid(fixed) && isKnownForFixed(fixed, ft, ctx);
    if (!hasCyrillic(ot[0] ?? "")) {
      const original = parseTokens(ot, input, ctx);
      if (original.kind !== "search" && original.kind !== "error") {
        const args = fixedOk ? fixedStructuredArgs(original, fixed, ctx) : null;
        if (!args || fixed.kind !== "function") return original;
        const head = ft.slice(0, ft.length - fixed.args.length);
        return { ...fixed, args, fixed: [...head, ...args].join(" ") };
      }
    }
    if (fixedOk) return { ...fixed, fixed: ft.join(" ") };
    return { kind: "search", text: input.trim() };
  }
  return parseTokens(normalizeInput(input), input, ctx);
}

/** The command a parse result runs, for history and the title bar. */
export function toCommand(p: Parsed): ParsedCommand | null {
  if (p.kind !== "function") return null;
  return { fn: p.fn, ticker: p.security, args: p.args };
}

export function formatCommand(cmd: ParsedCommand): string {
  return [cmd.ticker, cmd.fn, ...cmd.args].filter(Boolean).join(" ");
}
