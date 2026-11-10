import { api, clientLog, errorMessage } from "./api";
import { formatCommand, normalizeInput, parse, toCommand, type Parsed } from "./command/parser";
import { activePanel, useWorkspace } from "./layout/store";
import { hasItem, runItem } from "./items";
import { usePdf } from "./pdf";
import { getFunction, lookupInfo, notBuilt } from "./registry";
import { secIndex } from "./secindex";
import { rememberFunction } from "@/lib/recent";

export interface ExecResult {
  ok: boolean;
  error?: string;
  hint?: string;
  suggestions?: string[];
}

/** Parse a command line in the active window's context (SPEC §4.3). */
export function parseInContext(text: string): Parsed {
  return parse(text, {
    lookup: lookupInfo,
    notBuilt,
    loaded: activePanel()?.ticker,
    index: secIndex(),
    defaultExchange: usePdf.getState().pdf.defaultExchange,
    hasItem: (n) => hasItem(useWorkspace.getState().activeId, n),
  });
}

/** Parse and run a command line. Opens a panel or runs the function's action. */
export async function executeCommand(
  text: string,
  opts: { newPanel?: boolean } = {},
): Promise<ExecResult> {
  const p = parseInContext(text);
  const open = useWorkspace.getState().open;
  switch (p.kind) {
    case "error":
      return { ok: false, error: p.error, hint: p.hint, suggestions: p.suggestions };
    case "number":
      // Numbered items of the active window (SPEC §4.8).
      return runItem(useWorkspace.getState().activeId, p.n)
        ? { ok: true }
        : { ok: false, error: `No item ${p.n}` };
    case "search":
      // §4.3 rule 7: nothing valid → SRCH with the original text.
      open({ fn: "SRCH", args: normalizeInput(p.text) }, opts);
      return { ok: true };
    case "sector":
      // The sector's function menu (SPEC §4.4), generated from the registry.
      open({ fn: "MENU", args: [p.sector] }, opts);
      return { ok: true };
    case "security":
      // Security menu: the functions of its sector, run against it.
      open({ fn: "MENU", ticker: p.security, args: [] }, opts);
      return { ok: true };
    case "function":
      break;
  }
  const cmd = toCommand(p)!;
  const def = getFunction(cmd.fn);
  if (!def) return { ok: false, error: `Unknown function ${cmd.fn}` };
  void api.post("/history", { command: formatCommand(cmd) }).catch(() => undefined);
  try {
    if (def.run && (await def.run(cmd))) return { ok: true };
  } catch (e) {
    clientLog("warn", `command ${text} failed: ${errorMessage(e)}`);
    return { ok: false, error: errorMessage(e) };
  }
  if (!def.component) return { ok: false, error: `${cmd.fn} has no panel` };
  rememberFunction(cmd.fn);
  open({ fn: cmd.fn, ticker: cmd.ticker, args: cmd.args }, opts);
  return { ok: true };
}
