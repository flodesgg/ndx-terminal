import { describe, expect, it } from "vitest";
import { describeAlert, parseCondition } from "./ALRT";

describe("ALRT conditions", () => {
  it("parses price and percent conditions", () => {
    expect(parseCondition(">200")).toEqual({ kind: "above", threshold: 200 });
    expect(parseCondition("<180.5")).toEqual({ kind: "below", threshold: 180.5 });
    expect(parseCondition("%>5")).toEqual({ kind: "pct_above", threshold: 5 });
    expect(parseCondition("%<-3")).toEqual({ kind: "pct_below", threshold: -3 });
  });
  it("rejects nonsense and non-positive prices", () => {
    expect(parseCondition("200")).toBeNull();
    expect(parseCondition("<-5")).toBeNull();
    expect(parseCondition(">abc")).toBeNull();
  });
  it("describes alerts", () => {
    expect(describeAlert({ symbol: "AAPL", kind: "pct_above", threshold: 5 })).toBe(
      "AAPL day change ≥ +5.00%",
    );
  });
  it("formats thresholds through the shared formatters (review 1a #32)", () => {
    expect(describeAlert({ symbol: "AAPL US EQUITY", kind: "pct_below", threshold: -3 })).toBe(
      "AAPL US EQUITY day change ≤ −3.00%",
    );
    expect(describeAlert({ symbol: "BTCUSDT", kind: "above", threshold: 104250 })).toBe(
      "BTCUSDT ≥ 104,250.00",
    );
    expect(describeAlert({ symbol: "EURUSD CURNCY", kind: "below", threshold: 1.1 })).toBe(
      "EURUSD CURNCY ≤ 1.1000",
    );
  });
});
