import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Schemas } from "@/core/api";
import { useApi } from "@/core/data";
import { executeCommand } from "@/core/executor";
import { usePanelKeys } from "@/core/keys";
import { useLiveQuotes } from "@/core/live";
import { useVisibleKeys } from "@/core/visible";
import { registerFunction, type PanelProps } from "@/core/registry";
import { NO_SOURCE_HINT, QuoteGrid, isNoSource, type RowInfo } from "@/components/QuoteGrid";
import { NAValue, Sgn } from "@/components/V";
import { fmtPct } from "@/lib/format";
import {
  INDICES,
  US_FUTURES,
  showUsFutures,
  ytdPct,
  type SessionState,
  type WeiRow,
  type YtdBase,
} from "./rows";
import { Spark } from "./Spark";

/** % YTD from the live price and the previous year's last close (source in the tooltip). */
export function YtdCell({
  price,
  base,
}: {
  price: number | null | undefined;
  base: YtdBase | undefined;
}) {
  if (base?.error) {
    const quiet = isNoSource(base.error) || base.error.startsWith("[deferred]");
    if (quiet)
      return (
        <span title={isNoSource(base.error) ? NO_SOURCE_HINT : base.error} data-testid="ytd-na">
          <NAValue />
        </span>
      );
    return (
      <span className="down" title={base.error}>
        ERR
      </span>
    );
  }
  const v = ytdPct(price, base?.close);
  const why = !base
    ? "loading"
    : base.close === null
      ? "no close in the previous year"
      : `base: close ${base.day} · ${base.meta?.source ?? ""} ${base.meta?.tag ?? ""}`;
  return (
    <span title={`% YTD · ${why}`} data-testid="ytd">
      <Sgn v={v}>{fmtPct(v)}</Sgn>
    </span>
  );
}

/**
 * A WEI-style board (WEI, WFX, GLCO): grouped live quotes with % YTD, currency, intraday
 * sparkline and session state; closed venues dimmed. `pick` chooses the rows shown from the
 * session states (WEI adds the US futures while the cash market is closed).
 */
export function Board({
  id,
  active,
  scope,
  candidates,
  pick,
  note,
}: {
  id: string;
  active: boolean;
  scope: "WEI" | "WFX" | "GLCO";
  candidates: readonly WeiRow[];
  pick?: (states: ReadonlyMap<string, SessionState>) => readonly WeiRow[];
  note?: (s: { loaded: number; total: number; rows: readonly WeiRow[] }) => ReactNode;
}) {
  // A window not yet focused leaves tight-budget sources to the focused one (as GP does).
  const [woken, setWoken] = useState(active);
  useEffect(() => {
    if (active) setWoken(true);
  }, [active]);
  const defer = !woken;

  const allSymbols = useMemo(() => candidates.map((r) => r.symbol), [candidates]);
  const statesQ = useApi<Schemas["SessionStatesResponse"]>(
    "/calendar/state",
    { symbols: allSymbols.join(",") },
    { refetchMs: 60_000, staleMs: 30_000 },
  );
  const states = useMemo(
    () => new Map<string, SessionState>((statesQ.data?.items ?? []).map((s) => [s.symbol, s])),
    [statesQ.data],
  );
  const rows: readonly WeiRow[] = useMemo(
    () => (pick ? pick(states) : candidates),
    [pick, states, candidates],
  );
  const symbols = useMemo(() => rows.map((r) => r.symbol), [rows]);

  const [sel, setSel] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const visible = useVisibleKeys(ref, symbols);
  const quotes = useLiveQuotes(symbols, active ? "focus" : "other", visible);

  const refsQ = useApi<Schemas["SecurityLookup"][]>(
    "/secmaster/securities",
    { symbols: allSymbols.join(",") },
    { staleMs: 3_600_000 },
  );
  const currency = useMemo(
    () => new Map((refsQ.data ?? []).map((s) => [s.symbol, s.record?.currency ?? null])),
    [refsQ.data],
  );
  const ytdQ = useApi<Schemas["YtdResponse"]>(
    "/ytd",
    { symbols: allSymbols.join(","), defer: defer || undefined },
    { refetchMs: 3_600_000, staleMs: 600_000 },
  );
  const ytd = useMemo(
    () => new Map((ytdQ.data?.items ?? []).map((b) => [b.symbol, b])),
    [ytdQ.data],
  );
  const shown = useMemo(() => new Set(visible), [visible]);

  const info = (symbol: string): RowInfo => {
    const q = quotes.get(symbol)?.quote;
    return {
      state: states.get(symbol)?.state ?? null,
      currency: currency.get(symbol) ?? null,
      ytd: <YtdCell price={q?.price} base={ytd.get(symbol)} />,
      spark: shown.has(symbol) ? (
        <Spark symbol={symbol} change={q?.change} defer={defer} />
      ) : (
        <NAValue />
      ),
    };
  };

  const cur = rows[Math.min(sel, rows.length - 1)];
  const open = (s: string) => void executeCommand(`${s} GP`, { newPanel: true });
  usePanelKeys(id, scope, (a) => {
    if (a === "down") setSel((s) => Math.min(rows.length - 1, s + 1));
    else if (a === "up") setSel((s) => Math.max(0, s - 1));
    else if (a === "chart" && cur) open(cur.symbol);
    else if (a === "quote" && cur) void executeCommand(`${cur.symbol} Q`, { newPanel: true });
    else return false;
    return true;
  });

  const loaded = rows.filter((r) => quotes.get(r.symbol)?.quote).length;
  return (
    <>
      <div className="ds">
        <span>
          {loaded}/{rows.length} loaded · source and delay per row in SRC · STATE and dimming from
          exchange calendars · YTD% from the previous year&apos;s last close
          {note ? note({ loaded, total: rows.length, rows }) : null}
        </span>
      </div>
      <div ref={ref} style={{ overflow: "auto", flex: 1 }}>
        <QuoteGrid
          rows={[...rows]}
          quotes={quotes}
          sel={Math.min(sel, rows.length - 1)}
          onSelect={setSel}
          onOpen={open}
          info={info}
        />
      </div>
    </>
  );
}

const WEI_ROWS: readonly WeiRow[] = [...INDICES, ...US_FUTURES];
const weiPick = (states: ReadonlyMap<string, SessionState>) =>
  showUsFutures(states) ? WEI_ROWS : INDICES;
const weiNote = ({ rows }: { rows: readonly WeiRow[] }) =>
  rows.length > INDICES.length ? " · US cash market not open: futures shown" : "";

function WEI({ id, active }: PanelProps) {
  return (
    <Board
      id={id}
      active={active}
      scope="WEI"
      candidates={WEI_ROWS}
      pick={weiPick}
      note={weiNote}
    />
  );
}

export function registerWEI(): void {
  registerFunction({
    code: "WEI",
    name: "World equity indices",
    description:
      "Americas, EMEA (incl. OMXC25) and APAC indices with % YTD, currency, intraday sparkline " +
      "and session state; US futures while the cash market is closed",
    ticker: "none",
    syntax: "WEI",
    examples: ["WEI"],
    category: "Market",
    sectors: ["INDEX", "EQUITY"],
    menu: ["Indices"],
    args: [],
    actions: [],
    component: WEI,
  });
}
