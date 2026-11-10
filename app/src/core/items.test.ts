import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { executeCommand } from "./executor";
import { hasItem, usePopup, windowItems } from "./items";
import { activeView, defaultSession } from "./layout/session";
import { useWorkspace } from "./layout/store";

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

beforeEach(() => {
  ws().loadSession(defaultSession());
  usePopup.getState().close();
});

describe("numbered items N) (SPEC §4.8)", () => {
  it("a DES window has its own items 1–4 and the title-bar items 95–99", () => {
    ws().open({ fn: "DES", ticker: "AAPL US EQUITY", args: [] });
    const id = ws().activeId;
    expect(windowItems(id).map((i) => `${i.n}) ${i.label}`)).toEqual([
      "1) Quote",
      "2) Chart",
      "3) Financials",
      "4) News",
      "95) Actions",
      "96) Export",
      "97) Settings",
      "98) Note",
      "99) Help",
    ]);
    expect(hasItem(id, 3)).toBe(true);
    expect(hasItem(id, 50)).toBe(false);
  });

  it("typing N + Enter runs item N in the active window", async () => {
    ws().open({ fn: "DES", ticker: "AAPL US EQUITY", args: [] });
    expect((await executeCommand("1")).ok).toBe(true);
    expect(view()).toMatchObject({ fn: "Q", ticker: "AAPL US EQUITY" });
    // GP: 1)–9) are the ranges (SPEC §8), the drill-downs follow.
    ws().open({ fn: "GP", ticker: "MSFT US EQUITY", args: [] });
    await executeCommand("7");
    expect(view()).toMatchObject({ fn: "GP", ticker: "MSFT US EQUITY", args: ["D", "1Y"] });
    await executeCommand("10");
    expect(view()).toMatchObject({ fn: "DES", ticker: "MSFT US EQUITY" });
  });

  it("98 opens the security's note, 99 the function's help", async () => {
    ws().open({ fn: "DES", ticker: "AAPL US EQUITY", args: [] });
    await executeCommand("98");
    expect(view()).toMatchObject({ fn: "NOTE", ticker: "AAPL US EQUITY" });
    ws().open({ fn: "GP", ticker: "AAPL US EQUITY", args: [] });
    await executeCommand("99");
    expect(view()).toMatchObject({ fn: "HELP", args: ["GP"] });
  });

  it("95–97 open the window's Actions, Export and Settings menus", async () => {
    ws().open({ fn: "GP", ticker: "AAPL US EQUITY", args: [] });
    const id = ws().activeId;
    for (const [n, kind] of [
      ["95", "actions"],
      ["96", "export"],
      ["97", "settings"],
    ] as const) {
      expect((await executeCommand(n)).ok).toBe(true);
      expect(usePopup.getState().popup).toEqual({ winId: id, kind });
    }
  });

  it("a number the window does not show is still an error", async () => {
    ws().open({ fn: "W", args: [] });
    const r = await executeCommand("7");
    expect(r).toMatchObject({ ok: false, error: "No item 7" });
  });
});
