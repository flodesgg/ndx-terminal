/**
 * The UI session store (SPEC §4.9). Wraps the pure session model (session.ts); every change is
 * saved to user.db through the server's `/session` (debounced), and the last session restores on
 * launch. v1 kept the layout in browser localStorage: it is migrated once, then removed.
 */
import { create } from "zustand";
import { api, clientLog, errorMessage } from "../api";
import { getFunction } from "../registry";
import * as S from "./session";
import {
  MAX_PANELS,
  nearestInDir,
  neighbor,
  resizeLeaf,
  setRatio,
  splitLeaf,
  validateTree,
  type Direction,
  type PanelSpec,
  type Rect,
} from "./tree";

/** v1's localStorage key for the current layout (migrated once, then removed). */
export const V1_LAYOUT_KEY = "ndx.layout.current";
const SAVE_DELAY_MS = 300;

export type MessageKind = "info" | "error";
export type { LinkColor, Mode, Session } from "./session";

/** Does a function take a security? Linked windows only follow a security if theirs does. */
export function acceptsSecurity(fn: string): boolean {
  const d = getFunction(fn);
  return !!d && d.ticker !== "none";
}

interface WorkspaceState {
  session: S.Session;
  /** Active window of the current mode ("" when the workspace has no windows). */
  activeId: string;
  /** The session came from the server (or the one-time migration): saving is on. */
  ready: boolean;
  maximizedId: string | null;
  tapeVisible: boolean;
  cheatsheetOpen: boolean;
  message: { text: string; kind: MessageKind; at: number } | null;
  focusCommandTick: number;

  /** Load a view in the active window (`newPanel`: GO in a new tab). */
  open: (panel: PanelSpec, opts?: { newPanel?: boolean }) => void;
  split: (dir: "row" | "col", panel?: PanelSpec) => void;
  /** ⌘W: close the active tab (the last tab closes the window). */
  closeActive: () => void;
  newTab: () => void;
  reopenTab: () => void;
  selectTab: (id: string, index: number) => void;
  back: () => void;
  forward: () => void;
  setLink: (link: S.LinkColor, id?: string) => void;
  pop: () => void;
  setMode: (mode: S.Mode) => void;
  dropTicker: (id: string, ticker: string) => void;
  focus: (id: string) => void;
  focusDir: (dir: Direction) => void;
  focusIndex: (i: number) => void;
  resizeActive: (axis: "row" | "col", delta: number) => void;
  setSplitRatio: (splitId: string, ratio: number) => void;
  moveRect: (id: string, rect: Rect) => void;
  toggleMax: () => void;
  updateLeaf: (id: string, panel: PanelSpec) => void;
  loadSession: (s: S.Session) => void;
  reset: () => void;
  toggleTape: () => void;
  setCheatsheet: (open: boolean) => void;
  notify: (text: string, kind?: MessageKind) => void;
  requestCommandFocus: () => void;
}

function derived(session: S.Session): Pick<WorkspaceState, "session" | "activeId"> {
  return { session, activeId: S.activeId(session) ?? "" };
}

const initial = S.defaultSession();

export const useWorkspace = create<WorkspaceState>((set, get) => {
  /**
   * Apply a session change; a closed or hidden window cannot stay maximized, and while one is
   * maximized it follows the focus (next window, split): otherwise the active window would be
   * hidden and the next command would run there (review 1b #6).
   */
  const commit = (fn: (s: S.Session) => S.Session) => {
    const { session, maximizedId } = get();
    const next = fn(session);
    if (next === session) return;
    const visible = S.visibleIds(next);
    const act = S.activeId(next);
    const max =
      maximizedId && visible.includes(maximizedId)
        ? act && visible.includes(act)
          ? act
          : maximizedId
        : null;
    set({ ...derived(next), maximizedId: max });
  };

  return {
    ...derived(initial),
    ready: false,
    maximizedId: null,
    tapeVisible: localStorage.getItem("ndx.tape") !== "0",
    cheatsheetOpen: false,
    message: null,
    focusCommandTick: 0,

    open: (panel, opts) =>
      commit((s) => {
        const id = S.activeId(s);
        if (!id) return S.addWindow(s, panel);
        return opts?.newPanel
          ? S.openInNewTab(s, id, panel, acceptsSecurity)
          : S.navigate(s, id, panel, acceptsSecurity);
      }),

    split: (dir, panel) => {
      const spec = panel ?? { fn: "BLANK", args: [] };
      const s = get().session;
      if (s.mode === "workspace") {
        const next = S.addWindow(s, spec);
        if (next === s) get().notify(`Max ${S.MAX_WORKSPACE_WINDOWS} windows`, "error");
        else commit(() => next);
        return;
      }
      const win = S.newWin(spec);
      const r = splitLeaf(s.classic, s.active.classic, dir, null, win.id);
      if (!r.newId) {
        get().notify(`Max ${MAX_PANELS} panels`, "error");
        return;
      }
      commit(() => ({
        ...s,
        classic: r.root,
        windows: { ...s.windows, [win.id]: win },
        active: { ...s.active, classic: win.id },
      }));
    },

    closeActive: () => commit((s) => (S.activeId(s) ? S.closeTab(s, S.activeId(s)!) : s)),
    newTab: () =>
      commit((s) => {
        const id = S.activeId(s);
        return id ? S.newTab(s, id) : S.addWindow(s, { fn: "BLANK", args: [] });
      }),
    reopenTab: () => {
      const s = get().session;
      if (!s.closed.length) get().notify("No closed tab to reopen");
      else commit(S.reopenTab);
    },
    selectTab: (id, index) => commit((s) => S.focusWin(S.selectTab(s, id, index), id)),
    back: () => commit((s) => (S.activeId(s) ? S.back(s, S.activeId(s)!) : s)),
    forward: () => commit((s) => (S.activeId(s) ? S.forward(s, S.activeId(s)!) : s)),
    setLink: (link, id) => commit((s) => S.setLink(s, id ?? S.activeId(s) ?? "", link)),
    pop: () => {
      const s = get().session;
      const next = S.pop(s);
      if (next === s)
        get().notify(`Max ${S.MAX_WORKSPACE_WINDOWS} components in the workspace`, "error");
      else commit(() => next);
    },
    setMode: (mode) => commit((s) => S.setMode(s, mode)),
    dropTicker: (id, ticker) =>
      commit((s) => S.focusWin(S.dropTicker(s, id, ticker, acceptsSecurity), id)),

    focus: (id) => commit((s) => S.focusWin(s, id)),

    focusDir: (dir) => {
      const { session: s, maximizedId } = get();
      if (maximizedId) return;
      const id = S.activeId(s);
      if (!id) return;
      const n =
        s.mode === "classic"
          ? neighbor(s.classic, id, dir)
          : nearestInDir(new Map(s.workspace.map((w) => [w, s.windows[w]!.rect!])), id, dir);
      if (n) commit((x) => S.focusWin(x, n));
    },

    focusIndex: (i) => {
      const id = S.visibleIds(get().session)[i];
      if (!id) return;
      commit((s) => S.focusWin(s, id));
      if (get().maximizedId) set({ maximizedId: id });
    },

    resizeActive: (axis, delta) =>
      commit((s) => {
        const id = S.activeId(s);
        if (!id) return s;
        if (s.mode === "classic") return { ...s, classic: resizeLeaf(s.classic, id, axis, delta) };
        const r = s.windows[id]!.rect!;
        const grown = axis === "row" ? { ...r, w: r.w + delta } : { ...r, h: r.h + delta };
        return S.moveRect(s, id, grown);
      }),

    setSplitRatio: (splitId, ratio) =>
      commit((s) => ({ ...s, classic: setRatio(s.classic, splitId, ratio) })),
    moveRect: (id, rect) => commit((s) => S.moveRect(s, id, rect)),

    toggleMax: () => {
      const { maximizedId, activeId } = get();
      set({ maximizedId: maximizedId || !activeId ? null : activeId });
    },

    updateLeaf: (id, panel) => commit((s) => S.replaceView(s, id, panel)),
    loadSession: (s) => set({ ...derived(s), maximizedId: null }),
    reset: () => get().loadSession(S.defaultSession()),

    toggleTape: () => {
      const v = !get().tapeVisible;
      localStorage.setItem("ndx.tape", v ? "1" : "0");
      set({ tapeVisible: v });
    },
    setCheatsheet: (open) => set({ cheatsheetOpen: open }),
    notify: (text, kind = "info") => set({ message: { text, kind, at: Date.now() } }),
    requestCommandFocus: () => set({ focusCommandTick: get().focusCommandTick + 1 }),
  };
});

// ---------------------------------------------------------------- persistence

let saveTimer: ReturnType<typeof setTimeout> | null = null;
/** Saves run one after another, so an older PUT never lands after a newer one (review 1b #23). */
let saving: Promise<void> = Promise.resolve();

/** Save the session now (OFF, quit, tests); otherwise saves are debounced after each change. */
export function flushSession(): Promise<void> {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  const next = saving
    .catch(() => undefined)
    .then(() => api.put<void>("/session", { state: useWorkspace.getState().session }));
  saving = next;
  return next;
}

/** True while a change waits for its debounced save (quit flushes it first). */
export function savePending(): boolean {
  return saveTimer !== null;
}

useWorkspace.subscribe((s, prev) => {
  // Restoring at launch is not a change: nothing is written until the user changes something,
  // so a stored session that failed validation stays in user.db (review 1b #24).
  if (!s.ready || !prev.ready || s.session === prev.session) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    flushSession().catch((e: unknown) => clientLog("warn", `session save: ${errorMessage(e)}`));
  }, SAVE_DELAY_MS);
});

/** v1 stored the current layout tree in browser localStorage. */
function v1Session(): S.Session | null {
  try {
    const raw = localStorage.getItem(V1_LAYOUT_KEY);
    const tree = raw ? validateTree(JSON.parse(raw)) : null;
    return tree ? S.fromV1Tree(tree) : null;
  } catch {
    return null;
  }
}

/** A stored session that could not be used is kept here, never silently lost (review 1b #20). */
export const BAD_SESSION_KEY = "session-bad";

export async function keepBadSession(state: unknown, error: string): Promise<void> {
  await api
    .put(`/settings/${BAD_SESSION_KEY}`, { state, error, at: new Date().toISOString() })
    .catch((e: unknown) => clientLog("warn", `keeping the bad session: ${errorMessage(e)}`));
}

type BootResult = "restored" | "migrated" | "default";
let booting: Promise<BootResult> | null = null;

/**
 * Restore the last session, once per launch. React StrictMode runs the boot effect twice in
 * development: a second, later restore would overwrite what the user already did.
 */
export function bootSession(): Promise<BootResult> {
  booting ??= restoreSession();
  return booting;
}

export function resetBootForTests(): void {
  booting = null;
}

/**
 * Restore the last session on launch: the one in user.db; else, once, v1's localStorage layout
 * (saved to user.db, then removed from localStorage); else the default classic 2×2.
 */
async function restoreSession(): Promise<BootResult> {
  const r = await api.get<{ state: unknown }>("/session");
  const stored = r.state === null ? null : S.validateSession(r.state);
  if (r.state !== null && !stored) {
    clientLog("warn", `stored session is malformed; using default (kept in ${BAD_SESSION_KEY})`);
    await keepBadSession(r.state, "failed validation");
  }
  let how: BootResult = "restored";
  let session = stored;
  if (!session) {
    session = v1Session();
    how = session ? "migrated" : "default";
    session ??= S.defaultSession();
  }
  useWorkspace.setState({ ...derived(session), maximizedId: null, ready: true });
  if (how === "migrated") await flushSession();
  localStorage.removeItem(V1_LAYOUT_KEY);
  return how;
}

export function activePanel(): PanelSpec | undefined {
  return S.activeView(useWorkspace.getState().session);
}

if (import.meta.env.DEV) {
  (window as unknown as { __ndxWorkspace: typeof useWorkspace }).__ndxWorkspace = useWorkspace;
}
