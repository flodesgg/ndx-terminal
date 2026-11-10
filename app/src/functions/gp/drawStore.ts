/** GP drawings per security, kept in user.db (one `/settings` key per security). */
import { create } from "zustand";
import { api } from "@/core/api";
import { drawingsKey, MAX_DRAWINGS, parseDrawings, type Drawing } from "./drawings";

export interface SymbolDrawings {
  /** "loading" until read; "error" if the read failed: then nothing is written over it. */
  state: "loading" | "ready" | "error";
  items: Drawing[];
  /** The last write failed: what is shown is not saved. */
  unsaved?: boolean;
}

const EMPTY: SymbolDrawings = { state: "loading", items: [] };

export const useDrawingStore = create<{ bySym: Record<string, SymbolDrawings> }>(() => ({
  bySym: {},
}));

const symKey = (s: string) => s.trim().toUpperCase();

function put(sym: string, v: SymbolDrawings) {
  useDrawingStore.setState((st) => ({ bySym: { ...st.bySym, [sym]: v } }));
}

/** Read a security's drawings once (every GP of it shares them). */
export async function loadDrawings(symbol: string): Promise<void> {
  const sym = symKey(symbol);
  if (!sym || useDrawingStore.getState().bySym[sym]) return;
  put(sym, EMPTY);
  try {
    const raw = await api.get<unknown>(`/settings/${encodeURIComponent(drawingsKey(sym))}`);
    put(sym, { state: "ready", items: parseDrawings(raw) });
  } catch {
    put(sym, { state: "error", items: [] });
  }
}

/** Replace a security's drawings and store them. Refused (false) until they have been read. */
export async function saveDrawings(symbol: string, items: Drawing[]): Promise<boolean> {
  const sym = symKey(symbol);
  const cur = useDrawingStore.getState().bySym[sym];
  if (cur?.state !== "ready") return false;
  const next = items.slice(-MAX_DRAWINGS);
  put(sym, { state: "ready", items: next });
  try {
    await api.put(`/settings/${encodeURIComponent(drawingsKey(sym))}`, { v: 1, items: next });
    return true;
  } catch {
    // Only flag it if nothing newer replaced this list meanwhile.
    if (useDrawingStore.getState().bySym[sym]?.items === next)
      put(sym, { state: "ready", items: next, unsaved: true });
    return false;
  }
}

export function useDrawings(symbol: string): SymbolDrawings {
  return useDrawingStore((st) => st.bySym[symKey(symbol)] ?? EMPTY);
}
