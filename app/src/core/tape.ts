/** Time & sales tape merged from the backend's windows of recent prints (SPEC §8 `Q`). */
import { useCallback, useState } from "react";
import type { Meta } from "./api";
import { useLiveTrades, type LiveTrades, type Prio } from "./live";

export type TapePrint = LiveTrades["prints"][number];

export interface TapeRow extends TapePrint {
  /** Prints the client never received just before this one (the sequence jumped). */
  missedBefore: number;
}

export interface Tape {
  rows: TapeRow[]; // oldest first
  meta: Meta | null;
}

export const EMPTY_TAPE: Tape = { rows: [], meta: null };

/** Add a window of prints: new sequence numbers only, gaps marked, newest `keep` kept. A window
 * whose newest print is older than ours means the backend restarted: start over from it. */
export function mergeTape(prev: Tape, prints: readonly TapePrint[], meta: Meta, keep = 100): Tape {
  if (!prints.length) return prev;
  const last = prev.rows.length ? prev.rows[prev.rows.length - 1]!.seq : 0;
  const restarted = prints[prints.length - 1]!.seq < last;
  const base = restarted ? [] : prev.rows;
  let after = restarted ? 0 : last;
  const added: TapeRow[] = [];
  for (const p of prints) {
    if (p.seq <= after) continue;
    const missedBefore = base.length || added.length ? p.seq - after - 1 : 0;
    added.push({ ...p, missedBefore });
    after = p.seq;
  }
  if (!added.length && !restarted) return { ...prev, meta };
  const rows = [...base, ...added];
  return { rows: rows.slice(Math.max(0, rows.length - keep)), meta };
}

/** Upticks and downticks: direction of each print against the one before it. */
export function tickDir(rows: readonly TapeRow[], i: number): "up" | "down" | "" {
  const prev = rows[i - 1];
  const cur = rows[i];
  if (!prev || !cur || prev.price === cur.price) return "";
  return cur.price > prev.price ? "up" : "down";
}

export function useTape(symbol: string | null, prio: Prio): Tape {
  const [tape, setTape] = useState<{ symbol: string | null; tape: Tape }>({
    symbol,
    tape: EMPTY_TAPE,
  });
  const onTrades = useCallback(
    (msg: LiveTrades) =>
      setTape((t) => ({
        symbol,
        tape: mergeTape(t.symbol === symbol ? t.tape : EMPTY_TAPE, msg.prints, msg.meta),
      })),
    [symbol],
  );
  useLiveTrades(symbol, prio, onTrades);
  return tape.symbol === symbol ? tape.tape : EMPTY_TAPE;
}
