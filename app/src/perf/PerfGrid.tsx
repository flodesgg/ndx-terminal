/**
 * Perf smoke harness (SPEC §2, §11): a 5,000-row grid. Mounted only in dev builds at `?perf=grid`
 * and driven by e2e/perf.spec.ts. Rows are synthetic layout fixtures labelled DEMO — they never
 * reach a normal screen.
 */
import { VirtualGrid, type GridColumn } from "@/components/VirtualGrid";
import { fmtBig, fmtPct, fmtPrice } from "@/lib/format";

interface Row {
  i: number;
  sym: string;
  last: number;
  pct: number;
  vol: number;
}

const ROWS: Row[] = Array.from({ length: 5000 }, (_, i) => ({
  i,
  sym: `DEMO${String(i).padStart(4, "0")}`,
  last: 10 + ((i * 7919) % 99000) / 100,
  pct: (((i * 104729) % 1000) - 500) / 100,
  vol: ((i * 15485863) % 90_000_000) + 10_000,
}));

const COLS: GridColumn<Row>[] = [
  { key: "n", header: "#", width: 60, align: "r", cell: (r) => r.i + 1 },
  { key: "s", header: "Ticker", width: 110, cell: (r) => r.sym },
  { key: "l", header: "Last", width: 100, align: "r", cell: (r) => fmtPrice(r.last) },
  {
    key: "p",
    header: "%Chg",
    width: 90,
    align: "r",
    cell: (r) => <span className={r.pct >= 0 ? "up" : "down"}>{fmtPct(r.pct)}</span>,
  },
  { key: "v", header: "Volume", width: 100, align: "r", cell: (r) => fmtBig(r.vol) },
];

export function PerfGrid() {
  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
      <div className="demo-badge" data-testid="demo-badge">
        DEMO
      </div>
      <VirtualGrid rows={ROWS} columns={COLS} rowKey={(r) => r.sym} testId="perf-grid" />
    </div>
  );
}
