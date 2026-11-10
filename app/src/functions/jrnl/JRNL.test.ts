import { describe, expect, it } from "vitest";
import { toBody } from "./JRNL";

const f = {
  symbol: "AAPL",
  side: "LONG" as const,
  qty: "10",
  entry: "200",
  exit: "",
  opened: "",
  setup: "breakout",
  mistakes: "",
  thesis: "",
  review: "",
};

describe("JRNL form", () => {
  it("valid form → body; empty exit/opened are null", () => {
    expect(toBody(f)).toMatchObject({
      symbol: "AAPL",
      qty: 10,
      entry: 200,
      exit: null,
      opened: null,
    });
  });
  it("rejects missing symbol, bad size, bad prices, bad date", () => {
    expect(toBody({ ...f, symbol: " " })).toBe("symbol is required");
    expect(toBody({ ...f, qty: "-1" })).toMatch(/size/);
    expect(toBody({ ...f, entry: "x" })).toMatch(/entry/);
    expect(toBody({ ...f, exit: "0" })).toMatch(/exit/);
    expect(toBody({ ...f, opened: "10/02/2026" })).toMatch(/YYYY-MM-DD/);
  });
});
