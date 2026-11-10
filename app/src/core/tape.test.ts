import { describe, expect, it } from "vitest";
import type { Meta } from "./api";
import { EMPTY_TAPE, mergeTape, tickDir, type TapePrint } from "./tape";

const meta = { source: "Finnhub (stream)", tag: "RT·TRD" } as Meta;
const p = (seq: number, price = 100, size = 1): TapePrint => ({
  seq,
  t: new Date(1_794_249_640_000 + seq * 1000).toISOString(),
  price,
  size,
});

describe("time & sales tape", () => {
  it("adds only new prints from overlapping windows", () => {
    let t = mergeTape(EMPTY_TAPE, [p(1), p(2)], meta);
    t = mergeTape(t, [p(1), p(2), p(3)], meta);
    expect(t.rows.map((r) => r.seq)).toEqual([1, 2, 3]);
    expect(t.rows.every((r) => r.missedBefore === 0)).toBe(true);
    expect(t.meta?.source).toBe("Finnhub (stream)");
  });

  it("marks prints it never received instead of hiding the jump", () => {
    let t = mergeTape(EMPTY_TAPE, [p(1)], meta);
    t = mergeTape(t, [p(5), p(6)], meta);
    expect(t.rows.map((r) => [r.seq, r.missedBefore])).toEqual([
      [1, 0],
      [5, 3],
      [6, 0],
    ]);
  });

  it("the first window is not a gap; a backend restart starts over", () => {
    let t = mergeTape(EMPTY_TAPE, [p(40), p(41)], meta);
    expect(t.rows[0]!.missedBefore).toBe(0);
    t = mergeTape(t, [p(1), p(2)], meta);
    expect(t.rows.map((r) => r.seq)).toEqual([1, 2]);
  });

  it("keeps the newest rows only", () => {
    const t = mergeTape(
      EMPTY_TAPE,
      Array.from({ length: 10 }, (_, i) => p(i + 1)),
      meta,
      4,
    );
    expect(t.rows.map((r) => r.seq)).toEqual([7, 8, 9, 10]);
  });

  it("colours a print by its tick against the previous one", () => {
    const t = mergeTape(EMPTY_TAPE, [p(1, 100), p(2, 101), p(3, 101), p(4, 99)], meta);
    expect([0, 1, 2, 3].map((i) => tickDir(t.rows, i))).toEqual(["", "up", "", "down"]);
  });
});
