import { describe, expect, it } from "vitest";
import { spotRow } from "./spot";

const s = (data: { date: string; value: number }[]) => ({
  id: "X",
  title: "x",
  units: null,
  frequency: null,
  updated: null,
  data,
});

describe("GLCO spot rows", () => {
  it("last observation vs the one before; its own date", () => {
    const r = spotRow(
      s([
        { date: "2026-11-04", value: 60 },
        { date: "2026-11-05", value: 61.5 },
        { date: "2026-11-06", value: 60.27 },
      ]),
    );
    expect(r.last).toBe(60.27);
    expect(r.date).toBe("2026-11-06");
    expect(r.prevDate).toBe("2026-11-05");
    expect(r.chg).toBeCloseTo(-1.23);
    expect(r.pct).toBeCloseTo(-2);
  });

  it("one point: no change; none: N.A.", () => {
    expect(spotRow(s([{ date: "2026-10-01", value: 9000 }]))).toMatchObject({
      last: 9000,
      chg: null,
      pct: null,
    });
    expect(spotRow(undefined)).toMatchObject({ last: null, date: null, chg: null });
  });
});
