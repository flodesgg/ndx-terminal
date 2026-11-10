/** Toolbar navigation (SPEC §4.1): Menu, recent securities ▾, recent functions ▾. */
import type { PanelSpec } from "./layout/tree";
import { getFunction } from "./registry";

/** The window's security menu, else the main menu (also ⌃Enter). */
export function menuFor(view: PanelSpec | undefined): PanelSpec {
  return view?.ticker ? { fn: "MENU", ticker: view.ticker, args: [] } : { fn: "MENU", args: [] };
}

/** A recent security: in the window's function when it takes one, else its menu. */
export function recentSecurityTarget(view: PanelSpec | undefined, id: string): PanelSpec {
  const def = view && getFunction(view.fn);
  if (def && def.ticker !== "none" && view.fn !== "MENU")
    return { fn: def.code, ticker: id, args: [] };
  return { fn: "MENU", ticker: id, args: [] };
}

/** A recent function: on the window's security; one that needs a security and has none → HELP. */
export function recentFunctionTarget(view: PanelSpec | undefined, fn: string): PanelSpec {
  const def = getFunction(fn);
  if (!def) return { fn: "HELP", args: [] };
  if (def.ticker !== "none" && view?.ticker) return { fn: def.code, ticker: view.ticker, args: [] };
  if (def.ticker === "required") return { fn: "HELP", args: [def.code] };
  return { fn: def.code, args: [] };
}
