import { describe, expect, it } from "vitest";
import {
  bucketFor,
  DEFAULT_GP,
  formatGpArgs,
  isDate,
  lookbackFor,
  NUMBERED_RANGES,
  parseGpArgs,
  rangeStart,
} from "./args";

describe("GP args", () => {
  it("defaults", () => {
    expect(parseGpArgs([])).toEqual(DEFAULT_GP);
  });
  it("parses timeframes and flags", () => {
    expect(parseGpArgs(["1H", "RSI", "SMA", "LOG", "NOVOL", "HL=180.5"])).toEqual({
      tf: "1h",
      type: "CANDLE",
      ind: ["SMA", "RSI"],
      log: true,
      vol: false,
      lines: [180.5],
      cmp: [],
      ev: ["E", "D", "S"],
    });
    expect(parseGpArgs(["5"]).tf).toBe("5m");
    expect(parseGpArgs(["1MO"]).tf).toBe("1mo");
    expect(parseGpArgs(["M"]).tf).toBe("1mo");
    expect(parseGpArgs(["W"]).tf).toBe("1wk");
  });
  it("round-trips through format", () => {
    const st = parseGpArgs(["4H", "MACD", "BB", "HL=42"]);
    expect(parseGpArgs(formatGpArgs(st))).toEqual(st);
    const d = parseGpArgs(["1MO"]);
    expect(parseGpArgs(formatGpArgs(d))).toEqual(d);
  });
});

describe("bucketFor", () => {
  const day = 86400 * 20000;
  const open = day + 9.5 * 3600; // 09:30 wall clock
  it("keeps hourly bars aligned to the session open", () => {
    expect(bucketFor(open, open + 59 * 60, "1h")).toBe(open);
    expect(bucketFor(open, open + 61 * 60, "1h")).toBe(open + 3600);
  });
  it("starts a new daily bar on a new date", () => {
    expect(bucketFor(day, day + 15 * 3600, "1d")).toBe(day);
    expect(bucketFor(day, day + 86400 + 100, "1d")).toBe(day + 86400);
  });
  it("ignores ticks older than the last bar", () => {
    expect(bucketFor(open, open - 10, "5m")).toBeNull();
  });
  it("weekly bars only update in place", () => {
    expect(bucketFor(day, day + 3 * 86400, "1wk")).toBe(day);
  });

  it("ranges (SPEC §4.3 `GP 1Y`) pick a window and, unless given, the bar size", () => {
    expect(parseGpArgs(["1Y"])).toMatchObject({ tf: "1d", range: "1Y" });
    expect(parseGpArgs(["10Y"])).toMatchObject({ tf: "1wk", range: "10Y" });
    expect(parseGpArgs(["1H", "5D"])).toMatchObject({ tf: "1h", range: "5D" });
    expect(parseGpArgs(["5D", "1H"])).toMatchObject({ tf: "1h", range: "5D" });
    expect(parseGpArgs(["1M"])).toMatchObject({ tf: "1h", range: "1M" }); // one month
    const st = parseGpArgs(["1Y", "RSI"]);
    expect(parseGpArgs(formatGpArgs(st))).toEqual(st);
    const now = Date.UTC(2026, 10, 9) / 1000;
    expect(rangeStart("1Y", now)).toBe(now - 365 * 86400);
    expect(rangeStart("YTD", now)).toBe(Date.UTC(2026, 0, 1) / 1000);
    expect(rangeStart("MAX", now)).toBeNull();
    expect(rangeStart("1D", now + 15 * 3600)).toBe(now); // the last bar's session day
  });
});

describe("GP to spec (SPEC §8): numbered ranges, custom dates, chart types, ATR", () => {
  it("ranges 1D 5D 1M 3M 6M YTD 1Y 5Y MAX are the numbered items, in order", () => {
    expect(NUMBERED_RANGES.map((r) => r.token)).toEqual([
      "1D",
      "5D",
      "1M",
      "3M",
      "6M",
      "YTD",
      "1Y",
      "5Y",
      "MAX",
    ]);
  });

  it("custom FROM/TO dates replace the range and round-trip", () => {
    const st = parseGpArgs(["1D", "1Y", "FROM=2025-03-01", "TO=2025-06-30"]);
    expect(st).toMatchObject({ from: "2025-03-01", to: "2025-06-30" });
    expect(st.range).toBeUndefined();
    expect(parseGpArgs(formatGpArgs(st))).toEqual(st);
    expect(parseGpArgs(["TO=2025-06-30"]).to).toBeUndefined(); // TO alone is no window
    expect(parseGpArgs(["FROM=2025-02-30"]).from).toBeUndefined(); // not a date
    expect(isDate("2025-02-28")).toBe(true);
    expect(isDate("2025-13-01")).toBe(false);
    expect(lookbackFor("2025-11-09", Date.UTC(2026, 10, 9))).toBe(372);
  });

  it("chart types candles, OHLC, line, area", () => {
    expect(parseGpArgs([]).type).toBe("CANDLE");
    for (const t of ["OHLC", "LINE", "AREA"] as const) {
      const st = parseGpArgs([t]);
      expect(st.type).toBe(t);
      expect(parseGpArgs(formatGpArgs(st))).toEqual(st);
    }
    expect(formatGpArgs(parseGpArgs([]))).not.toContain("CANDLE");
  });

  it("event markers E/D/S: all by default, EV= picks, EV=NONE hides", () => {
    expect(parseGpArgs([]).ev).toEqual(["E", "D", "S"]);
    expect(parseGpArgs(["EV=SE"]).ev).toEqual(["E", "S"]);
    expect(parseGpArgs(["EV=NONE"]).ev).toEqual([]);
    for (const ev of [[], ["D"], ["E", "D", "S"]] as const) {
      const st = { ...parseGpArgs([]), ev: [...ev] };
      expect(parseGpArgs(formatGpArgs(st))).toEqual(st);
    }
    expect(formatGpArgs(parseGpArgs([])).some((a) => a.startsWith("EV="))).toBe(false);
  });

  it("ATR is a study", () => {
    expect(parseGpArgs(["ATR", "RSI"]).ind).toEqual(["RSI", "ATR"]);
  });
});
