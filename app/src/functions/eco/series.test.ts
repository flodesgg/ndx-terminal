import { describe, expect, it } from "vitest";
import { inRange, recent, sortIndicators, toSeconds, type EcoIndicator } from "./series";

const obs = (date: string, value: number) => ({ period: date.slice(0, 7), date, value });
const DATA = [
  obs("2014-01-01", 1),
  obs("2016-11-01", 2),
  obs("2021-11-01", 3),
  obs("2024-11-01", 4),
  obs("2026-10-01", 5),
];

describe("ECST helpers", () => {
  it("ranges count back from the newest observation", () => {
    expect(inRange(DATA, "2Y").map((o) => o.value)).toEqual([4, 5]);
    expect(inRange(DATA, "5Y").map((o) => o.value)).toEqual([3, 4, 5]);
    expect(inRange(DATA, "10Y").map((o) => o.value)).toEqual([2, 3, 4, 5]);
    expect(inRange(DATA, "MAX")).toHaveLength(5);
    expect(inRange([], "2Y")).toEqual([]);
  });
  it("recent: newest first with the change from the observation before", () => {
    const r = recent(DATA, 3);
    expect(r.map((x) => x.obs.value)).toEqual([5, 4, 3]);
    expect(r[0]!.chg).toBe(1);
    expect(recent(DATA.slice(0, 1), 3)[0]!.chg).toBeNull();
  });
  it("x is the period's first day at 00:00 UTC", () => {
    expect(toSeconds("2026-10-01")).toBe(Date.UTC(2026, 9, 1) / 1000);
  });
  it("indicators follow the ECO country order, then importance", () => {
    const i = (key: string, country: string, importance: number): EcoIndicator => ({
      key,
      country,
      event: key,
      importance,
      series: "x",
      transform: "level",
      transform_label: "level",
      unit: "",
      digits: 1,
      calendar: "x",
    });
    const out = sortIndicators([
      i("dk", "DK", 3),
      i("us2", "US", 2),
      i("ez", "EZ", 3),
      i("us3", "US", 3),
    ]);
    expect(out.map((x) => x.key)).toEqual(["us3", "us2", "ez", "dk"]);
  });
});
