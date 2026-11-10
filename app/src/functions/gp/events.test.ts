import { describe, expect, it } from "vitest";
import { placeEvents, type ChartEvent } from "./events";

const D = 86400;
const day0 = Date.UTC(2026, 9, 26) / 1000; // Monday 2026-10-26
const ev = (kind: "E" | "D" | "S", date: string): ChartEvent => ({
  kind,
  date,
  title: kind,
  source: "test",
  value: null,
  currency: null,
  url: null,
});

describe("GP event markers", () => {
  it("daily bars: the event's day; a weekend event goes to the Friday before", () => {
    const days = [0, 1, 2, 3, 4, 7].map((d) => day0 + d * D);
    const { byBar, outside } = placeEvents(
      days,
      [ev("E", "2026-10-28"), ev("D", "2026-11-01"), ev("S", "2020-01-01"), ev("E", "2027-01-01")],
      ["E", "D", "S"],
    );
    expect(byBar.get(day0 + 2 * D)!.map((e) => e.kind)).toEqual(["E"]);
    expect(byBar.get(day0 + 4 * D)!.map((e) => e.kind)).toEqual(["D"]);
    expect(outside).toBe(2);
  });

  it("intraday bars: the last bar of that day (an after-close release)", () => {
    const bars = [9.5, 12, 15.5, 33.5].map((h) => day0 + h * 3600);
    const { byBar } = placeEvents(bars, [ev("E", "2026-10-26")], ["E"]);
    expect([...byBar.keys()]).toEqual([day0 + 15.5 * 3600]);
  });

  it("weekly bars: the week's bar; kinds not wanted are not placed", () => {
    const weeks = [0, 7, 14].map((d) => day0 + d * D);
    const { byBar } = placeEvents(weeks, [ev("D", "2026-11-04"), ev("S", "2026-11-04")], ["D"]);
    expect(byBar.get(day0 + 7 * D)!.map((e) => e.kind)).toEqual(["D"]);
    expect(byBar.size).toBe(1);
  });
});
