import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { executeCommand } from "./executor";
import { ACTIONS } from "./keys";
import { hasItem, windowItems } from "./items";
import { activeView, defaultSession } from "./layout/session";
import { useWorkspace } from "./layout/store";
import { menuEntries, menuParent } from "./menu";
import { SECTOR_TOKENS } from "./sectors";

beforeAll(async () => {
  window.matchMedia ??= (() => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  })) as unknown as typeof window.matchMedia;
  const { registerAllFunctions } = await import("@/functions");
  registerAllFunctions();
});

const ws = () => useWorkspace.getState();
const view = () => activeView(ws().session);

beforeEach(() => ws().loadSession(defaultSession()));

describe("MENU: hierarchical, numbered sector/security menus (SPEC §7, §4.4)", () => {
  it("top level: the sector menus first (F-key order), then global functions", () => {
    const top = menuEntries({ fn: "MENU", args: [] });
    const sectors = SECTOR_TOKENS;
    expect(top.slice(0, sectors.length).map((e) => e.label)).toEqual(sectors);
    expect(top[0]).toMatchObject({ n: 1, target: { fn: "MENU", args: ["GOVT"] } });
    const globals = top.slice(sectors.length);
    expect(globals.map((e) => e.label)).toContain("HELP");
    expect(globals.map((e) => e.label)).toContain("LAYOUT");
    // WEI sits in the INDEX and EQUITY menus, not at the top.
    expect(globals.map((e) => e.label)).not.toContain("WEI");
    // Numbered 1…N without gaps, never into the reserved 95–99.
    expect(top.map((e) => e.n)).toEqual(top.map((_, i) => i + 1));
    expect(top.length).toBeLessThan(95);
  });

  it("a sector menu lists that sector's functions with their menu path", () => {
    const m = menuEntries({ fn: "MENU", args: ["CURNCY"] });
    const fx = m.find((e) => e.label === "FX")!;
    expect(fx.path).toBe("Market › FX");
    expect(fx.target).toEqual({ fn: "FX", args: [] });
    // A function that needs a security is listed, not numbered: there is nothing to run it on.
    const gp = m.find((e) => e.label === "GP")!;
    expect(gp.n).toBeUndefined();
    expect(gp.target).toBeUndefined();
    const numbered = m.filter((e) => e.n !== undefined).map((e) => e.n);
    expect(numbered).toEqual(numbered.map((_, i) => i + 1));
  });

  it("a sector without a free source says so (MTGE, MUNI, PFD)", () => {
    expect(menuEntries({ fn: "MENU", args: ["MTGE"] })).toEqual([]);
  });

  it("a security menu runs its sector's functions against the security", () => {
    const m = menuEntries({ fn: "MENU", ticker: "AAPL US EQUITY", args: [] });
    const des = m.find((e) => e.label === "DES")!;
    expect(des.n).toBeGreaterThan(0);
    expect(des.target).toEqual({ fn: "DES", ticker: "AAPL US EQUITY", args: [] });
    expect(m.every((e) => e.target?.ticker === "AAPL US EQUITY")).toBe(true);
    // Only functions that take a security: no WEI, no EQS screen in a security menu.
    expect(m.map((e) => e.label)).not.toContain("EQS");
  });

  it("a sector token or a bare security opens MENU (no longer HELP)", async () => {
    await executeCommand("CURNCY");
    expect(view()).toMatchObject({ fn: "MENU", args: ["CURNCY"] });
    await executeCommand("AAPL US EQUITY");
    expect(view()).toMatchObject({ fn: "MENU", ticker: "AAPL US EQUITY" });
    await executeCommand("MENU");
    expect(view()).toMatchObject({ fn: "MENU", args: [] });
  });

  it("menu rows are numbered items: N + Enter runs row N", async () => {
    await executeCommand("AAPL US EQUITY");
    const id = ws().activeId;
    const m = menuEntries(view()!);
    const des = m.find((e) => e.label === "DES")!;
    expect(hasItem(id, des.n!)).toBe(true);
    // Content items stay out of the toolbar list (they are the menu rows).
    expect(windowItems(id).find((i) => i.n === des.n)?.content).toBe(true);
    await executeCommand(String(des.n));
    expect(view()).toMatchObject({ fn: "DES", ticker: "AAPL US EQUITY" });
  });

  it("⌘↑ goes up one level: function → security menu → sector menu → MENU", () => {
    expect(menuParent({ fn: "GP", ticker: "AAPL US EQUITY", args: ["1Y"] })).toEqual({
      fn: "MENU",
      ticker: "AAPL US EQUITY",
      args: [],
    });
    expect(menuParent({ fn: "MENU", ticker: "EURUSD CURNCY", args: [] })).toEqual({
      fn: "MENU",
      args: ["CURNCY"],
    });
    expect(menuParent({ fn: "MENU", args: ["CURNCY"] })).toEqual({ fn: "MENU", args: [] });
    expect(menuParent({ fn: "WEI", args: [] })).toEqual({ fn: "MENU", args: [] });
    expect(menuParent({ fn: "MENU", args: [] })).toBeNull();

    ws().open({ fn: "GP", ticker: "AAPL US EQUITY", args: [] });
    ACTIONS["menu-up"]!();
    expect(view()).toMatchObject({ fn: "MENU", ticker: "AAPL US EQUITY" });
    ACTIONS["menu-up"]!();
    expect(view()).toMatchObject({ fn: "MENU", args: ["EQUITY"] });
  });

  it("⌃Enter opens the function menu of the window's security", () => {
    ws().open({ fn: "GP", ticker: "MSFT US EQUITY", args: [] });
    ACTIONS["function-menu"]!();
    expect(view()).toMatchObject({ fn: "MENU", ticker: "MSFT US EQUITY" });
  });
});
