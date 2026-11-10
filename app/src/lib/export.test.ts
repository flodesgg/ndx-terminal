import { describe, expect, it } from "vitest";
import { tablesToCsv } from "./export";

describe("96) Export: visible tables as CSV (SPEC §4.2: copy/export uses ASCII '-')", () => {
  it("writes header and body rows, ASCII minus, quotes cells with commas", () => {
    const root = document.createElement("div");
    root.innerHTML = `<table><thead><tr><th>SYM</th><th>CHG</th></tr></thead>
      <tbody><tr><td>AAPL</td><td>−1.23</td></tr><tr><td>A, B</td><td>+0.50</td></tr></tbody>
      </table>`;
    expect(tablesToCsv(root)).toEqual({ csv: 'SYM,CHG\nAAPL,-1.23\n"A, B",+0.50', rows: 2 });
  });

  it("no table: nothing to export", () => {
    expect(tablesToCsv(document.createElement("div"))).toEqual({ csv: "", rows: 0 });
  });
});
