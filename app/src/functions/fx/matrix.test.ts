import { describe, expect, it } from "vitest";
import { cross, type UsdRate } from "./matrix";

const rates = new Map<string, UsdRate>([
  ["EUR", { last: 0.9, prev: 0.9 }],
  ["DKK", { last: 6.714, prev: 6.6 }],
  ["JPY", { last: 150, prev: 150 }],
  ["UAH", { last: null, prev: null }],
]);

describe("FX cross rates", () => {
  it("derives crosses from USD pairs", () => {
    expect(cross("USD", "EUR", rates).rate).toBeCloseTo(0.9);
    expect(cross("EUR", "USD", rates).rate).toBeCloseTo(1 / 0.9);
    expect(cross("EUR", "DKK", rates).rate).toBeCloseTo(6.714 / 0.9);
    expect(cross("EUR", "JPY", rates).rate).toBeCloseTo(150 / 0.9);
  });
  it("computes change vs previous close", () => {
    const c = cross("USD", "DKK", rates);
    expect(c.changePct).toBeCloseTo((6.714 / 6.6 - 1) * 100);
  });
  it("never invents missing data", () => {
    expect(cross("USD", "UAH", rates)).toEqual({ rate: null, changePct: null });
    expect(cross("EUR", "EUR", rates)).toEqual({ rate: null, changePct: null });
  });
});
