import { describe, expect, it } from "vitest";
import { corrColor } from "../corr/CORR";
import { parseTradeArgs } from "./PORT";

describe("PORT trade args", () => {
  it("parses buy/sell with optional price", () => {
    expect(parseTradeArgs(["BUY", "AAPL", "10"])).toEqual({
      side: "BUY",
      symbol: "AAPL",
      qty: 10,
      price: null,
    });
    expect(parseTradeArgs(["SELL", "BTCUSDT", "0.05", "@65000"])).toEqual({
      side: "SELL",
      symbol: "BTCUSDT",
      qty: 0.05,
      price: 65000,
    });
  });
  it("rejects malformed input", () => {
    expect(parseTradeArgs(["BUY", "AAPL"])).toBeNull();
    expect(parseTradeArgs(["BUY", "AAPL", "-1"])).toBeNull();
    expect(parseTradeArgs(["BUY", "AAPL", "1", "180"])).toBeNull();
    expect(parseTradeArgs(["HOLD", "AAPL", "1"])).toBeNull();
  });
});

describe("CORR colours", () => {
  it("maps sign to hue and magnitude to opacity", () => {
    expect(corrColor(1)).toContain("0,210,106"); // token up
    expect(corrColor(-0.5)).toContain("255,59,59"); // token down
    expect(corrColor(null)).toBe("transparent");
  });
});
