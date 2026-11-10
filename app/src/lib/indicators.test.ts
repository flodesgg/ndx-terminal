import { describe, expect, it } from "vitest";
import { atr, bollinger, ema, macd, rsi, sma, vwap } from "./indicators";

// Reference values computed independently (pandas: rolling mean, ewm(adjust=False) seeded by
// SMA, Wilder RSI) for this classic RSI example series.
const CLOSES = [
  44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.1, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28,
  46.28, 46.0, 46.03, 46.41, 46.22, 45.64,
];

describe("indicators", () => {
  it("SMA", () => {
    const s = sma([1, 2, 3, 4, 5], 3);
    expect(s).toEqual([null, null, 2, 3, 4]);
  });

  it("EMA seeded by SMA", () => {
    const e = ema([1, 2, 3, 4, 5, 6], 3);
    expect(e[2]).toBeCloseTo(2);
    expect(e[3]).toBeCloseTo(3);
    expect(e[5]).toBeCloseTo(5);
    expect(e[1]).toBeNull();
  });

  it("RSI (Wilder) matches the textbook example", () => {
    const r = rsi(CLOSES, 14);
    expect(r[13]).toBeNull();
    expect(r[14]).toBeCloseTo(70.464, 2);
    expect(r[15]).toBeCloseTo(66.249, 2);
    expect(r[19]).toBeCloseTo(57.915, 2);
  });

  it("MACD signal starts after the slow EMA warms up", () => {
    const xs = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 5) * 5 + i * 0.1);
    const m = macd(xs);
    expect(m.macd[24]).toBeNull();
    expect(m.macd[25]).not.toBeNull();
    expect(m.signal[25 + 7]).toBeNull();
    expect(m.signal[25 + 8]).not.toBeNull();
    const i = 50;
    expect(m.hist[i]).toBeCloseTo(m.macd[i]! - m.signal[i]!);
  });

  it("Bollinger bands are symmetric around the SMA", () => {
    const b = bollinger([2, 4, 4, 4, 5, 5, 7, 9], 8, 2);
    expect(b.mid[7]).toBeCloseTo(5);
    expect(b.upper[7]).toBeCloseTo(9); // population sd = 2
    expect(b.lower[7]).toBeCloseTo(1);
  });

  it("VWAP resets each day", () => {
    const day = 86400;
    const bars = [
      { t: day + 100, o: 10, h: 10, l: 10, c: 10, v: 1 },
      { t: day + 200, o: 20, h: 20, l: 20, c: 20, v: 3 },
      { t: 2 * day + 100, o: 5, h: 5, l: 5, c: 5, v: 2 },
    ];
    const v = vwap(bars);
    expect(v[1]).toBeCloseTo(17.5);
    expect(v[2]).toBeCloseTo(5);
  });

  it("ATR (Wilder) against hand-computed reference values", () => {
    // TR: 2 (H−L), max(3, |12−9|=3, |9−9|=0)=3, max(2, |11−11|=0, |9−11|=2)=2, max(4, |14−10|=4, 0)=4
    const bars = [
      { h: 10, l: 8, c: 9 },
      { h: 12, l: 9, c: 11 },
      { h: 11, l: 9, c: 10 },
      { h: 14, l: 10, c: 13 },
    ];
    const a = atr(bars, 3);
    expect(a[0]).toBeNull();
    expect(a[1]).toBeNull();
    expect(a[2]).toBeCloseTo((2 + 3 + 2) / 3); // 2.3333
    expect(a[3]).toBeCloseTo(((7 / 3) * 2 + 4) / 3); // 2.8889
  });
});
