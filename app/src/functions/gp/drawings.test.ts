import { describe, expect, it } from "vitest";
import {
  drawingsKey,
  fibPrices,
  logicalOf,
  MAX_DRAWINGS,
  parseDrawings,
  timeAtLogical,
} from "./drawings";

const D = 86400;
// Mon..Fri, then Mon: a weekend gap.
const days = [0, 1, 2, 3, 4, 7].map((d) => (20_000 + d) * D);

describe("GP drawings geometry", () => {
  it("a bar time is its index; between bars it interpolates", () => {
    expect(logicalOf(days, days[2]!)).toBe(2);
    expect(logicalOf(days, days[4]! + 1.5 * D)).toBeCloseTo(4.5); // inside the weekend gap
  });

  it("beyond the data it continues at the bar spacing, not the weekend gap", () => {
    expect(logicalOf(days, days[5]! + 2 * D)).toBeCloseTo(7);
    expect(logicalOf(days, days[0]! - D)).toBeCloseTo(-1);
  });

  it("time ↔ index round-trips anywhere", () => {
    for (const l of [-3, 0, 1.25, 4.5, 5, 9.5]) {
      expect(logicalOf(days, timeAtLogical(days, l)!)).toBeCloseTo(l);
    }
    expect(logicalOf([], 1)).toBeNull();
    expect(timeAtLogical([], 1)).toBeNull();
  });

  it("an anchor made on daily bars lands on the same instant among 5m bars", () => {
    const fiveMin = Array.from({ length: 10 }, (_, i) => days[1]! + 9.5 * 3600 + i * 300);
    expect(logicalOf(fiveMin, days[1]! + 9.5 * 3600 + 600)).toBe(2);
  });

  it("Fibonacci levels run from the second point (0) to the first (100%)", () => {
    const got = fibPrices({ t: 0, p: 200 }, { t: 1, p: 100 });
    [100, 123.6, 138.2, 150, 161.8, 178.6, 200].forEach((v, k) => expect(got[k]).toBeCloseTo(v));
  });
});

describe("GP drawings storage", () => {
  it("keeps valid drawings and drops anything malformed", () => {
    const a = { t: 1, p: 10 };
    const raw = {
      items: [
        { kind: "HLINE", a },
        { kind: "TREND", a, b: { t: 2, p: 11 } },
        { kind: "TREND", a }, // no second point
        { kind: "TEXT", a, text: "  breakout  " },
        { kind: "TEXT", a, text: "" },
        { kind: "CIRCLE", a },
        { kind: "RECT", a: { t: "x", p: 1 }, b: a },
        null,
      ],
    };
    expect(parseDrawings(raw)).toEqual([
      { kind: "HLINE", a },
      { kind: "TREND", a, b: { t: 2, p: 11 } },
      { kind: "TEXT", a, text: "breakout" },
    ]);
    expect(parseDrawings(null)).toEqual([]);
    const many = {
      items: Array.from({ length: 150 }, (_, i) => ({ kind: "HLINE", a: { t: i, p: 1 } })),
    };
    const kept = parseDrawings(many);
    expect(kept).toHaveLength(MAX_DRAWINGS);
    expect(kept[0]!.a.t).toBe(50); // the newest are kept
  });

  it("one setting per security", () => {
    expect(drawingsKey("aapl us equity")).toBe("gp-drawings.AAPL US EQUITY");
    expect(drawingsKey("BTC/USD")).toBe("gp-drawings.BTC_USD");
  });
});
