/**
 * Numbered items (SPEC §4.8): every window shows its function's own items `1)`–`94)` and the
 * title-bar / toolbar items 95–99 (Actions, Export, Settings, Note, Help). Typing `N` + Enter in
 * the window's command line runs item N there.
 */
import { create } from "zustand";
import { formatCommand } from "./command/parser";
import { executeCommand } from "./executor";
import { winView } from "./layout/session";
import { useWorkspace } from "./layout/store";
import type { PanelSpec } from "./layout/tree";
import { getFunction, numberedActions, type NumberedAction } from "./registry";

export type PopupKind = "actions" | "export" | "settings" | "recent-sec" | "recent-fn";

/** The one open title-bar menu (95 Actions, 96 Export, 97 Settings), if any. */
export const usePopup = create<{
  popup: { winId: string; kind: PopupKind } | null;
  open: (winId: string, kind: PopupKind) => void;
  close: () => void;
}>((set) => ({
  popup: null,
  open: (winId, kind) => set({ popup: { winId, kind } }),
  close: () => set({ popup: null }),
}));

export function windowView(winId: string): PanelSpec | undefined {
  const w = useWorkspace.getState().session.windows[winId];
  return w ? winView(w) : undefined;
}

/** Every numbered item the window shows, in order. */
export function windowItems(winId: string): NumberedAction[] {
  const v = windowView(winId);
  const def = v && getFunction(v.fn);
  if (!def) return [];
  return numberedActions(def, v).filter((a) => !a.to || a.to(v) !== null);
}

export function hasItem(winId: string, n: number): boolean {
  return windowItems(winId).some((a) => a.n === n);
}

/** Run item N of a window. Returns false when the window has no such item. */
export function runItem(winId: string, n: number): boolean {
  const item = windowItems(winId).find((a) => a.n === n);
  const v = windowView(winId);
  if (!item || !v) return false;
  const ws = useWorkspace.getState();
  if (ws.activeId !== winId) ws.focus(winId);
  const target = item.to?.(v);
  if (target) {
    // A function that acts instead of opening a view (POP, OFF, LAYOUT …) runs as its command.
    const def = getFunction(target.fn);
    if (def?.run || !def?.component) void executeCommand(formatCommand(target));
    else ws.open(target);
    return true;
  }
  switch (n) {
    case 95:
      usePopup.getState().open(winId, "actions");
      return true;
    case 96:
      usePopup.getState().open(winId, "export");
      return true;
    case 97:
      usePopup.getState().open(winId, "settings");
      return true;
    case 98:
      ws.open({ fn: "NOTE", ticker: v.ticker, args: [] });
      return true;
    case 99:
      ws.open({ fn: "HELP", args: [v.fn] });
      return true;
  }
  return false;
}

/** Drill-down item: the same security in another function (null without a security). */
export function drill(n: number, label: string, fn: string): NumberedAction {
  return {
    n,
    label,
    to: (p) => (p.ticker ? { fn, ticker: p.ticker, args: [] } : null),
  };
}
