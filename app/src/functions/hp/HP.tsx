/** HP — historical price table (SPEC §7 `HP`): daily / weekly / monthly bars with a summary. */
import { useEffect, useMemo, useRef, useState } from "react";
import type { Schemas } from "@/core/api";
import { useApi } from "@/core/data";
import { usePanelKeys } from "@/core/keys";
import { matching, oneOf, registerFunction, type PanelProps } from "@/core/registry";
import { drill } from "@/core/items";
import type { PanelSpec } from "@/core/layout/tree";
import { DataStatus, Loading } from "@/components/DataStatus";
import { NAValue, Sgn } from "@/components/V";
import { fmtBig, fmtChange, fmtDate, fmtPct, fmtPrice } from "@/lib/format";
import { DateField } from "@/functions/gp/GP";
import {
  HP_RANGES,
  PERIODS,
  PERIOD_INTERVAL,
  PERIOD_LABEL,
  formatHpArgs,
  hpLookback,
  hpRows,
  hpSummary,
  parseHpArgs,
  type HpState,
} from "./model";

type BarsResponse = Schemas["BarsResponse"];

const day = (t: number) => fmtDate(t * 1000, "UTC"); // bar times are venue wall clock
const PAGE = 20;

function HP({ id, panel, update, active }: PanelProps) {
  const symbol = panel.ticker ?? "";
  const st = useMemo(() => parseHpArgs(panel.args), [panel.args]);
  const set = (patch: Partial<HpState>) =>
    update({ ...panel, args: formatHpArgs({ ...st, ...patch }) });
  // Same budget rule as GP: a window never focused asks only cheap or stored sources.
  const [woken, setWoken] = useState(active);
  useEffect(() => {
    if (active) setWoken(true);
  }, [active]);
  const q = useApi<BarsResponse>(
    symbol ? `/bars/${encodeURIComponent(symbol)}` : null,
    {
      interval: PERIOD_INTERVAL[st.per],
      lookback: hpLookback(st, Date.now()),
      defer: woken ? undefined : true,
    },
    { refetchMs: 300_000, staleMs: 60_000 },
  );
  const data = q.data?.data;
  const rows = useMemo(() => (data ? hpRows(data, st) : []), [data, st]);
  const sum = useMemo(() => hpSummary(rows), [rows]);

  const [sel, setSel] = useState(0);
  const body = useRef<HTMLTableSectionElement>(null);
  useEffect(() => setSel(0), [panel.args, symbol]);
  useEffect(() => {
    body.current?.querySelector(`[data-idx="${sel}"]`)?.scrollIntoView({ block: "nearest" });
  }, [sel]);
  const move = (to: number) => setSel(Math.max(0, Math.min(rows.length - 1, to)));
  usePanelKeys(id, "HP", (a) => {
    if (a === "down") move(sel + 1);
    else if (a === "up") move(sel - 1);
    else if (a === "page-down") move(sel + PAGE);
    else if (a === "page-up") move(sel - PAGE);
    else if (a === "top") move(0);
    else if (a === "bottom") move(rows.length - 1);
    else if (a === "chart") update(chartOf(panel, st));
    else return false;
    return true;
  });

  const px = (v: number | null | undefined) => fmtPrice(v, symbol);
  const ref = rows[0]?.bar.c;
  return (
    <>
      <DataStatus
        meta={q.data?.meta}
        error={q.error}
        fetching={q.isFetching}
        waiting={q.failureReason}
        updatedAt={q.dataUpdatedAt}
      />
      <div className="toolbar" data-testid="hp-toolbar">
        {PERIODS.map((p, i) => (
          <button
            key={p}
            className={st.per === p ? "on" : ""}
            title={`${i + 1}) ${PERIOD_LABEL[p]}`}
            onClick={() => set({ per: p })}
          >
            {p}
          </button>
        ))}
        <span className="sep" />
        {HP_RANGES.map((r) => (
          <button
            key={r}
            className={!st.from && st.range === r ? "on" : ""}
            onClick={() => set({ range: r, from: undefined, to: undefined })}
          >
            {r}
          </button>
        ))}
        <DateField
          label="FROM"
          value={st.from}
          onCommit={(v) => set({ from: v, to: v ? st.to : undefined, range: v ? undefined : "3M" })}
        />
        <DateField label="TO" value={st.to} disabled={!st.from} onCommit={(v) => set({ to: v })} />
      </div>
      <div
        className="ds"
        data-testid="hp-summary"
        style={{ display: "block", whiteSpace: "normal" }}
      >
        <span className="dim">{PERIOD_LABEL[st.per].toUpperCase()}</span> {sum.n} bars · HIGH{" "}
        {sum.high ? (
          <>
            <b>{px(sum.high.v)}</b> <span className="dim">{day(sum.high.t)}</span>
          </>
        ) : (
          <NAValue />
        )}{" "}
        · LOW{" "}
        {sum.low ? (
          <>
            <b>{px(sum.low.v)}</b> <span className="dim">{day(sum.low.t)}</span>
          </>
        ) : (
          <NAValue />
        )}{" "}
        · AVG <b>{px(sum.avgClose)}</b> · CHG{" "}
        <Sgn v={sum.chg}>{fmtChange(sum.chg, symbol, ref)}</Sgn>{" "}
        <Sgn v={sum.pct}>{fmtPct(sum.pct)}</Sgn> · AVG VOL{" "}
        {sum.avgVolume == null ? <NAValue /> : <b>{fmtBig(sum.avgVolume)}</b>}
      </div>
      {q.isLoading ? (
        <Loading what={`${symbol} ${PERIOD_LABEL[st.per].toLowerCase()} bars`} />
      ) : null}
      <div style={{ overflow: "auto", flex: 1 }}>
        {data && !rows.length ? (
          <div className="empty">
            No {PERIOD_LABEL[st.per].toLowerCase()} bars in this window
            {data.length ? ` (the source's history starts ${day(data[0]!.t)})` : ""}.
          </div>
        ) : (
          <table className="grid" data-testid="hp">
            <thead>
              <tr>
                <th className="l">
                  {st.per === "D" ? "DATE" : st.per === "W" ? "WEEK OF" : "MONTH"}
                </th>
                <th>OPEN</th>
                <th>HIGH</th>
                <th>LOW</th>
                <th>CLOSE</th>
                <th>CHG</th>
                <th>CHG%</th>
                <th>VOLUME</th>
              </tr>
            </thead>
            <tbody ref={body}>
              {rows.map((r, i) => (
                <tr
                  key={r.bar.t}
                  data-idx={i}
                  className={i === sel ? "sel" : ""}
                  onMouseDown={() => setSel(i)}
                >
                  <td className="l">{day(r.bar.t)}</td>
                  <td>{px(r.bar.o)}</td>
                  <td>{px(r.bar.h)}</td>
                  <td>{px(r.bar.l)}</td>
                  <td className="amber">{px(r.bar.c)}</td>
                  <td>
                    <Sgn v={r.chg}>{fmtChange(r.chg, symbol, r.bar.c)}</Sgn>
                  </td>
                  <td>
                    <Sgn v={r.pct}>{fmtPct(r.pct)}</Sgn>
                  </td>
                  <td>{r.bar.v == null ? <NAValue /> : fmtBig(r.bar.v)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

/** The same security and window as a chart (Enter, item 4). */
function chartOf(p: PanelSpec, st: HpState): PanelSpec {
  const tf = st.per === "D" ? "D" : st.per === "W" ? "W" : "1MO";
  const win = st.from ? [`FROM=${st.from}`, ...(st.to ? [`TO=${st.to}`] : [])] : [st.range ?? "3M"];
  return { fn: "GP", ticker: p.ticker, args: [tf, ...win] };
}

export function registerHP(): void {
  registerFunction({
    code: "HP",
    name: "Historical prices",
    description:
      "Daily, weekly or monthly open/high/low/close, change and volume for a window, with its " +
      "high, low, average and change",
    ticker: "required",
    syntax: "<TICKER> HP [D | W | M] [1M 3M 6M YTD 1Y 2Y 5Y MAX | FROM=<date> [TO=<date>]]",
    examples: ["AAPL US EQUITY HP", "NOVOB DC EQUITY HP W 1Y", "SPX INDEX HP M MAX"],
    category: "Market",
    sectors: ["EQUITY", "INDEX", "COMDTY", "CURNCY"],
    menu: ["Charts"],
    args: [
      oneOf("periodicity", PERIODS, "D daily · W weekly · M monthly bars"),
      oneOf("range", HP_RANGES, "window"),
      matching("from", /^FROM=\d{4}-\d{2}-\d{2}$/, "FROM=YYYY-MM-DD", "custom window start"),
      matching("to", /^TO=\d{4}-\d{2}-\d{2}$/, "TO=YYYY-MM-DD", "custom window end"),
    ],
    actions: [
      ...PERIODS.map((p, i) => ({
        n: i + 1,
        label: PERIOD_LABEL[p],
        to: (s: PanelSpec) => ({
          ...s,
          args: formatHpArgs({ ...parseHpArgs(s.args), per: p }),
        }),
      })),
      { n: 4, label: "Chart", to: (s: PanelSpec) => chartOf(s, parseHpArgs(s.args)) },
      drill(5, "Quote", "Q"),
      drill(6, "Description", "DES"),
    ],
    component: HP,
    title: (p) => `Historical prices ${PERIOD_LABEL[parseHpArgs(p.args).per].toLowerCase()}`,
  });
}
