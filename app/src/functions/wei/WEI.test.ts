import { describe, expect, it } from "vitest";
import { venueTz } from "@/lib/venue";
import { INDICES, US_FUTURES, isClosed, showUsFutures, ytdPct, type SessionState } from "./rows";
import { lastSession, sparkPoints } from "@/lib/series";

const st = (symbol: string, state: SessionState["state"]): SessionState => ({
  symbol,
  state,
  venue: null,
  venue_name: null,
  next_change: null,
  error: null,
});

describe("WEI rows (SPEC §8)", () => {
  it("lists the spec's indices by region, OMXC25 included", () => {
    const groups = [...new Set(INDICES.map((r) => r.group))];
    expect(groups).toEqual(["AMERICAS", "EMEA", "APAC"]);
    expect(INDICES.map((r) => r.symbol)).toContain("^OMXC25");
    expect(INDICES).toHaveLength(21);
    expect(US_FUTURES.map((r) => r.symbol)).toEqual(["ES=F", "NQ=F", "YM=F"]);
  });

  it("every row resolves an exchange zone, so TIME is never silently the user zone", () => {
    const missing = [...INDICES, ...US_FUTURES].map((r) => r.symbol).filter((s) => !venueTz(s));
    expect(missing).toEqual([]);
  });

  it("US futures show while the cash market is not open, or its state is unknown", () => {
    expect(showUsFutures(new Map([["^GSPC", st("^GSPC", "OPEN")]]))).toBe(false);
    expect(showUsFutures(new Map([["^GSPC", st("^GSPC", "CLOSED")]]))).toBe(true);
    expect(showUsFutures(new Map([["^GSPC", st("^GSPC", "HOLIDAY")]]))).toBe(true);
    expect(showUsFutures(new Map())).toBe(true);
  });

  it("closed and holiday dim; a lunch break and unknown do not", () => {
    expect(isClosed("CLOSED")).toBe(true);
    expect(isClosed("HOLIDAY")).toBe(true);
    expect(isClosed("BREAK")).toBe(false);
    expect(isClosed("OPEN")).toBe(false);
    expect(isClosed(null)).toBe(false);
  });

  it("% YTD from the previous year's close; N.A. when either side is missing", () => {
    expect(ytdPct(110, 100)).toBeCloseTo(10);
    expect(ytdPct(90, 100)).toBeCloseTo(-10);
    expect(ytdPct(null, 100)).toBeNull();
    expect(ytdPct(100, null)).toBeNull();
    expect(ytdPct(100, 0)).toBeNull();
  });

  it("the sparkline uses the newest session only and scales into its box", () => {
    const d1 = 20_000 * 86400;
    const d2 = d1 + 86400;
    const bars = [{ t: d1 + 100 }, { t: d2 + 100 }, { t: d2 + 400 }];
    expect(lastSession(bars)).toEqual([{ t: d2 + 100 }, { t: d2 + 400 }]);
    expect(lastSession([])).toEqual([]);
    expect(sparkPoints([1, 2, 3], 10, 4)).toBe("0,4 5,2 10,0");
    expect(sparkPoints([5, 5], 10, 4)).toBe("0,2 10,2");
    expect(sparkPoints([5], 10, 4)).toBe("");
  });
});
