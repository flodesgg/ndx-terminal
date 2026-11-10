import { describe, expect, it } from "vitest";
import { DEFAULT_FILTERS, formatEqsArgs, parseAmount, parseEqsArgs } from "./args";

describe("EQS args", () => {
  it("parses amounts with suffixes", () => {
    expect(parseAmount("10B")).toBe(1e10);
    expect(parseAmount("2.5m")).toBe(2.5e6);
    expect(parseAmount("-3")).toBe(-3);
    expect(parseAmount("abc")).toBeNull();
  });
  it("parses filters from command args", () => {
    const f = parseEqsArgs([
      "REGION=DK",
      "SECTOR=HEALTHCARE",
      "MCAP>10B",
      "PE<25",
      "CHG<-2",
      "SORT=CHG",
      "ASC",
    ]);
    expect(f).toEqual({
      ...DEFAULT_FILTERS,
      region: "dk",
      sector: "Healthcare",
      mcapMin: 1e10,
      peMax: 25,
      chgMax: -2,
      sort: "chg",
      asc: true,
    });
    expect(parseEqsArgs(["SECTOR=FINANCIAL_SERVICES"]).sector).toBe("Financial Services");
    expect(parseEqsArgs(["REGION=ZZ"]).region).toBe("us");
  });
  it("round-trips", () => {
    const f = parseEqsArgs(["REGION=JP", "ALLCAP", "VOL>1M", "SORT=VOLUME"]);
    expect(parseEqsArgs(formatEqsArgs(f))).toEqual(f);
    expect(parseEqsArgs(formatEqsArgs(DEFAULT_FILTERS))).toEqual(DEFAULT_FILTERS);
  });
});
