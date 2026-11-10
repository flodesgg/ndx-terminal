import { describe, expect, it } from "vitest";
import { leaf, leaves, type LayoutNode, type PanelSpec } from "./tree";
import {
  activeView,
  activeWin,
  addWindow,
  back,
  closeTab,
  current,
  defaultSession,
  dropTicker,
  focusWin,
  forward,
  fromV1Tree,
  mapViews,
  openInNewTab,
  MAX_CLOSED,
  MAX_WORKSPACE_WINDOWS,
  moveRect,
  navigate,
  newTab,
  pop,
  reopenTab,
  replaceView,
  selectTab,
  setLink,
  setMode,
  validateSession,
  migrateGpView,
  visibleIds,
  type Session,
} from "./session";

const v = (fn: string, ticker?: string, args: string[] = []): PanelSpec =>
  ticker ? { fn, ticker, args } : { fn, args };
const noTicker = new Set(["W", "WEI", "N", "HELP", "LAYOUT", "BLANK"]);
const accepts = (fn: string) => !noTicker.has(fn);

function ids(s: Session): string[] {
  return visibleIds(s);
}

describe("session model (SPEC §4.9)", () => {
  it("defaults to classic 2×2: four windows, one tab each, link none", () => {
    const s = defaultSession();
    expect(s.mode).toBe("classic");
    expect(leaves(s.classic)).toHaveLength(4);
    expect(ids(s)).toHaveLength(4);
    for (const id of ids(s)) {
      const w = s.windows[id]!;
      expect(w.tabs).toHaveLength(1);
      expect(w.link).toBe("none");
    }
    expect(activeView(s)?.fn).toBe("W");
  });

  it("navigate pushes per-tab history; back/forward walk it; a new load drops forward", () => {
    let s = defaultSession();
    const id = s.active.classic;
    s = navigate(s, id, v("GP", "AAPL US EQUITY"), accepts);
    s = navigate(s, id, v("DES", "AAPL US EQUITY"), accepts);
    expect(activeView(s)?.fn).toBe("DES");
    s = back(s, id);
    expect(activeView(s)?.fn).toBe("GP");
    s = back(s, id);
    expect(activeView(s)?.fn).toBe("W");
    expect(back(s, id)).toBe(s); // nothing further back
    s = forward(s, id);
    expect(activeView(s)?.fn).toBe("GP");
    s = navigate(s, id, v("Q", "AAPL US EQUITY"), accepts);
    expect(forward(s, id)).toBe(s); // forward entries dropped
    const tab = activeWin(s)!.tabs[0]!;
    expect(tab.history.map((h) => h.fn)).toEqual(["W", "GP", "Q"]);
  });

  it("history is per tab", () => {
    let s = defaultSession();
    const id = s.active.classic;
    s = navigate(s, id, v("GP", "AAPL US EQUITY"), accepts);
    s = newTab(s, id, v("WEI"));
    expect(activeWin(s)!.tabs).toHaveLength(2);
    expect(activeWin(s)!.activeTab).toBe(1);
    expect(back(s, id)).toBe(s); // the new tab has no history yet
    s = selectTab(s, id, 0);
    expect(activeView(s)?.fn).toBe("GP");
    s = back(s, id);
    expect(activeView(s)?.fn).toBe("W");
  });

  it("replaceView changes the current entry without adding history", () => {
    let s = defaultSession();
    const id = s.active.classic;
    s = navigate(s, id, v("GP", "AAPL US EQUITY", ["1Y"]), accepts);
    s = replaceView(s, id, v("GP", "AAPL US EQUITY", ["5Y"]));
    expect(current(activeWin(s)!.tabs[0]!).args).toEqual(["5Y"]);
    s = back(s, id);
    expect(activeView(s)?.fn).toBe("W");
  });

  it("closing tabs pushes them on a stack; reopen restores the last one where it was", () => {
    let s = defaultSession();
    const id = s.active.classic;
    s = navigate(s, id, v("GP", "AAPL US EQUITY"), accepts);
    s = newTab(s, id, v("DES", "MSFT US EQUITY"));
    s = newTab(s, id, v("Q", "NVDA US EQUITY"));
    s = closeTab(s, id);
    s = closeTab(s, id);
    expect(activeWin(s)!.tabs).toHaveLength(1);
    expect(s.closed).toHaveLength(2);
    s = reopenTab(s);
    expect(activeView(s)?.ticker).toBe("MSFT US EQUITY");
    s = reopenTab(s);
    expect(activeView(s)?.ticker).toBe("NVDA US EQUITY");
    expect(activeWin(s)!.tabs.map((t) => current(t).fn)).toEqual(["GP", "DES", "Q"]);
    expect(reopenTab(s)).toBe(s); // stack empty
  });

  it("a reopened tab keeps its history", () => {
    let s = defaultSession();
    const id = s.active.classic;
    s = newTab(s, id, v("GP", "AAPL US EQUITY"));
    s = navigate(s, id, v("DES", "AAPL US EQUITY"), accepts);
    s = closeTab(s, id);
    s = reopenTab(s);
    s = back(s, id);
    expect(activeView(s)?.fn).toBe("GP");
  });

  it("closing the last tab closes the window; reopen brings it back into the active window", () => {
    let s = defaultSession();
    const id = ids(s)[1]!;
    s = focusWin(s, id);
    const fn = activeView(s)!.fn;
    s = closeTab(s, id);
    expect(ids(s)).toHaveLength(3);
    expect(s.windows[id]).toBeUndefined();
    s = reopenTab(s);
    expect(activeView(s)?.fn).toBe(fn);
    expect(ids(s)).toHaveLength(3);
  });

  it("the reopen stack is bounded", () => {
    let s = defaultSession();
    const id = s.active.classic;
    for (let i = 0; i < MAX_CLOSED + 5; i++) {
      s = newTab(s, id, v("GP", `T${i} US EQUITY`));
      s = closeTab(s, id);
    }
    expect(s.closed).toHaveLength(MAX_CLOSED);
  });

  it("the last classic window cannot disappear: closing its last tab leaves it BLANK", () => {
    let s = defaultSession();
    for (const id of ids(s).slice(1)) s = closeTab(focusWin(s, id), id);
    const last = ids(s)[0]!;
    s = closeTab(focusWin(s, last), last);
    expect(ids(s)).toEqual([last]);
    expect(activeView(s)?.fn).toBe("BLANK");
  });

  it("LINK: loading a security loads it in every window of the same colour", () => {
    let s = defaultSession();
    const [a, b, c, d] = ids(s) as [string, string, string, string]; // W, WEI, GP SPY, N
    s = navigate(s, c, v("GP", "SPY US EQUITY"), accepts);
    s = setLink(s, a, "red");
    s = setLink(s, b, "red");
    s = setLink(s, c, "red");
    s = setLink(s, d, "blue");
    s = navigate(s, b, v("GP", "NOVOB DC EQUITY"), accepts);
    // b: GP SPY → GP NOVO; c keeps its own function (GP) with Novo; a shows W (no security).
    expect(current(s.windows[c]!.tabs[0]!)).toEqual(v("GP", "NOVOB DC EQUITY"));
    expect(current(s.windows[a]!.tabs[0]!).fn).toBe("W");
    expect(current(s.windows[d]!.tabs[0]!).ticker).not.toBe("NOVOB DC EQUITY");
    // The linked window got a history entry (Back returns to SPY).
    s = back(s, c);
    expect(current(s.windows[c]!.tabs[0]!).ticker).toBe("SPY US EQUITY");
  });

  it("LINK none never propagates", () => {
    let s = defaultSession();
    const [, b, c] = ids(s) as [string, string, string];
    s = navigate(s, c, v("GP", "SPY US EQUITY"), accepts);
    s = navigate(s, b, v("GP", "AAPL US EQUITY"), accepts);
    expect(current(s.windows[c]!.tabs[0]!).ticker).toBe("SPY US EQUITY");
  });

  it("dropping a ticker loads it in the window (keeping a security function) and its links", () => {
    let s = defaultSession();
    const [a, , b] = ids(s) as [string, string, string]; // W, WEI, GP SPY, N
    s = setLink(s, b, "green");
    const other = addWindow(setMode(s, "workspace"), v("DES", "MSFT US EQUITY"));
    s = setLink(other, other.active.workspace!, "green");
    s = setMode(s, "classic");
    s = dropTicker(s, b, "AAPL US EQUITY", accepts);
    expect(current(s.windows[b]!.tabs[0]!)).toEqual(v("GP", "AAPL US EQUITY"));
    expect(activeView(setMode(s, "workspace"))).toEqual(v("DES", "AAPL US EQUITY"));
    // A window whose function takes no security opens the security's menu, as typing it does
    // (MENU since 1b step 3; review 1b #7).
    s = dropTicker(s, a, "AAPL US EQUITY", accepts);
    expect(current(s.windows[a]!.tabs[0]!)).toEqual(v("MENU", "AAPL US EQUITY"));
  });

  it("workspace: up to 16 windows, own z-order, focus raises", () => {
    let s = setMode(defaultSession(), "workspace");
    expect(s.mode).toBe("workspace");
    // Entering an empty workspace opens one window with the active classic view.
    expect(ids(s)).toHaveLength(1);
    while (ids(s).length < MAX_WORKSPACE_WINDOWS) s = addWindow(s, v("BLANK"));
    expect(addWindow(s, v("BLANK"))).toBe(s);
    const first = ids(s)[0]!;
    s = focusWin(s, first);
    const top = Math.max(...ids(s).map((i) => s.windows[i]!.z ?? 0));
    expect(s.windows[first]!.z).toBe(top);
  });

  it("workspace rects snap to the grid and stay inside the area", () => {
    let s = setMode(defaultSession(), "workspace");
    const id = ids(s)[0]!;
    s = moveRect(s, id, { x: 0.513, y: -0.2, w: 0.9, h: 0.031 });
    const r = s.windows[id]!.rect!;
    expect(r.x + r.w).toBeLessThanOrEqual(1 + 1e-9);
    expect(r.y).toBe(0);
    expect(r.h).toBeGreaterThanOrEqual(0.1);
    expect(Math.round(r.x * 48)).toBeCloseTo(r.x * 48, 9);
  });

  it("new workspace windows go to the first free slot; they cascade only when none is left", () => {
    let s = pop(defaultSession()); // a component first
    s = addWindow(s, v("BLANK"));
    s = addWindow(s, v("BLANK"));
    const rects = s.workspace.map((id) => s.windows[id]!.rect!);
    const overlap = (a: (typeof rects)[0], b: (typeof rects)[0]) =>
      a.x < b.x + b.w - 1e-9 &&
      b.x < a.x + a.w - 1e-9 &&
      a.y < b.y + b.h - 1e-9 &&
      b.y < a.y + a.h - 1e-9;
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) expect(overlap(rects[i]!, rects[j]!)).toBe(false);
    }
    while (s.workspace.length < MAX_WORKSPACE_WINDOWS) s = addWindow(s, v("BLANK"));
    for (const id of s.workspace) {
      const r = s.windows[id]!.rect!;
      expect(r.x + r.w).toBeLessThanOrEqual(1 + 1e-9);
      expect(r.y + r.h).toBeLessThanOrEqual(1 + 1e-9);
    }
  });

  it("components do not count toward the 16 free windows (review 1b #26)", () => {
    let s = defaultSession();
    for (let i = 0; i < 6; i++) s = pop(focusWin(s, ids(s)[0]!));
    const comps = () => s.workspace.filter((w) => s.windows[w]!.component).length;
    expect(comps()).toBe(6);
    while (s.workspace.length - comps() < MAX_WORKSPACE_WINDOWS) {
      const next = addWindow(s, v("BLANK"));
      expect(next).not.toBe(s);
      s = next;
    }
    expect(s.workspace.length).toBe(MAX_WORKSPACE_WINDOWS + 6);
    expect(addWindow(s, v("BLANK"))).toBe(s); // the 17th free window is refused
    expect(validateSession(JSON.parse(JSON.stringify(s)))).not.toBeNull();
  });

  it("POP sends the current function into the workspace as a component", () => {
    let s = defaultSession();
    const id = ids(s)[1]!;
    s = focusWin(s, id);
    const view = activeView(s)!;
    s = pop(s);
    expect(s.mode).toBe("workspace");
    const w = activeWin(s)!;
    expect(w.component).toBe(true);
    expect(current(w.tabs[0]!)).toEqual(view);
    // The classic window stays where it was.
    expect(s.windows[id]).toBeDefined();
    expect(leaves(s.classic).map((l) => l.id)).toContain(id);
  });

  it("serialises and validates; garbage is rejected", () => {
    let s = defaultSession();
    s = navigate(s, s.active.classic, v("GP", "AAPL US EQUITY"), accepts);
    s = setLink(s, s.active.classic, "yellow");
    s = setMode(s, "workspace");
    const back2 = validateSession(JSON.parse(JSON.stringify(s)));
    expect(back2).toEqual(s);
    expect(validateSession(null)).toBeNull();
    expect(validateSession({ v: 2 })).toBeNull();
    expect(validateSession({ ...s, mode: "x" })).toBeNull();
    const badLink = JSON.parse(JSON.stringify(s)) as Session;
    badLink.windows[s.active.classic]!.link = "purple" as never;
    expect(validateSession(badLink)).toBeNull();
    const badRef = JSON.parse(JSON.stringify(s)) as Session;
    delete badRef.windows[s.active.classic];
    expect(validateSession(badRef)).toBeNull();
  });

  it("rejects stored states that would crash rendering (review 1b #20)", () => {
    let s = defaultSession();
    s = setMode(s, "workspace");
    const ok = JSON.stringify(s);
    const bad = (f: (x: Session) => void) => {
      const x = JSON.parse(ok) as Session;
      f(x);
      return validateSession(x);
    };
    const w = (x: Session) => x.windows[x.active.classic]!;
    const free = (x: Session) => x.windows[x.workspace[0]!]!;
    expect(bad(() => {})).not.toBeNull();
    expect(bad((x) => (w(x).activeTab = -1))).toBeNull();
    expect(bad((x) => ((w(x).tabs[0]!.history[0] as { ticker: unknown }).ticker = 5))).toBeNull();
    expect(bad((x) => ((w(x).tabs[0]!.history[0]!.args as unknown[]) = [5]))).toBeNull();
    expect(bad((x) => delete free(x).rect)).toBeNull();
    // A closed tab without its index is dropped (reopening it would set activeTab NaN).
    const closed = bad((x) => {
      x.closed = [{ winId: x.active.classic, tab: w(x).tabs[0]! } as never];
    });
    expect(closed?.closed).toEqual([]);
  });

  it("migrates a v1 layout tree (localStorage / saved layouts) into classic windows", () => {
    const tree: LayoutNode = {
      type: "split",
      id: "s1",
      dir: "row",
      ratio: 0.4,
      a: leaf(v("W", undefined, ["CORE"]), "p1"),
      b: leaf(v("GP", "AAPL US EQUITY"), "p2"),
    };
    const s = fromV1Tree(tree);
    expect(s.mode).toBe("classic");
    expect(ids(s)).toEqual(["p1", "p2"]);
    expect(current(s.windows.p2!.tabs[0]!)).toEqual(v("GP", "AAPL US EQUITY"));
    expect(s.classic.type === "split" && s.classic.ratio).toBe(0.4);
    expect(validateSession(s)).toEqual(s);
  });
  it("linked windows that diverged resync when the source loads its own security (#21)", () => {
    let s = defaultSession();
    const [, , c, d] = ids(s) as [string, string, string, string];
    s = navigate(s, c, v("GP", "AAPL US EQUITY"), accepts);
    s = navigate(s, d, v("DES", "MSFT US EQUITY"), accepts);
    s = setLink(setLink(s, c, "red"), d, "red");
    s = navigate(s, c, v("DES", "AAPL US EQUITY"), accepts);
    expect(current(s.windows[d]!.tabs[0]!)).toEqual(v("DES", "AAPL US EQUITY"));
  });

  it("GO in a new tab also loads the security in linked windows", () => {
    let s = defaultSession();
    const [a, , c] = ids(s) as [string, string, string];
    s = setLink(setLink(s, a, "red"), c, "red");
    s = openInNewTab(s, a, v("DES", "MSFT US EQUITY"), accepts);
    expect(s.windows[a]!.tabs).toHaveLength(2);
    expect(current(s.windows[c]!.tabs[0]!).ticker).toBe("MSFT US EQUITY");
  });

  it("mapViews rewrites every history entry and keeps identity when nothing changes", () => {
    let s = defaultSession();
    s = navigate(s, s.active.classic, v("GP", "NOVO-B.CO"), accepts);
    expect(mapViews(s, (x) => x)).toBe(s);
    const m = mapViews(s, (x) =>
      x.ticker === "NOVO-B.CO" ? { ...x, ticker: "NOVOB DC EQUITY" } : x,
    );
    expect(activeView(m)?.ticker).toBe("NOVOB DC EQUITY");
  });
});

describe("GP args grammar 2 (SPEC §8 ranges): saved sessions migrate once", () => {
  it("a leading 1D / 1M saved before was daily / monthly bars; ranges elsewhere stay", () => {
    expect(migrateGpView({ fn: "GP", ticker: "X", args: ["1D", "RSI"] }).args).toEqual([
      "D",
      "RSI",
    ]);
    expect(migrateGpView({ fn: "GP", ticker: "X", args: ["1M"] }).args).toEqual(["1MO"]);
    expect(migrateGpView({ fn: "GP", ticker: "X", args: ["5", "1D"] }).args).toEqual(["5", "1D"]);
    const des = { fn: "DES", ticker: "X", args: ["1D"] };
    expect(migrateGpView(des)).toBe(des);
  });

  it("validateSession migrates an old session once and marks it", () => {
    const old = defaultSession() as Session;
    delete old.gpArgs;
    const win = Object.values(old.windows).find((w) => w.tabs[0]!.history[0]!.fn === "GP")!;
    win.tabs[0]!.history[0] = { fn: "GP", ticker: "SPY US EQUITY", args: ["1D"] };
    const s = validateSession(JSON.parse(JSON.stringify(old)))!;
    expect(s.gpArgs).toBe(2);
    const gp = Object.values(s.windows)
      .flatMap((w) => w.tabs[0]!.history)
      .find((v) => v.fn === "GP")!;
    expect(gp.args).toEqual(["D"]);
    // Marked: a typed `GP 1D` (the range) is not rewritten again.
    const again = validateSession(JSON.parse(JSON.stringify({ ...s, windows: old.windows })))!;
    const gp2 = Object.values(again.windows)
      .flatMap((w) => w.tabs[0]!.history)
      .find((v) => v.fn === "GP")!;
    expect(gp2.args).toEqual(["1D"]);
  });
});
