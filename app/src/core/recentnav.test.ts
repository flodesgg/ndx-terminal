import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { executeCommand } from "./executor";
import { menuFor, recentFunctionTarget, recentSecurityTarget } from "./recentnav";
import { defaultSession } from "./layout/session";
import { useWorkspace } from "./layout/store";
import { recentFunctions, rememberFunction } from "@/lib/recent";

beforeAll(async () => {
  window.matchMedia ??= (() => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  })) as unknown as typeof window.matchMedia;
  const { registerAllFunctions } = await import("@/functions");
  registerAllFunctions();
});

beforeEach(() => {
  localStorage.clear();
  useWorkspace.getState().loadSession(defaultSession());
});

describe("toolbar: Menu, recent securities ▾, recent functions ▾ (SPEC §4.1)", () => {
  it("remembers run functions, most recent first, without duplicates", async () => {
    rememberFunction("GP");
    rememberFunction("DES");
    rememberFunction("GP");
    expect(recentFunctions()).toEqual(["GP", "DES"]);
    await executeCommand("WEI");
    expect(recentFunctions()[0]).toBe("WEI");
  });

  it("a recent security loads in the window's function when it takes one, else its menu", () => {
    expect(
      recentSecurityTarget({ fn: "GP", ticker: "AAPL US EQUITY", args: ["1Y"] }, "NOVOB DC EQUITY"),
    ).toEqual({ fn: "GP", ticker: "NOVOB DC EQUITY", args: [] });
    expect(recentSecurityTarget({ fn: "WEI", args: [] }, "NOVOB DC EQUITY")).toEqual({
      fn: "MENU",
      ticker: "NOVOB DC EQUITY",
      args: [],
    });
  });

  it("a recent function runs on the window's security; without one it shows its help", () => {
    const gp = { fn: "GP", ticker: "AAPL US EQUITY", args: [] };
    expect(recentFunctionTarget(gp, "DES")).toEqual({
      fn: "DES",
      ticker: "AAPL US EQUITY",
      args: [],
    });
    expect(recentFunctionTarget(gp, "WEI")).toEqual({ fn: "WEI", args: [] });
    expect(recentFunctionTarget({ fn: "WEI", args: [] }, "DES")).toEqual({
      fn: "HELP",
      args: ["DES"],
    });
  });

  it("Menu: the security's menu, else the main menu", () => {
    expect(menuFor({ fn: "GP", ticker: "AAPL US EQUITY", args: [] })).toEqual({
      fn: "MENU",
      ticker: "AAPL US EQUITY",
      args: [],
    });
    expect(menuFor({ fn: "WEI", args: [] })).toEqual({ fn: "MENU", args: [] });
  });
});
