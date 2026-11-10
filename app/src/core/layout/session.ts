/**
 * Window model (SPEC §4.9): windows → tabs → (security, function, args) with per-tab history and a
 * link colour per window. Two modes share one session: classic (tiled panels, `tree.ts` is the
 * tiler) and workspace (up to 16 free windows and popped components). Pure functions only; the
 * store (store.ts) wraps them, and the session is saved to user.db (server `/session`).
 */
import {
  findLeaf,
  leaf,
  leaves,
  newId,
  removeLeaf,
  validateTree,
  isPanelSpec,
  type LayoutNode,
  type PanelSpec,
  type Rect,
} from "./tree";

export const LINK_COLORS = ["none", "red", "green", "blue", "yellow"] as const;
export type LinkColor = (typeof LINK_COLORS)[number];
export type Mode = "classic" | "workspace";

export const MAX_WORKSPACE_WINDOWS = 16;
export const MAX_CLOSED = 20;
export const MAX_HISTORY = 50;
/** Workspace geometry: fractions of the area, snapped to a 1/48 grid. */
export const SNAP = 48;
export const MIN_SIZE = 0.1;

export interface Tab {
  id: string;
  history: PanelSpec[];
  /** Index of the current entry in `history`. */
  at: number;
}

export interface Win {
  id: string;
  tabs: Tab[];
  activeTab: number;
  link: LinkColor;
  /** Workspace only: a popped component (compact frame, no tab bar). */
  component?: boolean;
  /** Workspace only: position and size. */
  rect?: Rect;
  /** Workspace only: stacking order (higher = in front). */
  z?: number;
}

export interface ClosedTab {
  winId: string;
  index: number;
  tab: Tab;
}

export interface Session {
  v: 2;
  mode: Mode;
  windows: Record<string, Win>;
  /** Classic tiler: leaves are window ids. */
  classic: LayoutNode<null>;
  /** Workspace windows in creation order (numbering for ⌘1…9). */
  workspace: string[];
  active: { classic: string; workspace: string | null };
  /** Reopen-closed-tab stack (last closed at the end). */
  closed: ClosedTab[];
  /** GP args grammar: 2 = SPEC §8 ranges (`1D` and `1M` are ranges; daily bars `D`, monthly
   * `1MO`). Missing = saved before it, migrated once on load (`validateSession`). */
  gpArgs?: 2;
}

/** A GP view saved before `gpArgs: 2`: the formatter wrote the timeframe first, so a leading
 * `1D` was daily bars and a leading `1M` monthly bars. */
export function migrateGpView(v: PanelSpec): PanelSpec {
  if (v.fn !== "GP" || !v.args.length) return v;
  const first = v.args[0]!.toUpperCase();
  const tf = first === "1D" ? "D" : first === "1M" ? "1MO" : null;
  return tf ? { ...v, args: [tf, ...v.args.slice(1)] } : v;
}

/** Does a function take a security? (registry-backed in the store; injected for tests). */
export type Accepts = (fn: string) => boolean;

// ---------------------------------------------------------------- queries

export function current(tab: Tab): PanelSpec {
  return tab.history[tab.at]!;
}

export function visibleIds(s: Session): string[] {
  return s.mode === "classic" ? leaves(s.classic).map((l) => l.id) : [...s.workspace];
}

export function activeId(s: Session): string | null {
  return s.mode === "classic" ? s.active.classic : s.active.workspace;
}

export function activeWin(s: Session): Win | undefined {
  const id = activeId(s);
  return id ? s.windows[id] : undefined;
}

export function winView(w: Win): PanelSpec {
  return current(w.tabs[w.activeTab]!);
}

export function activeView(s: Session): PanelSpec | undefined {
  const w = activeWin(s);
  return w ? winView(w) : undefined;
}

/** Every view in every tab's history (for symbol migration and saved-layout scans). */
export function allViews(s: Session): PanelSpec[] {
  return Object.values(s.windows).flatMap((w) => w.tabs.flatMap((t) => t.history));
}

// ---------------------------------------------------------------- construction

export function newTabOf(view: PanelSpec): Tab {
  return { id: newId("t"), history: [view], at: 0 };
}

export function newWin(view: PanelSpec, id = newId("w")): Win {
  return { id, tabs: [newTabOf(view)], activeTab: 0, link: "none" };
}

function classicOf(
  views: [PanelSpec, PanelSpec, PanelSpec, PanelSpec],
): Pick<Session, "windows" | "classic"> {
  const ws = views.map((v) => newWin(v));
  const [a, b, c, d] = ws.map((w) => leaf(null, w.id));
  return {
    windows: Object.fromEntries(ws.map((w) => [w.id, w])),
    classic: {
      type: "split",
      id: "s-root",
      dir: "row",
      ratio: 0.38,
      a: { type: "split", id: "s-left", dir: "col", ratio: 0.55, a: a!, b: b! },
      b: { type: "split", id: "s-right", dir: "col", ratio: 0.62, a: c!, b: d! },
    },
  };
}

/** Classic 2×2: watchlist, world indices, chart, news. */
export function defaultSession(): Session {
  const { windows, classic } = classicOf([
    { fn: "W", args: [] },
    { fn: "WEI", args: [] },
    { fn: "GP", ticker: "SPY US EQUITY", args: [] },
    { fn: "TOP", args: [] },
  ]);
  return {
    v: 2,
    mode: "classic",
    windows,
    classic,
    workspace: [],
    active: { classic: leaves(classic)[0]!.id, workspace: null },
    closed: [],
    gpArgs: 2,
  };
}

/** A v1 layout tree (panels at the leaves) → a classic session with one tab per window. */
export function fromV1Tree(tree: LayoutNode<PanelSpec>): Session {
  const windows: Record<string, Win> = {};
  const strip = (n: LayoutNode<PanelSpec>): LayoutNode<null> => {
    if (n.type === "leaf") {
      windows[n.id] = newWin(n.panel, n.id);
      return leaf(null, n.id);
    }
    return { ...n, a: strip(n.a), b: strip(n.b) };
  };
  const classic = strip(tree);
  return {
    v: 2,
    mode: "classic",
    windows,
    classic,
    workspace: [],
    active: { classic: leaves(classic)[0]!.id, workspace: null },
    closed: [],
    gpArgs: 2,
  };
}

// ---------------------------------------------------------------- tab-level updates

function withWin(s: Session, id: string, fn: (w: Win) => Win): Session {
  const w = s.windows[id];
  if (!w) return s;
  const next = fn(w);
  return next === w ? s : { ...s, windows: { ...s.windows, [id]: next } };
}

function withTab(w: Win, fn: (t: Tab) => Tab): Win {
  const t = w.tabs[w.activeTab]!;
  const next = fn(t);
  if (next === t) return w;
  const tabs = [...w.tabs];
  tabs[w.activeTab] = next;
  return { ...w, tabs };
}

function sameView(a: PanelSpec, b: PanelSpec): boolean {
  return a.fn === b.fn && a.ticker === b.ticker && a.args.join(" ") === b.args.join(" ");
}

function push(t: Tab, view: PanelSpec): Tab {
  if (sameView(current(t), view)) return t;
  const history = [...t.history.slice(0, t.at + 1), view].slice(-MAX_HISTORY);
  return { ...t, history, at: history.length - 1 };
}

/**
 * Load a view in a window's active tab (adds history). A security loaded into a linked window is
 * loaded in every other window of the same colour, which keeps its own function when that function
 * takes a security (windows whose function takes none are left alone).
 */
export function navigate(s: Session, id: string, view: PanelSpec, accepts: Accepts): Session {
  const w = s.windows[id];
  if (!w) return s;
  const next = withWin(s, id, (x) => withTab(x, (t) => push(t, view)));
  return propagate(next, id, view.ticker, accepts);
}

/** GO in a new tab (Shift+Enter): a new tab with the view; linked windows follow the security. */
export function openInNewTab(s: Session, id: string, view: PanelSpec, accepts: Accepts): Session {
  const w = s.windows[id];
  if (!w) return s;
  return propagate(newTab(s, id, view), id, view.ticker, accepts);
}

/**
 * Load `ticker` in the source window's linked windows. Also when the source already showed it:
 * linked windows that diverged (Back, LINK joining) resync (review 1b #21); a window that
 * already shows the security is left as it is.
 */
function propagate(s: Session, id: string, ticker: string | undefined, accepts: Accepts): Session {
  const link = s.windows[id]!.link;
  if (link === "none" || !ticker) return s;
  let next = s;
  for (const other of Object.values(s.windows)) {
    if (other.id === id || other.link !== link) continue;
    const cur = winView(other);
    if (!accepts(cur.fn) || cur.ticker === ticker) continue;
    next = withWin(next, other.id, (x) => withTab(x, (t) => push(t, { ...cur, ticker })));
  }
  return next;
}

/** Rewrite every view in every tab's history (symbol migration); same object when unchanged. */
export function mapViews(s: Session, f: (v: PanelSpec) => PanelSpec): Session {
  let changed = false;
  const windows: Record<string, Win> = {};
  for (const [id, w] of Object.entries(s.windows)) {
    let wChanged = false;
    const tabs = w.tabs.map((t) => {
      const history = t.history.map((v) => {
        const n = f(v);
        if (n !== v) wChanged = true;
        return n;
      });
      return wChanged ? { ...t, history } : t;
    });
    windows[id] = wChanged ? { ...w, tabs } : w;
    changed ||= wChanged;
  }
  return changed ? { ...s, windows } : s;
}

/** Replace the current entry (e.g. a timeframe change) without adding history. */
export function replaceView(s: Session, id: string, view: PanelSpec): Session {
  return withWin(s, id, (w) =>
    withTab(w, (t) => {
      if (sameView(current(t), view)) return t;
      const history = [...t.history];
      history[t.at] = view;
      return { ...t, history };
    }),
  );
}

export function back(s: Session, id: string): Session {
  return withWin(s, id, (w) => withTab(w, (t) => (t.at > 0 ? { ...t, at: t.at - 1 } : t)));
}

export function forward(s: Session, id: string): Session {
  return withWin(s, id, (w) =>
    withTab(w, (t) => (t.at < t.history.length - 1 ? { ...t, at: t.at + 1 } : t)),
  );
}

/** The security's menu (what typing the bare security runs, SPEC §4.4; core/executor.ts). */
function securityMenu(ticker: string): PanelSpec {
  return { fn: "MENU", ticker, args: [] };
}

/** A ticker dragged onto a window loads there (and in its linked windows). */
export function dropTicker(s: Session, id: string, ticker: string, accepts: Accepts): Session {
  const w = s.windows[id];
  if (!w) return s;
  const cur = winView(w);
  const view = accepts(cur.fn) ? { ...cur, ticker } : securityMenu(ticker);
  return navigate(s, id, view, accepts);
}

// ---------------------------------------------------------------- tabs

export function newTab(s: Session, id: string, view?: PanelSpec): Session {
  return withWin(s, id, (w) => {
    const tab = newTabOf(view ?? { fn: "BLANK", args: [] });
    return { ...w, tabs: [...w.tabs, tab], activeTab: w.tabs.length };
  });
}

export function selectTab(s: Session, id: string, index: number): Session {
  return withWin(s, id, (w) =>
    index >= 0 && index < w.tabs.length && index !== w.activeTab ? { ...w, activeTab: index } : w,
  );
}

function remember(s: Session, c: ClosedTab): ClosedTab[] {
  return [...s.closed, c].slice(-MAX_CLOSED);
}

/** Close the active tab; the last tab closes the window (the last classic window turns BLANK). */
export function closeTab(s: Session, id: string): Session {
  const w = s.windows[id];
  if (!w) return s;
  const tab = w.tabs[w.activeTab]!;
  const closed = remember(s, { winId: id, index: w.activeTab, tab });
  if (w.tabs.length > 1) {
    const tabs = w.tabs.filter((_, i) => i !== w.activeTab);
    const activeTab = Math.min(w.activeTab, tabs.length - 1);
    return { ...s, closed, windows: { ...s.windows, [id]: { ...w, tabs, activeTab } } };
  }
  return { ...closeWindow(s, id), closed };
}

/** Remove a window. The last classic window stays, empty. */
export function closeWindow(s: Session, id: string): Session {
  const w = s.windows[id];
  if (!w) return s;
  const windows = { ...s.windows };
  if (s.classic.type === "leaf" && s.classic.id === id) {
    windows[id] = newWin({ fn: "BLANK", args: [] }, id);
    windows[id] = { ...windows[id], link: w.link };
    return { ...s, windows };
  }
  delete windows[id];
  if (findLeaf(s.classic, id)) {
    const classic = removeLeaf(s.classic, id);
    const ids = leaves(classic).map((l) => l.id);
    const active = s.active.classic === id ? ids[0]! : s.active.classic;
    return { ...s, windows, classic, active: { ...s.active, classic: active } };
  }
  const workspace = s.workspace.filter((x) => x !== id);
  const active =
    s.active.workspace === id
      ? (topmost({ ...s, windows, workspace }) ?? null)
      : s.active.workspace;
  return { ...s, windows, workspace, active: { ...s.active, workspace: active } };
}

/** Reopen the last closed tab: in its window when it still exists, else in the active one. */
export function reopenTab(s: Session): Session {
  const c = s.closed.at(-1);
  if (!c) return s;
  const closed = s.closed.slice(0, -1);
  const inMode = visibleIds(s).includes(c.winId);
  const target = inMode ? c.winId : activeId(s);
  if (!target) {
    // An empty workspace: the tab comes back as a window of its own.
    const w = { ...newWin(current(c.tab)), tabs: [c.tab] };
    return focusWin(addWin({ ...s, closed }, w), w.id);
  }
  const w = s.windows[target]!;
  const index = inMode ? Math.min(c.index, w.tabs.length) : w.tabs.length;
  const tabs = [...w.tabs.slice(0, index), c.tab, ...w.tabs.slice(index)];
  const next = {
    ...s,
    closed,
    windows: { ...s.windows, [target]: { ...w, tabs, activeTab: index } },
  };
  return focusWin(next, target);
}

// ---------------------------------------------------------------- windows, modes, links

export function setLink(s: Session, id: string, link: LinkColor): Session {
  return withWin(s, id, (w) => (w.link === link ? w : { ...w, link }));
}

function topmost(s: Session): string | undefined {
  let best: Win | undefined;
  for (const id of s.workspace) {
    const w = s.windows[id]!;
    if (!best || (w.z ?? 0) >= (best.z ?? 0)) best = w;
  }
  return best?.id;
}

function maxZ(s: Session): number {
  return Math.max(0, ...s.workspace.map((id) => s.windows[id]!.z ?? 0));
}

export function focusWin(s: Session, id: string): Session {
  if (!s.windows[id]) return s;
  if (findLeaf(s.classic, id)) {
    return s.active.classic === id ? s : { ...s, active: { ...s.active, classic: id } };
  }
  if (!s.workspace.includes(id)) return s;
  const raised =
    (s.windows[id]!.z ?? 0) === maxZ(s) ? s : withWin(s, id, (w) => ({ ...w, z: maxZ(s) + 1 }));
  return raised.active.workspace === id
    ? raised
    : { ...raised, active: { ...raised.active, workspace: id } };
}

export function snapRect(r: Rect): Rect {
  const q = (x: number) => Math.round(x * SNAP) / SNAP;
  const w = Math.min(1, Math.max(MIN_SIZE, q(r.w)));
  const h = Math.min(1, Math.max(MIN_SIZE, q(r.h)));
  const x = Math.min(1 - w, Math.max(0, q(r.x)));
  const y = Math.min(1 - h, Math.max(0, q(r.y)));
  return { x, y, w, h };
}

export function moveRect(s: Session, id: string, rect: Rect): Session {
  if (!s.workspace.includes(id)) return s;
  return withWin(s, id, (w) => ({ ...w, rect: snapRect(rect) }));
}

function cascade(n: number, size: { w: number; h: number }): Rect {
  const step = (n % 8) / 24;
  return snapRect({ x: step, y: step, ...size });
}

function overlaps(a: Rect, b: Rect): boolean {
  const e = 1e-9;
  return a.x < b.x + b.w - e && b.x < a.x + a.w - e && a.y < b.y + b.h - e && b.y < a.y + a.h - e;
}

/** First grid slot (quadrants for windows, a 4×3 grid for components) clear of every window. */
function place(s: Session, component: boolean): Rect {
  const [cols, rows] = component ? [4, 3] : [2, 2];
  const taken = s.workspace.map((id) => s.windows[id]!.rect!);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const slot = snapRect({ x: c / cols, y: r / rows, w: 1 / cols, h: 1 / rows });
      if (!taken.some((t) => overlaps(slot, t))) return slot;
    }
  }
  return cascade(s.workspace.length, { w: 1 / cols, h: 1 / rows });
}

/** Workspace entries of the same kind as `w`: free windows and components are capped apart. */
function sameKind(s: Session, component: boolean): number {
  return s.workspace.filter((id) => !!s.windows[id]?.component === component).length;
}

/** SPEC §4.9: up to 16 free windows, plus components (kept to 16 as well). */
export function freeWindowCount(s: Session): number {
  return sameKind(s, false);
}

function addWin(s: Session, w: Win): Session {
  if (sameKind(s, !!w.component) >= MAX_WORKSPACE_WINDOWS) return s;
  const win: Win = { ...w, rect: w.rect ?? place(s, !!w.component), z: maxZ(s) + 1 };
  return {
    ...s,
    windows: { ...s.windows, [win.id]: win },
    workspace: [...s.workspace, win.id],
    active: { ...s.active, workspace: win.id },
  };
}

/** A new workspace window (no-op at 16). */
export function addWindow(s: Session, view: PanelSpec): Session {
  return addWin(s, newWin(view));
}

export function setMode(s: Session, mode: Mode): Session {
  if (s.mode === mode) return s;
  let next: Session = { ...s, mode };
  if (mode === "workspace" && !s.workspace.length) {
    const view = activeView(s) ?? { fn: "BLANK", args: [] };
    next = addWindow(next, view);
  }
  return next;
}

/** POP: the current function goes into the workspace as a component (SPEC §4.9). */
export function pop(s: Session): Session {
  const view = activeView(s);
  if (!view) return s;
  const w = activeWin(s)!;
  const comp: Win = { ...newWin(view), component: true, link: w.link };
  const next = addWin({ ...s, mode: "workspace" }, comp);
  return next.workspace.length === s.workspace.length ? s : next;
}

// ---------------------------------------------------------------- validation

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null;

function validTab(t: unknown): t is Tab {
  if (!isObj(t) || typeof t.id !== "string" || !Array.isArray(t.history)) return false;
  if (!t.history.length || !t.history.every(isPanelSpec)) return false;
  return Number.isInteger(t.at) && (t.at as number) >= 0 && (t.at as number) < t.history.length;
}

function validRect(r: unknown): boolean {
  return isObj(r) && ["x", "y", "w", "h"].every((k) => typeof r[k] === "number");
}

function validWin(w: unknown, id: string): w is Win {
  if (!isObj(w) || w.id !== id || !Array.isArray(w.tabs) || !w.tabs.length) return false;
  if (!w.tabs.every(validTab)) return false;
  const at = w.activeTab as number;
  if (!Number.isInteger(at) || at < 0 || at >= w.tabs.length) return false;
  if (!LINK_COLORS.includes(w.link as LinkColor)) return false;
  return w.rect === undefined || validRect(w.rect);
}

/** Validate a session loaded from storage. Returns null when malformed. */
export function validateSession(x: unknown): Session | null {
  if (!isObj(x) || x.v !== 2 || (x.mode !== "classic" && x.mode !== "workspace")) return null;
  if (!isObj(x.windows) || !Array.isArray(x.workspace) || !Array.isArray(x.closed)) return null;
  const windows = x.windows;
  for (const [id, w] of Object.entries(windows)) if (!validWin(w, id)) return null;
  const classic = validateTree<null>(x.classic, (p) => p === null);
  if (!classic) return null;
  const tiled = leaves(classic).map((l) => l.id);
  const free = x.workspace as unknown[];
  if (!free.every((id) => typeof id === "string" && id in windows)) return null;
  // Free windows are placed by their rect (review 1b #20).
  if (!free.every((id) => validRect((windows[id as string] as Record<string, unknown>).rect))) {
    return null;
  }
  if (!tiled.every((id) => id in windows)) return null;
  if (
    free.filter((id) => !(windows[id as string] as { component?: unknown }).component).length >
      MAX_WORKSPACE_WINDOWS ||
    free.filter((id) => (windows[id as string] as { component?: unknown }).component).length >
      MAX_WORKSPACE_WINDOWS ||
    new Set([...tiled, ...free]).size !== tiled.length + free.length
  ) {
    return null;
  }
  const a = x.active;
  if (!isObj(a) || typeof a.classic !== "string" || !tiled.includes(a.classic)) return null;
  if (a.workspace !== null && !(typeof a.workspace === "string" && free.includes(a.workspace))) {
    return null;
  }
  const closed = x.closed.filter(
    (c): c is ClosedTab =>
      isObj(c) &&
      typeof c.winId === "string" &&
      Number.isInteger(c.index) &&
      (c.index as number) >= 0 &&
      validTab(c.tab),
  );
  const s: Session = { ...(x as unknown as Session), classic, closed };
  if (s.gpArgs === 2) return s;
  const migrated = mapViews(s, migrateGpView);
  return {
    ...migrated,
    closed: migrated.closed.map((c) => ({
      ...c,
      tab: { ...c.tab, history: c.tab.history.map(migrateGpView) },
    })),
    gpArgs: 2,
  };
}
