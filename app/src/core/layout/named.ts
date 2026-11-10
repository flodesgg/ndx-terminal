/**
 * Named layouts (SPEC §4.9): `LAYOUT SAVE <name>`, `LAYOUT <name>`, `LAYOUT` (list). Also kept:
 * `LAYOUT LOAD|DEL <name>` and `LAYOUT RESET`; `LAYOUT CLASSIC|WORKSPACE` switches the mode.
 * A saved layout is the whole session (both modes, tabs, history, links) minus the reopen stack;
 * layouts saved by v1 (a panel tree) still load, as classic windows.
 */
import { fromV1Tree, validateSession, type Mode, type Session } from "./session";
import { validateTree } from "./tree";

export type LayoutOp =
  | { op: "list" }
  | { op: "save" | "load" | "del"; name: string }
  | { op: "reset" }
  | { op: "mode"; mode: Mode }
  | { op: "error"; error: string };

export const LAYOUT_WORDS = [
  "SAVE",
  "LOAD",
  "DEL",
  "DELETE",
  "LIST",
  "RESET",
  "CLASSIC",
  "WORKSPACE",
];

export function layoutCommand(args: readonly string[]): LayoutOp {
  const [first, second, ...extra] = args.map((a) => a.toUpperCase());
  if (extra.length) return { op: "error", error: "Usage: LAYOUT [SAVE|LOAD|DEL] <name>" };
  const named = (op: "save" | "load" | "del"): LayoutOp => {
    if (!second) return { op: "error", error: `Usage: LAYOUT ${first} <name>` };
    if (LAYOUT_WORDS.includes(second)) {
      return { op: "error", error: `"${second}" is a LAYOUT keyword, not a layout name` };
    }
    return { op, name: second.toLowerCase() };
  };
  switch (first) {
    case undefined:
    case "LIST":
      return second ? { op: "error", error: "Usage: LAYOUT LIST" } : { op: "list" };
    case "SAVE":
      return named("save");
    case "LOAD":
      return named("load");
    case "DEL":
    case "DELETE":
      return named("del");
    case "RESET":
      return second ? { op: "error", error: "Usage: LAYOUT RESET" } : { op: "reset" };
    case "CLASSIC":
    case "WORKSPACE":
      return second
        ? { op: "error", error: `Usage: LAYOUT ${first}` }
        : { op: "mode", mode: first === "CLASSIC" ? "classic" : "workspace" };
    default:
      return second
        ? { op: "error", error: "Usage: LAYOUT <name> (one word)" }
        : { op: "load", name: first.toLowerCase() };
  }
}

/** What `LAYOUT SAVE` stores. */
export function layoutOf(s: Session): Session {
  return { ...s, closed: [] };
}

/** A stored layout → a session (v2 session, or a v1 panel tree); null when unreadable. */
export function sessionFromStored(x: unknown): Session | null {
  const s = validateSession(x);
  if (s) return s;
  const tree = validateTree(x);
  return tree ? fromV1Tree(tree) : null;
}

export function layoutSummary(x: unknown): { mode: Mode; windows: number } | null {
  const s = sessionFromStored(x);
  return s ? { mode: s.mode, windows: Object.keys(s.windows).length } : null;
}
