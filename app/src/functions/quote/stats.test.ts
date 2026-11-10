import { describe, expect, it } from "vitest";
import {
  avgVolume,
  range52w,
  sessionDayOf,
  sessionVwap,
  volumeVsAvgPct,
  vwapForSession,
} from "./stats";

const D = 86400;
const bar = (t: number, c: number, v: number | null = 100, h = c, l = c) => ({ t, h, l, c, v });

describe("Q computed values", () => {
  it("VWAP weighs the typical price by volume over the last session only", () => {
    const d1 = 20_000 * D;
    const d2 = d1 + D;
    const bars = [
      bar(d1 + 3600, 50, 1000), // previous session: ignored
      bar(d2 + 3600, 10, 100, 11, 9), // typical 10
      bar(d2 + 3900, 20, 300, 21, 19), // typical 20
    ];
    expect(sessionVwap(bars)).toBeCloseTo((10 * 100 + 20 * 300) / 400);
  });

  it("a VWAP outside the quote's low–high is another session's: none", () => {
    expect(vwapForSession(231.5, 229, 233)).toBe(231.5);
    expect(vwapForSession(218.09, 228.23, 232.33)).toBeNull();
    expect(vwapForSession(231.5, null, 233)).toBe(231.5); // no range to check against
    expect(vwapForSession(null, 229, 233)).toBeNull();
  });

  it("VWAP is N.A. without traded volume (indices, FX)", () => {
    expect(sessionVwap([bar(D, 10, null), bar(D + 300, 11, 0)])).toBeNull();
    expect(sessionVwap([])).toBeNull();
  });

  it("the 30-day average leaves out the session in progress and needs 30 full sessions", () => {
    const daily = Array.from({ length: 31 }, (_, i) => bar((20_000 + i) * D, 1, i < 30 ? 100 : 5));
    expect(avgVolume(daily, 30, 20_030)).toBe(100);
    expect(avgVolume(daily.slice(1), 30, 20_030)).toBeNull(); // 29 full sessions
    const gap = daily.map((b, i) => (i === 3 ? { ...b, v: null } : b));
    expect(avgVolume(gap, 30, 20_030)).toBeNull();
    expect(sessionDayOf([bar(20_030 * D + 3600, 1)])).toBe(20_030);
    expect(sessionDayOf([])).toBeNull();
  });

  it("52-week range from a year of daily bars; N.A. on a short history", () => {
    const year = Array.from({ length: 365 }, (_, i) =>
      bar((20_000 + i) * D, 100, 1, 100 + (i % 7), 90 - (i % 5)),
    );
    expect(range52w(year)).toEqual({ low: 86, high: 106 });
    expect(range52w(year.slice(-100))).toBeNull();
    expect(range52w([])).toBeNull();
  });

  it("volume vs average as a percentage", () => {
    expect(volumeVsAvgPct(150, 100)).toBe(150);
    expect(volumeVsAvgPct(null, 100)).toBeNull();
    expect(volumeVsAvgPct(150, null)).toBeNull();
  });
});
