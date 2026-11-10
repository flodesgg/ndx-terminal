import { describe, expect, it } from "vitest";
import { cmpSymbol, cmpToken, rebase } from "./compare";
import { formatGpArgs, parseGpArgs } from "./args";

const D = 86400;

describe("GP compare overlays", () => {
  it("rebases the other onto the main's price at the first common bar of the window", () => {
    const main = [10, 11, 12, 13].map((c, i) => ({ t: (20_000 + i) * D, c }));
    const other = [100, 110, 99, 121].map((c, i) => ({ t: (20_000 + i) * D, c }));
    const pts = rebase(main, 0, other, 0, (20_000 + 1) * D, false);
    expect(pts.map((p) => p.t)).toEqual([20_001, 20_002, 20_003].map((d) => d * D));
    expect(pts[0]).toMatchObject({ value: 11, pct: 0 });
    expect(pts[1]!.value).toBeCloseTo(9.9); // 99/110 · 11
    expect(pts[2]!.pct).toBeCloseTo(10); // 121/110 − 1
  });

  it("intraday bars of venues in other zones line up by instant, daily bars by date", () => {
    // main: New York (UTC−5), other: Copenhagen (UTC+1). 09:30 NY = 15:30 CPH.
    const ny = [{ t: 20_000 * D + 9.5 * 3600, c: 100 }];
    const cph = [{ t: 20_000 * D + 15.5 * 3600, c: 50 }];
    expect(rebase(ny, -5 * 3600, cph, 3600, 0, true)).toHaveLength(1);
    expect(rebase(ny, -5 * 3600, cph, 3600, 0, false)).toHaveLength(0);
  });

  it("nothing in common is no overlay, never a made-up line", () => {
    expect(rebase([{ t: 1, c: 1 }], 0, [{ t: 2, c: 1 }], 0, 0, false)).toEqual([]);
    expect(rebase([{ t: 1, c: 1 }], 0, [{ t: 1, c: 0 }], 0, 0, false)).toEqual([]);
  });

  it("CMP= args: up to 5, deduplicated, full IDs with spaces round-trip", () => {
    expect(cmpToken("msft us equity")).toBe("CMP=MSFT_US_EQUITY");
    expect(cmpSymbol("MSFT_US_EQUITY")).toBe("MSFT US EQUITY");
    const st = parseGpArgs([
      "CMP=MSFT",
      "CMP=^GSPC",
      "CMP=MSFT",
      "CMP=A",
      "CMP=B",
      "CMP=C",
      "CMP=D",
    ]);
    expect(st.cmp).toEqual(["MSFT", "^GSPC", "A", "B", "C"]);
    expect(parseGpArgs(formatGpArgs(st))).toEqual(st);
    expect(parseGpArgs(["CMP=NOVOB_DC_EQUITY"]).cmp).toEqual(["NOVOB DC EQUITY"]);
  });
});
