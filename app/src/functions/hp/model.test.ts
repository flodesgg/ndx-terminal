import { describe, expect, it } from "vitest";
import { DEFAULT_HP, formatHpArgs, hpLookback, hpRows, hpSummary, parseHpArgs } from "./model";

const D = 86400;
const t0 = Date.UTC(2026, 9, 1) / 1000; // 2026-10-01
const bar = (i: number, c: number, v: number | null = 1000) => ({
  t: t0 + i * D,
  o: c,
  h: c + 1,
  l: c - 1,
  c,
  v,
});

describe("HP args", () => {
  it("periodicity D/W/M, a window, custom dates; round-trips", () => {
    expect(parseHpArgs([])).toEqual(DEFAULT_HP);
    expect(parseHpArgs(["W", "1Y"])).toEqual({ per: "W", range: "1Y" });
    const custom = parseHpArgs(["M", "FROM=2020-01-01", "TO=2024-12-31", "3M"]);
    expect(custom).toEqual({ per: "M", from: "2020-01-01", to: "2024-12-31" });
    for (const st of [DEFAULT_HP, custom, parseHpArgs(["W", "MAX"])])
      expect(parseHpArgs(formatHpArgs(st))).toEqual(st);
  });

  it("asks for the window plus the bar before it", () => {
    const now = Date.UTC(2026, 10, 9);
    expect(hpLookback({ per: "D", range: "1M" }, now)).toBe(41);
    expect(hpLookback({ per: "D", range: "YTD" }, now)).toBe(312 + 10);
    expect(hpLookback({ per: "W", from: "2026-11-02" }, now)).toBe(7 + 21);
  });
});

describe("HP rows and summary", () => {
  const bars = [bar(0, 100), bar(1, 102), bar(2, 101), bar(3, 105, null), bar(4, 104)];

  it("newest first; change against the bar before, including the first in the window", () => {
    const rows = hpRows(bars, { per: "D", from: "2026-10-02", to: "2026-10-04" });
    expect(rows.map((r) => r.bar.c)).toEqual([105, 101, 102]);
    expect(rows[2]!.chg).toBe(2); // 102 vs the 100 before the window
    expect(rows[1]!.pct).toBeCloseTo((101 / 102 - 1) * 100);
  });

  it("the first bar loaded has no change: N.A., not 0", () => {
    const rows = hpRows(bars, { per: "D", range: "MAX" });
    expect(rows[rows.length - 1]!.chg).toBeNull();
    expect(hpSummary(rows).chg).toBeNull();
  });

  it("high, low with their dates; average close; change; average volume of bars that have it", () => {
    const s = hpSummary(hpRows(bars, { per: "D", from: "2026-10-02" }));
    expect(s.n).toBe(4);
    expect(s.high).toEqual({ v: 106, t: t0 + 3 * D });
    expect(s.low).toEqual({ v: 100, t: t0 + 2 * D });
    expect(s.avgClose).toBeCloseTo(103);
    expect(s.chg).toBe(4); // 104 vs 100
    expect(s.avgVolume).toBe(1000); // the bar without volume is left out
    const idx = hpSummary(
      hpRows(
        bars.map((b) => ({ ...b, v: null })),
        { per: "D" },
      ),
    );
    expect(idx.avgVolume).toBeNull();
  });
});
