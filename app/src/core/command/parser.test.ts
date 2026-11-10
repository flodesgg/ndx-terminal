import { beforeAll, describe, expect, it } from "vitest";
import { lookupInfo } from "@/core/registry";
import { buildIndex, EMPTY_INDEX } from "@/core/secindex";
import { fuzzyRank, fuzzyScore } from "./fuzzy";
import { parse, type ParseContext, type Parsed } from "./parser";

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

/** Test universe (names are labels for the test only). US, crypto and futures lists complete. */
const INDEX = buildIndex({
  complete: ["US", "CRYPTO", "COMDTY", "GOVT"],
  fiat: ["EUR", "USD", "DKK", "JPY", "GBP"],
  items: [
    ["AAPL US EQUITY", "Apple"],
    ["N US EQUITY", "N test"],
    ["GP US EQUITY", "GP test"],
    ["ZZZ US EQUITY", "ZZZ test"],
    ["NOVOB DC EQUITY", "Novo Nordisk B", "NOVO-B.CO"],
    ["XYZ GY EQUITY", "XYZ Germany"],
    ["XYZ LN EQUITY", "XYZ London"],
    ["BTCUSD CURNCY", "Bitcoin", "BTCUSDT"],
    ["CL1 COMDTY", "WTI crude front month", "CL=F"],
    ["SPX INDEX", "S&P 500", "^GSPC"],
    ["DAX INDEX", "DAX", "^GDAXI"],
    ["DAX US EQUITY", "DAX ETF test"],
    ["US10Y GOVT", "US 10-year yield", "US10Y"],
  ],
});

// MEMB arrives in phase 3; the grammar must already route it.
const lookup: ParseContext["lookup"] = (c) =>
  c === "MEMB" ? { code: "MEMB", ticker: "required" } : lookupInfo(c);
const base: ParseContext = { lookup, index: INDEX };
const loaded: ParseContext = { ...base, loaded: "AAPL US EQUITY" };

const fn = (f: string, security?: string, args: string[] = []): Parsed => ({
  kind: "function",
  fn: f,
  security,
  args,
});
const DES_AAPL = fn("DES", "AAPL US EQUITY");

type Row = [num: number, input: string, ctx: ParseContext, expected: Partial<Parsed>];

/** SPEC §4.3 parser test table, all 25 rows. */
const TABLE: Row[] = [
  [1, "AAPL US EQUITY DES", base, DES_AAPL],
  [2, "aapl us equity des", base, DES_AAPL],
  [3, "AAPL US EQUITY", base, { kind: "security", security: "AAPL US EQUITY", sector: "EQUITY" }],
  [4, "GP", loaded, fn("GP", "AAPL US EQUITY")],
  [5, "GP", base, { kind: "error", error: "GP needs a security" }],
  [6, "AAPL GP", base, fn("GP", "AAPL US EQUITY")],
  [7, "AAPL US DES", base, DES_AAPL],
  [8, "AAPL EQ DES", base, DES_AAPL],
  [9, "NOVOB DC EQUITY GP 1Y", base, fn("GP", "NOVOB DC EQUITY", ["1Y"])],
  [10, "EURUSD CURNCY GP", base, fn("GP", "EURUSD CURNCY")],
  [11, "BTCUSD CURNCY", base, { kind: "security", security: "BTCUSD CURNCY", sector: "CURNCY" }],
  [12, "CL1 COMDTY GP", base, fn("GP", "CL1 COMDTY")],
  [13, "SPX INDEX MEMB", base, fn("MEMB", "SPX INDEX")],
  [14, "US10Y GOVT GP", base, fn("GP", "US10Y GOVT")],
  [15, "CURNCY", base, { kind: "sector", sector: "CURNCY" }],
  [16, "WEI", base, fn("WEI")],
  [17, "3", { ...base, hasItem: (n) => n === 3 }, { kind: "number", n: 3 }],
  [18, "N", base, fn("N")],
  [19, "N US EQUITY", base, { kind: "security", security: "N US EQUITY", sector: "EQUITY" }],
  [20, "GP US EQUITY GP", base, fn("GP", "GP US EQUITY")],
  [21, "ФФЗД ГЫ УЙГШЕН ВУЫ", base, { ...DES_AAPL, fixed: "AAPL US EQUITY DES" }],
  [22, "новости нефть", base, { kind: "search", text: "новости нефть" }],
  [23, "ZZZZ US EQUITY", base, { kind: "error", error: "Unknown security ZZZZ US EQUITY" }],
  [24, "GP 7X", loaded, { kind: "error" }],
  [25, "what moved spx today?", base, { kind: "search", text: "what moved spx today?" }],
];

describe("SPEC §4.3 parser table", () => {
  it.each(TABLE)("#%i %s", (_n, input, ctx, expected) => {
    expect(parse(input, ctx)).toMatchObject(expected);
  });

  it("#5 comes with a hint, #23 with suggestions, #24 lists the valid ranges", () => {
    const r5 = parse("GP", base);
    expect(r5.kind === "error" && r5.hint).toContain("AAPL US EQUITY GP");
    const r23 = parse("ZZZZ US EQUITY", base);
    expect(r23.kind === "error" && r23.suggestions).toContain("ZZZ US EQUITY");
    const r24 = parse("GP 7X", loaded);
    expect(r24.kind === "error" && r24.error).toContain('"7X" is not valid');
    expect(r24.kind === "error" && r24.error).toContain(
      "range: 1D 5D 1M 3M 6M YTD 1Y 5Y MAX 2Y 3Y 10Y",
    );
  });

  it("#11 the crypto pair keeps its USDT provider pair for labelling", () => {
    expect(INDEX.byId.get("BTCUSD CURNCY")?.aliases).toEqual(["BTCUSDT"]);
  });

  it("#17 without that item on screen", () => {
    expect(parse("3", base)).toEqual({ kind: "error", error: "No item 3" });
  });
});

describe("parser: beyond the table", () => {
  it("scenario step 5: Russian layout → chart of Novo", () => {
    expect(parse("ТЩМЩИ ВС УЙГШЕН ПЗ", base)).toMatchObject({
      ...fn("GP", "NOVOB DC EQUITY"),
      fixed: "NOVOB DC EQUITY GP",
    });
    expect(parse("пз", loaded)).toMatchObject({ ...fn("GP", "AAPL US EQUITY"), fixed: "GP" });
    // Lower case on punctuation keys: ю is `.` (upper-case Ю would be `>`), so the command line
    // must hand the parser the text as typed.
    expect(parse("тщмщ-июсщ пз", base)).toMatchObject({ kind: "function", fn: "GP" });
  });

  it("a Cyrillic word is never a guessed ticker, even with no index", () => {
    expect(parse("нефть", base)).toEqual({ kind: "search", text: "нефть" });
    expect(parse("нефть", { lookup })).toEqual({ kind: "search", text: "нефть" });
    expect(parse("ффзд", base)).toMatchObject({ kind: "security", security: "AAPL US EQUITY" });
  });

  it("function names beat tickers; two-token X SECTOR stays a function arg", () => {
    expect(parse("W GP", base)).toEqual(fn("W", undefined, ["GP"]));
    expect(parse("HELP CURNCY", base)).toEqual(fn("HELP", undefined, ["CURNCY"]));
    expect(parse("LAYOUT SAVE morning", base)).toEqual(
      fn("LAYOUT", undefined, ["SAVE", "MORNING"]),
    );
    expect(parse("W NO", base)).toEqual(fn("W", undefined, ["NO"]));
  });

  it("provider symbols resolve to canonical IDs; unmappable ones pass through", () => {
    expect(parse("NOVO-B.CO GP", base)).toEqual(fn("GP", "NOVOB DC EQUITY"));
    expect(parse("BTCUSDT Q", base)).toEqual(fn("Q", "BTCUSD CURNCY"));
    expect(parse("EURUSD GP", base)).toEqual(fn("GP", "EURUSD CURNCY"));
    expect(parse("^GSPC GP W LOG", base)).toEqual(fn("GP", "SPX INDEX", ["W", "LOG"]));
    expect(parse("ENI.MI GP", base)).toEqual(fn("GP", "ENI.MI"));
  });

  it("primary listing: US first, else the default exchange, else a picker", () => {
    const amb = parse("XYZ GP", base);
    expect(amb).toMatchObject({ kind: "error", suggestions: ["XYZ GY EQUITY", "XYZ LN EQUITY"] });
    expect(parse("XYZ GP", { ...base, defaultExchange: "GY" })).toEqual(fn("GP", "XYZ GY EQUITY"));
    // US-first applies among equities; the same code in another sector is the user's pick.
    expect(parse("DAX GP", base)).toMatchObject({
      kind: "error",
      suggestions: ["DAX INDEX", "DAX US EQUITY"],
    });
  });

  it("without the US list (seeds not downloaded yet) a bare ticker is passed on as typed", () => {
    expect(parse("TSLA GP", { lookup, index: EMPTY_INDEX })).toEqual(fn("GP", "TSLA"));
    expect(parse("TSLA GP", base)).toMatchObject({ kind: "error", error: "Unknown security TSLA" });
    expect(parse("TSLA", base)).toEqual({ kind: "search", text: "TSLA" }); // rule 3
  });

  it("rejects what is not a command", () => {
    expect(parse("   ", base)).toEqual({ kind: "error", error: "Empty command" });
    expect(parse("AAPL XYZ", base)).toEqual({ kind: "search", text: "AAPL XYZ" });
    expect(parse("AAPL WEI", base)).toMatchObject({ kind: "error" });
    expect(parse("$$$", base)).toEqual({ kind: "search", text: "$$$" });
    expect(parse("AAPL US EQUITY FOO", base)).toMatchObject({ error: "Unknown function FOO" });
  });
});

describe("fuzzy", () => {
  it("ranks exact and prefix matches first", () => {
    expect(fuzzyScore("GP", "GP")).toBeGreaterThan(fuzzyScore("GP", "GPX")!);
    expect(fuzzyScore("xyz", "GP")).toBeNull();
    const items = [
      { key: "WEI", fields: ["WEI", "World equity indices"] },
      { key: "W", fields: ["W", "Watchlists"] },
      { key: "N", fields: ["N", "News"] },
    ];
    expect(
      fuzzyRank("W", items)
        .map((i) => i.key)
        .slice(0, 2),
    ).toEqual(["W", "WEI"]);
    expect(fuzzyRank("news", items).map((i) => i.key)).toEqual(["N"]);
  });
});

describe("Cyrillic in a valid command and Cyrillic searches (review 1a #11/#12)", () => {
  it.each([
    ["AAPL US EQUITY ALRT <100 падение", "ALRT", ["<100", "ПАДЕНИЕ"]],
    ["LAYOUT SAVE утро", "LAYOUT", ["SAVE", "УТРО"]],
    ["W NEW дивиденды", "W", ["NEW", "ДИВИДЕНДЫ"]],
  ])("%s keeps its Cyrillic text", (input, f, args) => {
    const p = parse(input, base);
    expect(p).toMatchObject({ kind: "function", fn: f, args });
    expect(p).not.toHaveProperty("fixed");
  });

  it.each([
    ["W фвв ффзд", "W", ["ADD", "AAPL"]],
    ["W ADD ффзд", "W", ["ADD", "AAPL"]],
    ["AAPL US EQUITY ALRT Ю200", "ALRT", [">200"]],
    ["HELP пз", "HELP", ["GP"]],
  ])("%s: wrong-layout structured args run fixed (re-verify R6)", (input, f, args) => {
    expect(parse(input, base)).toMatchObject({ kind: "function", fn: f, args });
    expect(parse(input, base)).toHaveProperty("fixed");
  });

  it.each([
    ["AAPL US EQUITY ALRT Ю200 прорыв", "ALRT", [">200", "ПРОРЫВ"]],
    ["W туц утро", "W", ["NEW", "УТРО"]],
    ["W фвв ффзд", "W", ["ADD", "AAPL"]],
  ])("%s: only the structured args are fixed, free text stays (re-verify N6)", (input, f, args) => {
    const p = parse(input, base);
    expect(p).toMatchObject({ kind: "function", fn: f, args });
    expect((p as { fixed?: string }).fixed?.endsWith(args.join(" "))).toBe(true);
  });

  it("a Latin ticker with a wrong-layout function still runs the fixed command", () => {
    expect(parse("AAPL ПЗ", base)).toMatchObject({
      ...fn("GP", "AAPL US EQUITY"),
      fixed: "AAPL GP",
    });
    expect(parse("AAPL US EQUITY ПЗ", base)).toMatchObject(fn("GP", "AAPL US EQUITY"));
  });

  it.each(["цены дт", "новости пн", "акции вс", "цены дт сегодня", "нефть вс 2024"])(
    "%s goes to search, not a made-up security",
    (input) => {
      expect(parse(input, base)).toEqual({ kind: "search", text: input });
    },
  );

  it("a sector chip next to a Cyrillic exchange still runs the command (review 1a #17)", () => {
    expect(parse("ффзд гы EQUITY вуы", base)).toMatchObject(DES_AAPL);
  });

  it("a wrong-layout exchange form of a listed security still resolves", () => {
    expect(parse("ТЩМЩИ ВС ПЗ", base)).toMatchObject(fn("GP", "NOVOB DC EQUITY"));
    expect(parse("ТЩМЩИ ВС УЙГШЕН ПЗ", base)).toMatchObject(fn("GP", "NOVOB DC EQUITY"));
  });
});

describe("TICKER EXCH SECTOR with a non-equity sector (review 1a #40)", () => {
  it("SPX US INDEX opens SPX INDEX", () => {
    expect(parse("SPX US INDEX", base)).toMatchObject({ kind: "security", security: "SPX INDEX" });
    expect(parse("SPX US INDEX GP", base)).toMatchObject(fn("GP", "SPX INDEX"));
  });
});

describe("functions cut from scope (not built)", () => {
  const nb: ParseContext = { ...base, notBuilt: (c) => c === "IMAP" || c === "RV" };
  it("a lone catalogue code says it is not built instead of searching", () => {
    expect(parse("IMAP", nb)).toMatchObject({
      kind: "error",
      error: "IMAP is not built in this version",
    });
    expect(parse("IMAP", base)).toMatchObject({ kind: "search" });
  });
  it("after a security too", () => {
    expect(parse("AAPL US EQUITY RV", nb)).toMatchObject({
      error: "RV is not built in this version",
    });
  });
  it("a real security wins over a not-built code", () => {
    expect(parse("AAPL", { ...nb, notBuilt: () => true })).toMatchObject({ kind: "security" });
  });
});
