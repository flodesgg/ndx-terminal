import { describe, expect, it } from "vitest";
import { extendedRuns, isUsExtended } from "./sessionShade";

const day = 20_400 * 86400;
const at = (h: number, m = 0) => day + h * 3600 + m * 60;

describe("US extended hours shading", () => {
  it("regular session is 09:30 to 16:00 New York; the rest is extended", () => {
    expect(isUsExtended(at(4))).toBe(true);
    expect(isUsExtended(at(9, 25))).toBe(true);
    expect(isUsExtended(at(9, 30))).toBe(false);
    expect(isUsExtended(at(15, 55))).toBe(false);
    expect(isUsExtended(at(16))).toBe(true);
    expect(isUsExtended(at(19, 55))).toBe(true);
  });

  it("consecutive extended bars form one band", () => {
    const bars = [at(8), at(9), at(9, 30), at(12), at(16), at(17), at(24 + 4), at(24 + 9, 30)];
    expect(extendedRuns(bars)).toEqual([
      [0, 1],
      [4, 6],
    ]);
    expect(extendedRuns([at(10), at(11)])).toEqual([]);
    expect(extendedRuns([at(18)])).toEqual([[0, 0]]);
  });
});
