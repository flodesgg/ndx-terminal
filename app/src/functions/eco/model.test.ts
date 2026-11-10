import { describe, expect, it } from "vitest";
import {
  applyFilter,
  filterFromArgs,
  fmtValue,
  importanceDots,
  nextEvent,
  NO_FILTER,
  type EcoEvent,
} from "./model";

// Mon 2026-11-09 14:30 UTC = 15:30 Copenhagen.
const NOW = Date.parse("2026-11-09T14:30:00Z");

const ev = (id: string, time: string, country: string, importance: number): EcoEvent => ({
  id,
  time,
  time_kind: "calendar",
  country: country as EcoEvent["country"],
  event: id,
  period: "2026-10",
  importance,
  actual: null,
  survey: null,
  prior: null,
  revised: null,
  unit: "%",
  digits: 1,
  note: null,
  source: "test",
  series: null,
  series_source: null,
  indicator: null,
  tentative: false,
  released: Date.parse(time) <= NOW,
});

const EVENTS: EcoEvent[] = [
  ev("old", "2026-11-02T10:00:00Z", "US", 3), // a week ago
  ev("yday", "2026-11-08T10:00:00Z", "EZ", 2),
  ev("dk-am", "2026-11-09T07:00:00Z", "DK", 3),
  // 23:30 UTC is already 00:30 on the 10th in Copenhagen: tomorrow, not today.
  ev("late", "2026-11-09T23:30:00Z", "US", 1),
  ev("us-pm", "2026-11-09T15:00:00Z", "US", 2),
  ev("in6", "2026-11-15T13:30:00Z", "US", 3),
  ev("in10", "2026-11-19T13:30:00Z", "EZ", 3),
];

const ids = (xs: EcoEvent[]) => xs.map((x) => x.id);

describe("ECO args", () => {
  it("country, importance and range tokens, any order and case", () => {
    expect(filterFromArgs([])).toEqual(NO_FILTER);
    expect(filterFromArgs(["dk"])).toEqual({ ...NO_FILTER, country: "DK" });
    expect(filterFromArgs(["HIGH", "US"])).toEqual({
      country: "US",
      minImportance: 3,
      range: "WEEK",
    });
    expect(filterFromArgs(["TODAY", "MED"])).toMatchObject({ minImportance: 2, range: "TODAY" });
    expect(filterFromArgs(["XYZ"])).toEqual(NO_FILTER);
  });
});

describe("ECO filter", () => {
  it("WEEK = yesterday through 6 days ahead, in Copenhagen days", () => {
    expect(ids(applyFilter(EVENTS, NO_FILTER, NOW))).toEqual([
      "yday",
      "dk-am",
      "late",
      "us-pm",
      "in6",
    ]);
  });
  it("TODAY, 2W, PAST", () => {
    expect(ids(applyFilter(EVENTS, { ...NO_FILTER, range: "TODAY" }, NOW))).toEqual([
      "dk-am",
      "us-pm",
    ]);
    expect(ids(applyFilter(EVENTS, { ...NO_FILTER, range: "2W" }, NOW))).toEqual([
      "dk-am",
      "late",
      "us-pm",
      "in6",
      "in10",
    ]);
    expect(ids(applyFilter(EVENTS, { ...NO_FILTER, range: "PAST" }, NOW))).toEqual([
      "old",
      "yday",
      "dk-am",
      "us-pm",
    ]);
  });
  it("country and minimum importance", () => {
    expect(ids(applyFilter(EVENTS, { ...NO_FILTER, country: "US" }, NOW))).toEqual([
      "late",
      "us-pm",
      "in6",
    ]);
    expect(ids(applyFilter(EVENTS, { ...NO_FILTER, minImportance: 3 }, NOW))).toEqual([
      "dk-am",
      "in6",
    ]);
  });
});

describe("ECO next event and values", () => {
  it("the first event after the server's now", () => {
    const sorted = [...EVENTS].sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
    expect(nextEvent(sorted, NOW)?.id).toBe("us-pm");
    expect(nextEvent(sorted, Date.parse("2026-12-01T00:00:00Z"))).toBeUndefined();
  });
  it("values carry their unit; missing is N.A.", () => {
    expect(fmtValue(2.2, "%", 1)).toBe("2.2%");
    expect(fmtValue(221, "K", 0)).toBe("221K");
    expect(fmtValue(-0.25, "", 2)).toBe("\u22120.25");
    expect(fmtValue(null, "%", 1)).toBe("N.A.");
    expect(fmtValue(undefined, "%", 1)).toBe("N.A.");
  });
  it("importance dots clamp to 0..3", () => {
    expect(importanceDots(1)).toBe("●");
    expect(importanceDots(3)).toBe("●●●");
    expect(importanceDots(5)).toBe("●●●");
  });
});
