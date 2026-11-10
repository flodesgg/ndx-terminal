import { beforeAll, describe, expect, it } from "vitest";
import { functionEntries, lookupInfo } from "@/core/registry";
import { buildIndex } from "@/core/secindex";
import { complete, type CompleteContext } from "./autocomplete";

beforeAll(async () => {
  window.matchMedia ??= (() => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  })) as unknown as typeof window.matchMedia;
  const { registerAllFunctions } = await import("@/functions");
  registerAllFunctions();
});

// Test universe (labels for the test only).
const BASE: string[][] = [
  ["AAPL US EQUITY", "Apple Inc."],
  ["AAP US EQUITY", "Advance Auto Parts"],
  ["GPS US EQUITY", "Gap test"],
  ["NOVOB DC EQUITY", "Novo Nordisk B", "NOVO-B.CO"],
  ["BTCUSD CURNCY", "Bitcoin", "BTCUSDT"],
  ["SPX INDEX", "S&P 500", "^GSPC"],
  ["CL1 COMDTY", "WTI crude front month", "CL=F"],
];
const index = buildIndex({ complete: ["US"], fiat: ["EUR", "USD"], items: BASE });

const cx = (extra: Partial<CompleteContext> = {}): CompleteContext => ({
  lookup: lookupInfo,
  index,
  functions: functionEntries(),
  ...extra,
});
const labels = (text: string, extra?: Partial<CompleteContext>) =>
  complete(text, cx(extra)).map((c) => c.label);

describe("autocomplete (SPEC §4.7)", () => {
  it("exact mnemonic first, then exact ticker, then prefixes", () => {
    expect(labels("GP")[0]).toBe("GP");
    expect(labels("GP")).toContain("GPS US EQUITY");
    expect(labels("AAPL")[0]).toBe("AAPL US EQUITY");
    const aa = labels("AAP");
    expect(aa[0]).toBe("AAP US EQUITY"); // exact ticker beats the longer prefix
    expect(aa).toContain("AAPL US EQUITY");
  });

  it("recently used beats a plain prefix match, never an exact one", () => {
    expect(labels("AAP", { recent: ["AAPL US EQUITY"] }).slice(0, 2)).toEqual([
      "AAP US EQUITY",
      "AAPL US EQUITY",
    ]);
    expect(labels("A", { recent: ["AAPL US EQUITY"] })[0]).toBe("AAPL US EQUITY");
  });

  it("finds securities by provider symbol and by name, with a sector chip", () => {
    const novo = complete("novo nord", cx())[0]!;
    expect(novo).toMatchObject({ label: "NOVOB DC EQUITY", sector: "EQUITY", kind: "SECURITY" });
    expect(novo.desc).toContain("Novo Nordisk B · DC");
    expect(labels("NOVO-B")).toContain("NOVOB DC EQUITY");
    const btc = complete("BTC", cx()).find((c) => c.label === "BTCUSD CURNCY")!;
    expect(btc.desc).toContain("BTCUSDT (quoted in USDT)");
  });

  it("a sector key filters securities and functions to that sector", () => {
    const l = labels("C", { sector: "COMDTY" });
    expect(l).toContain("CL1 COMDTY");
    expect(l.every((x) => !x.endsWith("EQUITY"))).toBe(true);
    expect(l).not.toContain("CRYPTO"); // a CURNCY function
  });

  it("after a security: that sector's functions; after a function: its argument values", () => {
    const fns = labels("NOVOB DC EQUITY ");
    expect(fns).toContain("GP");
    expect(fns).toContain("DES");
    expect(fns).not.toContain("WEI"); // takes no security
    expect(labels("AAPL US EQUITY F")[0]).toBe("FA");
    expect(labels("AAPL US EQUITY GP 1")).toContain("1Y");
    expect(labels("AAPL US EQUITY FA ")).toContain("BALANCE");
  });

  it("sector tokens and aliases complete to the sector menu", () => {
    expect(complete("CCY", cx())[0]).toMatchObject({ kind: "SECTOR", label: "CURNCY" });
  });

  it("Cyrillic input shows its layout-fixed command first (§4.6)", () => {
    const rows = complete("ФФЗД ПЗ", cx());
    expect(rows[0]).toMatchObject({ kind: "FIXED", label: "AAPL US EQUITY GP" });
    expect(complete("нефть", cx()).every((r) => r.kind !== "FIXED")).toBe(true);
    // Letters outside both maps stay Cyrillic: no endless layout-fixing (review finding).
    for (const t of ["Ё", "ё", "ў", "қ", "ЁЁ ПЗ"]) expect(() => complete(t, cx())).not.toThrow();
  });

  it("PRIMARY marks only what the bare ticker opens (review 1a #18)", () => {
    const ix = buildIndex({
      complete: ["US"],
      fiat: [],
      items: [
        ["DAX INDEX", "DAX", "^GDAXI"],
        ["DAX US EQUITY", "DAX ETF test"],
        ["XYZ US EQUITY", "XYZ US"],
        ["XYZ GY EQUITY", "XYZ Germany"],
      ],
    });
    const rows = complete("DAX", cx({ index: ix })).filter((r) => r.kind === "SECURITY");
    expect(rows.length).toBe(2);
    expect(rows.every((r) => !r.primary)).toBe(true);
    const xyz = complete("XYZ", cx({ index: ix })).filter((r) => r.kind === "SECURITY");
    expect(xyz.find((r) => r.label === "XYZ US EQUITY")?.primary).toBe(true);
    expect(xyz.find((r) => r.label === "XYZ GY EQUITY")?.primary).toBe(false);
  });

  it("a valid command with Cyrillic free text gets no FIXED row (review 1a #11)", () => {
    const rows = complete("LAYOUT SAVE утро", cx());
    expect(rows.every((r) => r.kind !== "FIXED")).toBe(true);
    expect(rows.some((r) => r.label.includes("ENHJ"))).toBe(false);
  });

  it("Latin function + wrong-layout structured args runs the fixed form (re-verify R6)", () => {
    // After Tab-accepting a FIXED `W` the user keeps typing on the Russian layout.
    expect(complete("W фвв ффзд", cx())[0]).toMatchObject({ kind: "FIXED", label: "W ADD AAPL" });
    expect(complete("AAPL US EQUITY ALRT Ю200", cx())[0]).toMatchObject({
      kind: "FIXED",
      label: "AAPL US EQUITY ALRT >200",
    });
    expect(complete("HELP пз", cx())[0]).toMatchObject({ kind: "FIXED", label: "HELP GP" });
    // Free names and notes stay as typed: no FIXED row.
    for (const t of ["W NEW утро", "W утро", "AAPL US EQUITY ALRT >200 прорыв", "HELP утро"]) {
      expect(
        complete(t, cx()).every((r) => r.kind !== "FIXED"),
        t,
      ).toBe(true);
    }
  });

  it("name punctuation in the typed words still finds the security (re-verify R7)", () => {
    const ix = buildIndex({
      complete: ["US", "DC", "JT"],
      fiat: [],
      items: [
        ["AAPL US EQUITY", "Apple Inc."],
        ["7203 JT EQUITY", "Toyota Motor Corp."],
        ["MAERSKB DC EQUITY", "A.P. Moller - Maersk A/S B"],
        ["T US EQUITY", "AT&T Inc."],
      ],
    });
    const top = (q: string) =>
      complete(q, cx({ index: ix })).find((r) => r.kind === "SECURITY")?.label;
    expect(top("apple inc.")).toBe("AAPL US EQUITY");
    expect(top("toyota motor corp.")).toBe("7203 JT EQUITY");
    expect(top("maersk a.p.")).toBe("MAERSKB DC EQUITY");
    expect(top("moller a.p.")).toBe("MAERSKB DC EQUITY");
    expect(top("at&t inc")).toBe("T US EQUITY");
    expect(() => complete("a.p.", cx({ index: ix }))).not.toThrow();
  });

  it("saved layouts and notes are sources too", () => {
    const rows = complete("morn", cx({ layouts: ["morning"], notes: ["NOVOB DC EQUITY"] }));
    expect(rows.map((r) => r.label)).toContain("LAYOUT LOAD MORNING");
    expect(labels("novo", { notes: ["NOVOB DC EQUITY"] })).toContain("NOVOB DC EQUITY NOTE");
  });

  it("a common first word never hides a name match (review 1a #3)", () => {
    const items: string[][] = Array.from({ length: 450 }, (_, i) => [
      `ISF${i} US EQUITY`,
      `iShares Core Fund ${i} ETF`,
    ]);
    items.push(["IWM US EQUITY", "iShares Russell 2000 ETF"]);
    const ix = buildIndex({ complete: ["US"], fiat: [], items });
    expect(complete("ishares russell", cx({ index: ix }))[0]?.label).toBe("IWM US EQUITY");
    expect(complete("russell ishares", cx({ index: ix }))[0]?.label).toBe("IWM US EQUITY");
  });

  it("answers in < 30 ms over a 30,000-security index", () => {
    // Synthetic tickers sized like the real seeds (Nasdaq + SEC + Binance ≈ 25k).
    const big: string[][] = [...BASE];
    const L = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    for (let i = 0; i < 30_000; i++) {
      const t =
        L[i % 26]! + L[((i / 26) % 26) | 0]! + L[((i / 676) % 26) | 0]! + (i % 7 ? "" : "X");
      big.push([`${t}${i % 3 ? "" : i % 10} US EQUITY`, `Company ${t} Holdings ${i}`]);
    }
    const bigCx = cx({ index: buildIndex({ complete: ["US"], fiat: [], items: big }) });
    complete("A", bigCx); // warm-up: the loader builds the sorted arrays before swapping indexes
    const queries = ["A", "AA", "AAPL", "MSF", "COMP", "COMPANY ZQ", "ZZZZ", "QXR", "GP", "N"];
    const times: number[] = [];
    for (let r = 0; r < 5; r++) {
      for (const q of queries) {
        const t0 = performance.now();
        complete(q, bigCx);
        times.push(performance.now() - t0);
      }
    }
    times.sort((a, b) => a - b);
    expect(times[Math.floor(times.length * 0.95)]!).toBeLessThan(30);
    // …and the timed queries really search: a name match past thousands of same-word names.
    expect(complete("COMPANY ZQ", bigCx).length).toBeGreaterThan(0);
  });
});

describe("the “Search for '…'” row (SPEC §4.7)", () => {
  const last = (text: string, extra?: Partial<CompleteContext>) => complete(text, cx(extra)).at(-1);

  it("is always the last row for typed text, and runs SRCH with the text", () => {
    expect(last("apple")).toMatchObject({
      kind: "SEARCH",
      label: "Search for 'apple'",
      insert: "SRCH apple",
    });
    // Even when the other sources fill the list, the row keeps its slot.
    const rows = complete("A", cx(), 5);
    expect(rows).toHaveLength(5);
    expect(rows.at(-1)!.kind).toBe("SEARCH");
    // Text no source knows still offers the search.
    expect(complete("what moved spx today?", cx())).toEqual([
      expect.objectContaining({ kind: "SEARCH", insert: "SRCH what moved spx today?" }),
    ]);
  });

  it("keeps Cyrillic search text as typed (§4.6: searches still work)", () => {
    expect(last("новости нефть")).toMatchObject({
      kind: "SEARCH",
      insert: "SRCH новости нефть",
    });
  });

  it("is not offered for an empty line, a number, or while completing arguments", () => {
    expect(complete("", cx())).toEqual([]);
    expect(complete("42", cx()).some((r) => r.kind === "SEARCH")).toBe(false);
    expect(complete("GP 1", cx()).some((r) => r.kind === "SEARCH")).toBe(false);
  });
});
