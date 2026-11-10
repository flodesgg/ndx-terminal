import { describe, expect, it } from "vitest";
import type { Schemas } from "@/core/api";
import { filterFields } from "./fields";

type F = Schemas["FieldInfo"];
const f = (id: string, name: string, domain: F["domain"], sources: string[] = []): F => ({
  id,
  name,
  definition: `${name} definition`,
  domain,
  kind: "price",
  attr: id,
  sources,
});
const ROWS = [
  f("px_last", "Last price", "quotes", ["Finnhub"]),
  f("pe_ttm", "P/E (TTM)", "fundamentals"),
  f("vwap", "VWAP", "quotes"),
];

describe("filterFields", () => {
  it("returns everything for no words", () => {
    expect(filterFields(ROWS, []).map((r) => r.id)).toEqual(["px_last", "pe_ttm", "vwap"]);
  });
  it("matches id, name, definition, domain and sources, case-insensitively, all words", () => {
    expect(filterFields(ROWS, ["PX"]).map((r) => r.id)).toEqual(["px_last"]);
    expect(filterFields(ROWS, ["fundamentals"]).map((r) => r.id)).toEqual(["pe_ttm"]);
    expect(filterFields(ROWS, ["finnhub"]).map((r) => r.id)).toEqual(["px_last"]);
    expect(filterFields(ROWS, ["quotes", "vwap"]).map((r) => r.id)).toEqual(["vwap"]);
    expect(filterFields(ROWS, ["nothing"])).toEqual([]);
  });
});
