import { describe, expect, it } from "vitest";
import {
  DEFAULT_COLS,
  colLabel,
  displayRows,
  fieldValue,
  fmtField,
  groupRows,
  insertRows,
  MAX_COLS,
  monCsv,
  moveRow,
  parseAdd,
  parseCols,
  sortBy,
} from "./mon";

const rows = ["SPY", "#Tech", "MSFT", "AAPL", "#Banks", "JPM"];

describe("MON groups", () => {
  it("headers split the list; rows before the first header have no group", () => {
    expect(groupRows(rows)).toEqual([
      { header: null, symbols: ["SPY"] },
      { header: "Tech", symbols: ["MSFT", "AAPL"] },
      { header: "Banks", symbols: ["JPM"] },
    ]);
    expect(groupRows(["#A", "X"])).toEqual([{ header: "A", symbols: ["X"] }]);
    expect(groupRows([])).toEqual([]);
  });

  it("a sort orders symbols inside each group; headers stay put", () => {
    const px: Record<string, number> = { SPY: 600, MSFT: 500, AAPL: 250, JPM: 300 };
    const got = displayRows(
      rows,
      sortBy((s) => px[s] ?? null, false),
    ).map((r) => r.row);
    expect(got).toEqual(["SPY", "#Tech", "AAPL", "MSFT", "#Banks", "JPM"]);
    expect(displayRows(rows, null).map((r) => r.row)).toEqual(rows);
  });

  it("missing values sort last in either direction", () => {
    const v: Record<string, number | null> = { A: 1, B: null, C: 3 };
    const asc = ["B", "A", "C"].sort(sortBy((s) => v[s] ?? null, false));
    const desc = ["B", "A", "C"].sort(sortBy((s) => v[s] ?? null, true));
    expect(asc).toEqual(["A", "C", "B"]);
    expect(desc).toEqual(["C", "A", "B"]);
  });

  it("moving a row past a header moves it into the next group", () => {
    expect(moveRow(rows, "AAPL", 1)).toEqual(["SPY", "#Tech", "MSFT", "#Banks", "AAPL", "JPM"]);
    expect(moveRow(rows, "#Banks", -1)).toEqual(["SPY", "#Tech", "MSFT", "#Banks", "AAPL", "JPM"]);
    expect(moveRow(rows, "SPY", -1)).toBeNull();
    expect(moveRow(rows, "JPM", 1)).toBeNull();
  });
});

describe("MON add row", () => {
  it("symbols or a #group", () => {
    expect(parseAdd(" aapl, msft  nvda ")).toEqual({
      header: null,
      symbols: ["aapl", "msft", "nvda"],
    });
    expect(parseAdd("#  Big   banks ")).toEqual({ header: "Big banks", symbols: [] });
    expect(parseAdd("#")).toEqual({ header: null, symbols: [] });
  });

  it("inserts after the selected row, skipping rows already there", () => {
    expect(insertRows(rows, ["NVDA", "AAPL"], "MSFT")).toEqual([
      "SPY",
      "#Tech",
      "MSFT",
      "NVDA",
      "AAPL",
      "#Banks",
      "JPM",
    ]);
    expect(insertRows(rows, ["X"])).toEqual([...rows, "X"]);
  });
});

describe("MON columns", () => {
  const known = new Set([...DEFAULT_COLS, "pe_ttm", "sector"]);

  it("stored choice keeps known fields in order; nothing usable → the SPEC default", () => {
    expect(parseCols({ cols: ["pe_ttm", "px_last", "pe_ttm", "bogus", 3] }, known)).toEqual([
      "pe_ttm",
      "px_last",
    ]);
    expect(parseCols(null, known)).toEqual(DEFAULT_COLS);
    expect(parseCols({ cols: ["bogus"] }, known)).toEqual(DEFAULT_COLS);
    expect(
      parseCols({ cols: Array.from({ length: 30 }, () => "x").map((x, i) => x + i) }, null),
    ).toHaveLength(MAX_COLS);
  });

  it("values: quote fields from the quote, the rest from the profile; missing is N.A.", () => {
    const q = { price: 101.5, change: -1.25, change_pct: -1.217, volume: 1_234_567, name: "Apple" };
    const p = { pe_trailing: 31.234, sector: "Technology" };
    const last = { id: "px_last", domain: "quotes", attr: "price", kind: "price" } as const;
    const chg = { id: "chg_net_1d", domain: "quotes", attr: "change", kind: "change" } as const;
    const pe = {
      id: "pe_ttm",
      domain: "fundamentals",
      attr: "pe_trailing",
      kind: "ratio",
    } as const;
    const sector = { id: "sector", domain: "reference", attr: "sector", kind: "text" } as const;
    const quote = q as never;
    const prof = p as never;
    expect(fmtField(last, fieldValue(last, quote, prof), "AAPL US EQUITY")).toBe("101.50");
    expect(fmtField(chg, fieldValue(chg, quote, prof), "AAPL US EQUITY", 101.5)).toBe("−1.25");
    expect(fmtField(pe, fieldValue(pe, quote, prof), "AAPL US EQUITY")).toBe("31.23");
    expect(fmtField(sector, fieldValue(sector, quote, prof), "AAPL US EQUITY")).toBe("Technology");
    expect(fmtField(pe, fieldValue(pe, quote, null), "AAPL US EQUITY")).toBe("N.A.");
    expect(fmtField(sector, fieldValue(sector, null, { sector: " " } as never), "X")).toBe("N.A.");
  });

  it("name, currency, exchange: profile, else quote, else the security master", () => {
    const name = { id: "name", domain: "reference", attr: "name", kind: "text" } as const;
    const ccy = { id: "currency", domain: "reference", attr: "currency", kind: "text" } as const;
    const sector = { id: "sector", domain: "reference", attr: "sector", kind: "text" } as const;
    const master = { name: "Novo Nordisk B", currency: "DKK", exchange: "DC" };
    // A Finnhub-like quote has no name: the master states it.
    const bare = { price: 1, name: null } as never;
    expect(fieldValue(name, bare, null, master)).toBe("Novo Nordisk B");
    expect(fieldValue(ccy, null, null, master)).toBe("DKK");
    expect(fieldValue(name, { name: "Apple" } as never, null, master)).toBe("Apple");
    expect(fieldValue(name, null, { name: "Apple Inc" } as never, master)).toBe("Apple Inc");
    // Other reference fields never come from the master.
    expect(fieldValue(sector, null, null, { ...master, sector: "X" } as never)).toBeNull();
    expect(fieldValue(name, null, null, null)).toBeNull();
  });

  it("short headers for the common fields", () => {
    expect(colLabel({ id: "chg_pct_1d", name: "% change" })).toBe("CHG%");
    expect(colLabel({ id: "industry", name: "Industry" })).toBe("INDUSTRY");
  });
});

describe("MON CSV", () => {
  it("every row with its group; ASCII minus; quoting", () => {
    const csv = monCsv(["LAST", "NAME"], displayRows(rows, null), (s) =>
      s === "JPM" ? ["−3.00", "JPMorgan, Chase"] : ["1.00", s],
    );
    expect(csv.split("\n")).toEqual([
      "GROUP,TICKER,LAST,NAME",
      ",SPY,1.00,SPY",
      "Tech,MSFT,1.00,MSFT",
      "Tech,AAPL,1.00,AAPL",
      'Banks,JPM,-3.00,"JPMorgan, Chase"',
    ]);
  });
});
