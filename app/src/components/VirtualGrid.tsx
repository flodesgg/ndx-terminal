import { useRef, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

export interface GridColumn<T> {
  key: string;
  header: string;
  width: number;
  align?: "l" | "r";
  cell: (row: T) => ReactNode;
}

/** Virtualized dense grid (SPEC §2: 5,000 rows scroll at 60 fps). Only visible rows render. */
export function VirtualGrid<T>({
  rows,
  columns,
  rowHeight = 20,
  rowKey,
  testId,
}: {
  rows: T[];
  columns: GridColumn<T>[];
  rowHeight?: number;
  rowKey: (row: T, i: number) => string;
  testId?: string;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const v = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 12,
  });
  const width = columns.reduce((a, c) => a + c.width, 0);
  return (
    <div className="vgrid" data-testid={testId}>
      <div className="vgrid-head" style={{ width }}>
        {columns.map((c) => (
          <div key={c.key} className={c.align ?? "l"} style={{ width: c.width }}>
            {c.header}
          </div>
        ))}
      </div>
      <div ref={scrollRef} className="vgrid-body" data-testid={testId && `${testId}-body`}>
        <div style={{ height: v.getTotalSize(), width, position: "relative" }}>
          {v.getVirtualItems().map((item) => {
            const row = rows[item.index]!;
            return (
              <div
                key={rowKey(row, item.index)}
                className={`vgrid-row${item.index % 2 ? " alt" : ""}`}
                style={{ height: rowHeight, transform: `translateY(${item.start}px)` }}
              >
                {columns.map((c) => (
                  <div key={c.key} className={c.align ?? "l"} style={{ width: c.width }}>
                    {c.cell(row)}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
