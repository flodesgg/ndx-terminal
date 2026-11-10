/**
 * Perf smoke harness (SPEC §2, §11): a 100 ticks/s quote stream into a 200-row grid, through the
 * real client path (LiveClient.dispatch → stored at once → Coalescer, ≤ 4 repaints/s per symbol →
 * one re-render per frame). Dev builds only, at `?perf=stream`; driven by e2e/perf.spec.ts.
 * Ticks are deterministic synthetic values labelled DEMO — they never reach a normal screen.
 */
import { useEffect, useMemo } from "react";
import { VirtualGrid, type GridColumn } from "@/components/VirtualGrid";
import type { Meta } from "@/core/api";
import { live, useQuoteStates, type Quote } from "@/core/live";
import { fmtPct, fmtPrice } from "@/lib/format";

const N = 200;
const TICKS_PER_S = 100;
const SYMBOLS = Array.from({ length: N }, (_, i) => `PERF${String(i).padStart(3, "0")}`);

const META = {
  source: "DEMO fixtures",
  tag: "DEMO",
  demo: true,
  latency: "realtime",
} as unknown as Meta;

declare global {
  interface Window {
    __perfTicks?: number;
  }
}

function tick(n: number): void {
  const i = n % N;
  const price = 100 + ((n * 7919) % 5000) / 100;
  const pct = (((n * 104729) % 1000) - 500) / 100;
  live.dispatch({
    type: "quote",
    symbol: SYMBOLS[i]!,
    data: {
      symbol: SYMBOLS[i]!,
      price,
      change_pct: pct,
      ts: Date.now() / 1000,
    } as unknown as Quote,
    meta: { ...META, as_of: new Date().toISOString(), fetched_at: new Date().toISOString() },
  });
  window.__perfTicks = n + 1;
}

interface Row {
  sym: string;
  last: number | null;
  pct: number | null;
}

const COLS: GridColumn<Row>[] = [
  { key: "s", header: "Ticker", width: 110, cell: (r) => r.sym },
  { key: "l", header: "Last", width: 100, align: "r", cell: (r) => fmtPrice(r.last) },
  { key: "p", header: "%Chg", width: 90, align: "r", cell: (r) => fmtPct(r.pct) },
];

export function PerfStream() {
  const states = useQuoteStates(SYMBOLS);
  useEffect(() => {
    // 100 ticks/s, in 10 ms steps; timers may bunch up, so catch up to the wall clock.
    const t0 = performance.now();
    let n = 0;
    const id = setInterval(() => {
      const due = Math.floor(((performance.now() - t0) * TICKS_PER_S) / 1000);
      while (n < due) tick(n++);
    }, 10);
    return () => clearInterval(id);
  }, []);
  const rows = useMemo<Row[]>(
    () =>
      SYMBOLS.map((sym) => {
        const q = states.get(sym)?.quote;
        return { sym, last: q?.price ?? null, pct: q?.change_pct ?? null };
      }),
    [states],
  );
  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
      <div className="demo-badge" data-testid="demo-badge">
        DEMO
      </div>
      <VirtualGrid rows={rows} columns={COLS} rowKey={(r) => r.sym} testId="perf-stream" />
    </div>
  );
}
