import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { executeCommand } from "./executor";
import { helpSearch } from "./helpsearch";
import { windowItems } from "./items";
import { ACTIONS } from "./keys";
import { activeView, defaultSession } from "./layout/session";
import { useWorkspace } from "./layout/store";
import { getFunction, validateArgs } from "./registry";

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

describe("HELP: index items, Data sources, help search (SPEC §7, §4.4 F1)", () => {
  it("HELP SOURCES and HELP SEARCH <words> are valid HELP arguments", () => {
    const help = getFunction("HELP")!;
    expect(validateArgs(help, ["SOURCES"])).toBeNull();
    expect(validateArgs(help, ["SEARCH", "CHART"])).toBeNull();
  });

  it("the HELP index numbers its topics: 1) Data sources 2) Help search 3) Keys", () => {
    ws().open({ fn: "HELP", args: [] });
    const own = windowItems(ws().activeId).filter((i) => i.n < 95);
    expect(own.map((i) => `${i.n}) ${i.label}`)).toEqual([
      "1) Data sources",
      "2) Help search",
      "3) Keys",
    ]);
  });

  it("help search: every typed word in a function's help or a topic", () => {
    expect(helpSearch("chart").map((h) => h.label)).toContain("GP");
    expect(helpSearch("GP")[0]!.label).toBe("GP"); // exact mnemonic first
    // Notices are searchable too: FRED's not-endorsed notice lives on Data sources.
    expect(helpSearch("not endorsed").map((h) => h.label)).toContain("Data sources");
    expect(helpSearch("zzqx")).toEqual([]);
    expect(helpSearch("")).toEqual([]);
  });

  it("F1 opens HELP; F1 again (HELP on screen) opens help search", async () => {
    ACTIONS.help!();
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    expect(view()).toMatchObject({ fn: "HELP", args: [] });
    ACTIONS.help!();
    await new Promise((r) => setTimeout(r, 0));
    expect(view()).toMatchObject({ fn: "HELP", args: ["SEARCH"] });
  });

  it("HELP <sector> lists that sector's functions (the menu itself is MENU)", async () => {
    await executeCommand("HELP CURNCY");
    expect(view()).toMatchObject({ fn: "HELP", args: ["CURNCY"] });
  });
});
