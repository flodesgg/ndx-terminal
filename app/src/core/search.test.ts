import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { executeCommand } from "./executor";
import { activeView, defaultSession } from "./layout/session";
import { useWorkspace } from "./layout/store";
import { getFunction, validateArgs } from "./registry";
import { matchNews, matchNotes, searchFunctions, searchWords, searchSecurities } from "./search";
import { buildIndex } from "./secindex";

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

const index = buildIndex({
  complete: ["US"],
  fiat: ["EUR", "USD"],
  items: [
    ["AAPL US EQUITY", "Apple Inc."],
    ["NOVOB DC EQUITY", "Novo Nordisk B", "NOVO-B.CO"],
  ],
});

describe("SRCH: global search (SPEC §7, §4.3 search)", () => {
  it("text that is no command opens SRCH with it (no more “SRCH not built yet”)", async () => {
    const r = await executeCommand("what moved spx today?");
    expect(r.ok).toBe(true);
    expect(view()).toMatchObject({ fn: "SRCH", args: ["WHAT", "MOVED", "SPX", "TODAY?"] });
    await executeCommand("новости нефть");
    expect(view()).toMatchObject({ fn: "SRCH", args: ["НОВОСТИ", "НЕФТЬ"] });
  });

  it("SRCH takes any words; SRCH alone opens an empty search", () => {
    expect(validateArgs(getFunction("SRCH")!, ["NOVO", "NORDISK"])).toBeNull();
    expect(searchWords([])).toEqual([]);
    expect(searchWords(["Novo", "nordisk"])).toEqual(["NOVO", "NORDISK"]);
  });

  it("functions: every word in the mnemonic, title or description", () => {
    expect(searchFunctions(["CHART"]).map((f) => f.code)).toContain("GP");
    expect(searchFunctions(["GP"])[0]!.code).toBe("GP");
    expect(searchFunctions(["ZZQX"])).toEqual([]);
  });

  it("securities: by name and ticker from the local index", () => {
    expect(searchSecurities(["NOVO", "NORDISK"], index).map((s) => s.id)).toEqual([
      "NOVOB DC EQUITY",
    ]);
    expect(searchSecurities(["AAPL"], index)[0]!.id).toBe("AAPL US EQUITY");
  });

  it("notes and news: every word in the text, case-insensitive", () => {
    const notes = [
      { symbol: "NOVOB DC EQUITY", body: "Wegovy supply update", updated_at: null },
      { symbol: "AAPL US EQUITY", body: "services margin", updated_at: null },
    ];
    expect(matchNotes(["WEGOVY"], notes).map((n) => n.symbol)).toEqual(["NOVOB DC EQUITY"]);
    expect(matchNotes(["NOVOB"], notes)).toHaveLength(1); // the symbol counts too
    const news = [
      { headline: "Oil rises on supply cut", summary: null },
      { headline: "Stocks mixed", summary: "oil and gas lead" },
      { headline: "Bonds rally", summary: null },
    ];
    expect(matchNews(["OIL"], news).map((n) => n.headline)).toEqual([
      "Oil rises on supply cut",
      "Stocks mixed",
    ]);
    expect(matchNews(["НЕФТЬ"], news)).toEqual([]);
  });
});
