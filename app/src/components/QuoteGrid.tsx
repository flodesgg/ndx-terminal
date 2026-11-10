import { useEffect, useRef, type ReactNode } from "react";
import { tickerDragProps } from "@/lib/dragTicker";
import type { QuoteState } from "@/core/live";
import { LatencyTag } from "@/components/DataStatus";
import { fmtChange, fmtPct, fmtPrice, fmtVenueTime } from "@/lib/format";
import { NAValue, Sgn, V } from "@/components/V";

/** No enabled source covers the row (backend `[no_provider]`): a configuration state, shown
 * as dim N.A.; the opt-in personal-use source covers every asset class. */
export const NO_SOURCE_HINT = "no source; enable yfinance in PDF";

export function isNoSource(error: string | null | undefined): boolean {
  return !!error && error.startsWith("[no_provider]");
}

export interface GridRow {
  symbol: string;
  label: string;
  group?: string;
}

/** Per-row facts besides the live quote (SPEC §8 WEI columns). */
export interface RowInfo {
  /** Session state of the row's venue (calendar), dims the row when closed. */
  state?: "OPEN" | "CLOSED" | "BREAK" | "HOLIDAY" | null;
  /** Currency the level is expressed in (security master). */
  currency?: string | null;
  /** % YTD cell content (computed by the caller from the previous year's close). */
  ytd?: ReactNode;
  /** Intraday sparkline cell content. */
  spark?: ReactNode;
}

const STATE_CLASS: Record<string, string> = {
  OPEN: "up",
  BREAK: "amber",
  HOLIDAY: "amber",
  CLOSED: "dim",
};

/** Table for WEI-style dashboards: grouped rows of live quotes with flashes. */
export function QuoteGrid({
  rows,
  quotes,
  sel,
  onSelect,
  onOpen,
  info,
}: {
  rows: GridRow[];
  quotes: Map<string, QuoteState>;
  sel: number;
  onSelect: (i: number) => void;
  onOpen: (symbol: string) => void;
  info?: (symbol: string) => RowInfo;
}) {
  const prev = useRef(new Map<string, number>());
  const flashes = useRef(new Map<string, { dir: "up" | "down"; n: number }>());
  for (const r of rows) {
    const p = quotes.get(r.symbol)?.quote?.price;
    const old = prev.current.get(r.symbol);
    if (p != null && old != null && p !== old) {
      const f = flashes.current.get(r.symbol);
      flashes.current.set(r.symbol, { dir: p > old ? "up" : "down", n: (f?.n ?? 0) + 1 });
    }
    if (p != null) prev.current.set(r.symbol, p);
  }
  const bodyRef = useRef<HTMLTableSectionElement>(null);
  useEffect(() => {
    bodyRef.current?.querySelector(`[data-idx="${sel}"]`)?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  let lastGroup: string | undefined;
  return (
    <table className="grid">
      <thead>
        <tr>
          <th className="l">NAME</th>
          <th className="l">SYMBOL</th>
          <th>LAST</th>
          <th>CHG</th>
          <th>CHG%</th>
          {/* Freshness right after the price block: visible at the default panel width (#43). */}
          <th className="l">SRC</th>
          <th title="% change since the previous year's last close">YTD%</th>
          <th className="l">CCY</th>
          <th className="l" title="Last session, 5-minute bars">
            INTRADAY
          </th>
          <th title="Exchange-local time; FX, crypto and rates in your time zone">TIME</th>
          <th className="l" title="Session state from the venue's exchange calendar">
            STATE
          </th>
        </tr>
      </thead>
      <tbody ref={bodyRef}>
        {rows.map((r, i) => {
          const st = quotes.get(r.symbol);
          const q = st?.quote;
          const f = flashes.current.get(r.symbol);
          const header =
            r.group && r.group !== lastGroup ? (
              <tr key={`g-${r.group}`}>
                <td
                  colSpan={11}
                  className="l"
                  style={{ background: "var(--header-hl)", color: "var(--fg)", fontWeight: 700 }}
                >
                  {r.group}
                </td>
              </tr>
            ) : null;
          lastGroup = r.group;
          const noSource = !q && isNoSource(st?.error);
          const ri = info?.(r.symbol);
          const closed = ri?.state === "CLOSED" || ri?.state === "HOLIDAY";
          return [
            header,
            <tr
              key={r.symbol}
              data-idx={i}
              data-row-key={r.symbol}
              data-state={ri?.state ?? undefined}
              className={[i === sel ? "sel" : "", closed ? "closed" : ""].join(" ").trim()}
              title={noSource ? NO_SOURCE_HINT : (st?.error ?? st?.meta?.note ?? "")}
              onMouseDown={() => onSelect(i)}
              onDoubleClick={() => onOpen(r.symbol)}
              {...tickerDragProps(r.symbol)}
            >
              <td className="l" style={{ color: "var(--text)" }}>
                {r.label}
              </td>
              <td className="l amber">{r.symbol}</td>
              <td key={f ? `${r.symbol}-${f.n}` : r.symbol} className={f ? `flash-${f.dir}` : ""}>
                {noSource ? (
                  <span title={NO_SOURCE_HINT} data-testid="no-source">
                    <NAValue />
                  </span>
                ) : st?.error && !q ? (
                  <span className="down">ERR</span>
                ) : (
                  <V>{fmtPrice(q?.price, r.symbol)}</V>
                )}
              </td>
              <Sgn as="td" v={q?.change}>
                {fmtChange(q?.change, r.symbol, q?.price)}
              </Sgn>
              <Sgn as="td" v={q?.change_pct}>
                {fmtPct(q?.change_pct)}
              </Sgn>
              <td className="l">{st?.meta ? <LatencyTag meta={st.meta} /> : null}</td>
              <td>{ri?.ytd ?? <NAValue />}</td>
              <td className="l dim">
                <V>{ri?.currency}</V>
              </td>
              <td className="l">{ri?.spark ?? <NAValue />}</td>
              <td className="dim">{fmtVenueTime(q?.ts, r.symbol)}</td>
              <td className={`l ${ri?.state ? STATE_CLASS[ri.state] : "dim"}`}>
                <V>{ri ? ri.state : q?.market_state}</V>
              </td>
            </tr>,
          ];
        })}
      </tbody>
    </table>
  );
}
