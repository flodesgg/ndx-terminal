import { beforeAll, describe, expect, it } from "vitest";
import { parse } from "./command/parser";
import {
  allFunctions,
  getFunction,
  helpText,
  lookupInfo,
  numberedActions,
  validateArgs,
} from "./registry";
import { SECTOR_TOKENS } from "./sectors";

beforeAll(async () => {
  // Chart libraries probe matchMedia at import time; jsdom has none.
  window.matchMedia ??= (() => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  })) as unknown as typeof window.matchMedia;
  const { registerAllFunctions } = await import("@/functions");
  registerAllFunctions();
});

describe("function registry (SPEC §12)", () => {
  const fns = () => allFunctions(true);

  it("every function carries all §12 fields", () => {
    expect(fns().length).toBeGreaterThan(20);
    for (const d of fns()) {
      expect(d.code, d.code).toMatch(/^[A-Z]{1,8}$/);
      expect(d.name.length, `${d.code} title`).toBeGreaterThan(2);
      expect(d.description.length, `${d.code} help text`).toBeGreaterThan(8);
      expect(["required", "optional", "none"]).toContain(d.ticker);
      expect(d.syntax, `${d.code} syntax`).toContain(d.code);
      expect(d.menu.length, `${d.code} menu path`).toBeGreaterThan(0);
      for (const s of d.sectors) expect(SECTOR_TOKENS, d.code).toContain(s);
      expect(d.component ?? d.run, `${d.code} has neither a panel nor an action`).toBeDefined();
    }
  });

  it("a function that needs a security belongs to a security sector", () => {
    for (const d of fns().filter((f) => f.ticker === "required")) {
      expect(d.sectors.filter((s) => s !== "CLIENT").length, d.code).toBeGreaterThan(0);
    }
  });

  it("numbered actions are unique; 1–94 are the function's, 95–99 the title bar's", () => {
    for (const d of fns()) {
      for (const a of d.actions) expect(a.n, d.code).toBeGreaterThanOrEqual(1);
      for (const a of d.actions) expect(a.n, d.code).toBeLessThanOrEqual(94);
      const ns = numberedActions(d).map((a) => a.n);
      expect(new Set(ns).size, d.code).toBe(ns.length);
      expect(ns.slice(-5)).toEqual([95, 96, 97, 98, 99]);
    }
  });

  it("every example parses to its own function and passes arg validation", () => {
    for (const d of fns()) {
      for (const ex of d.examples) {
        const r = parse(ex, { lookup: lookupInfo });
        expect(r.kind, `${ex}: ${r.kind === "error" ? r.error : ""}`).toBe("function");
        if (r.kind !== "function") continue;
        expect(r.fn, ex).toBe(d.code);
        expect(validateArgs(d, r.args), ex).toBeNull();
      }
    }
  });

  it("invalid args give an inline error listing the allowed values (SPEC §4.3 #24)", () => {
    const gp = getFunction("GP")!;
    expect(validateArgs(gp, ["1Y", "rsi", "HL=101.5"])).toBeNull();
    const err = validateArgs(gp, ["7X"])!;
    expect(err).toContain('"7X" is not valid');
    expect(err).toContain("range: 1D 5D 1M 3M 6M YTD 1Y 5Y MAX 2Y 3Y 10Y");
    expect(err).toContain("HL=<price>");
    expect(validateArgs(getFunction("WEI")!, ["X"])).toBe('WEI takes no arguments ("X")');
    expect(validateArgs(getFunction("FA")!, ["Q"])).toBeNull();
    expect(validateArgs(getFunction("LOG")!, ["ALL"])).toContain("<lines>");
    expect(validateArgs(getFunction("W")!, ["ADD", "NVDA"])).toBeNull(); // free-form
  });

  it("the HELP page is generated from the registry", () => {
    const page = helpText(getFunction("GP")!).join("\n");
    expect(page).toContain("GP — Price chart");
    expect(page).toContain("Security:  required");
    expect(page).toContain("Sectors:   EQUITY INDEX COMDTY CURNCY");
    expect(page).toContain("Menu:      Market › Charts");
    expect(page).toContain("range");
    expect(page).toContain("99) Help");
    expect(page).toContain("NOVOB DC EQUITY GP 1Y");
  });
});

describe("window functions (SPEC §4.9, §14 1b)", () => {
  it.each(["LAYOUT", "LINK", "POP", "OFF"])(
    "%s is registered with a generated HELP page",
    (code) => {
      const def = getFunction(code);
      expect(def, code).toBeDefined();
      expect(def!.category).toBe("System");
      expect(def!.menu).toEqual(["Windows"]);
      const help = helpText(def!).join("\n");
      expect(help).toContain(`${code} — ${def!.name}`);
      expect(help).toContain(`Syntax:    ${def!.syntax}`);
    },
  );

  it("LINK takes exactly the §4.9 colours", () => {
    expect(getFunction("LINK")!.args[0]!.values).toEqual([
      "NONE",
      "RED",
      "GREEN",
      "BLUE",
      "YELLOW",
    ]);
    expect(parse("LINK RED", { lookup: lookupInfo }).kind).toBe("function");
    expect(parse("LINK PURPLE", { lookup: lookupInfo }).kind).toBe("error");
  });
});
