/**
 * Drag a ticker from any grid onto a window: it loads there (SPEC §4.9). Rows spread
 * `tickerDragProps(symbol)`; window frames read `droppedTicker(e)`.
 */
import type { DragEvent } from "react";
import { canonicalTicker } from "@/core/clientmigrate";
import { secIndex } from "@/core/secindex";

export const TICKER_MIME = "application/x-ndx-ticker";

export function tickerDragProps(symbol: string): {
  draggable: true;
  onDragStart: (e: DragEvent) => void;
} {
  return {
    draggable: true,
    onDragStart: (e) => {
      // Grids such as WEI show provider symbols (^GSPC); windows and links keep canonical IDs.
      const id = canonicalTicker(symbol, secIndex());
      e.dataTransfer.setData(TICKER_MIME, id);
      e.dataTransfer.setData("text/plain", id);
      e.dataTransfer.effectAllowed = "copy";
    },
  };
}

export function carriesTicker(e: DragEvent): boolean {
  return Array.from(e.dataTransfer.types).includes(TICKER_MIME);
}

export function droppedTicker(e: DragEvent): string | null {
  const t = e.dataTransfer.getData(TICKER_MIME).trim();
  return t || null;
}
