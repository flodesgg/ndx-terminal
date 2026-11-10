import { useEffect, useMemo, useRef, useState } from "react";
import type { Schemas } from "@/core/api";
import { useApi } from "@/core/data";
import { executeCommand } from "@/core/executor";
import { usePanelKeys } from "@/core/keys";
import { matching, registerFunction, type PanelProps } from "@/core/registry";
import { DataStatus, Loading } from "@/components/DataStatus";
import { fmtBig, fmtNum, fmtPct, fmtPrice } from "@/lib/format";
import {
  REGIONS,
  SECTORS,
  SORTS,
  formatAmount,
  formatEqsArgs,
  parseAmount,
  parseEqsArgs,
  toQuery,
  type Filters,
} from "./args";
import { Sgn, V } from "@/components/V";

type Resp = Schemas["ScreenResponse"];

function AmountInput({
  label,
  value,
  onCommit,
  width = 70,
}: {
  label: string;
  value: number | null;
  onCommit: (v: number | null) => void;
  width?: number;
}) {
  const [text, setText] = useState(value == null ? "" : formatAmount(value));
  useEffect(() => setText(value == null ? "" : formatAmount(value)), [value]);
  const commit = () => onCommit(text.trim() ? parseAmount(text) : null);
  return (
    <label>
      {label}{" "}
      <input
        value={text}
        style={{ width }}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          }
        }}
      />
    </label>
  );
}

function EQS({ id, panel, update }: PanelProps) {
  const f = useMemo(() => parseEqsArgs(panel.args), [panel.args]);
  const set = (patch: Partial<Filters>) =>
    update({ ...panel, args: formatEqsArgs({ ...f, ...patch }) });
  const q = useApi<Resp>("/screen", toQuery(f), { staleMs: 60_000 });
  const rows = q.data?.data ?? [];
  const [sel, setSel] = useState(0);
  const formRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLTableSectionElement>(null);
  const cur = rows[sel];

  useEffect(() => {
    bodyRef.current?.querySelector(`[data-idx="${sel}"]`)?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  usePanelKeys(id, "EQS", (a) => {
    if (a === "down") setSel((s) => Math.min(rows.length - 1, s + 1));
    else if (a === "up") setSel((s) => Math.max(0, s - 1));
    else if (a === "chart" && cur) void executeCommand(`${cur.symbol} GP`, { newPanel: true });
    else if (a === "des" && cur) void executeCommand(`${cur.symbol} DES`, { newPanel: true });
    else if (a === "add" && cur) void executeCommand(`W ADD ${cur.symbol}`);
    else if (a === "filter") formRef.current?.querySelector<HTMLElement>("select, input")?.focus();
    else if (a === "sort") set({ sort: SORTS[(SORTS.indexOf(f.sort) + 1) % SORTS.length]! });
    else if (a === "sort-dir") set({ asc: !f.asc });
    else return false;
    return true;
  });

  return (
    <>
      <div className="form-row" ref={formRef}>
        <label>
          REGION{" "}
          <select value={f.region} onChange={(e) => set({ region: e.target.value })}>
            {REGIONS.map((r) => (
              <option key={r} value={r}>
                {r.toUpperCase()}
              </option>
            ))}
          </select>
        </label>
        <label>
          SECTOR{" "}
          <select value={f.sector ?? ""} onChange={(e) => set({ sector: e.target.value || null })}>
            <option value="">ALL</option>
            {SECTORS.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </label>
        <AmountInput label="MCAP ≥" value={f.mcapMin} onCommit={(v) => set({ mcapMin: v })} />
        <AmountInput label="≤" value={f.mcapMax} onCommit={(v) => set({ mcapMax: v })} />
        <AmountInput label="P/E <" value={f.peMax} onCommit={(v) => set({ peMax: v })} width={44} />
        <AmountInput
          label="CHG% ≥"
          value={f.chgMin}
          onCommit={(v) => set({ chgMin: v })}
          width={44}
        />
        <AmountInput label="≤" value={f.chgMax} onCommit={(v) => set({ chgMax: v })} width={44} />
        <AmountInput label="VOL ≥" value={f.volMin} onCommit={(v) => set({ volMin: v })} />
        <label>
          SORT{" "}
          <select value={f.sort} onChange={(e) => set({ sort: e.target.value as Filters["sort"] })}>
            {SORTS.map((s) => (
              <option key={s} value={s}>
                {s.toUpperCase()}
              </option>
            ))}
          </select>
        </label>
        <button className={f.asc ? "on" : ""} onClick={() => set({ asc: !f.asc })}>
          {f.asc ? "ASC" : "DESC"}
        </button>
      </div>
      <DataStatus
        meta={q.data?.meta}
        error={q.error}
        fetching={q.isFetching}
        updatedAt={q.dataUpdatedAt}
        extra={
          q.data ? (
            <span>
              {q.data.total} matches (showing {rows.length})
            </span>
          ) : null
        }
      />
      <div style={{ overflow: "auto", flex: 1 }}>
        {q.isLoading ? <Loading what="screen" /> : null}
        <table className="grid">
          <thead>
            <tr>
              <th className="l">SYMBOL</th>
              <th className="l">NAME</th>
              <th className="l">EXCH</th>
              <th>PRICE</th>
              <th className="l">CCY</th>
              <th>CHG%</th>
              <th>MCAP</th>
              <th>P/E</th>
              <th>VOLUME</th>
              <th>AVG VOL</th>
              <th>DIV%</th>
            </tr>
          </thead>
          <tbody ref={bodyRef}>
            {rows.map((r, i) => (
              <tr
                key={r.symbol}
                data-idx={i}
                className={i === sel ? "sel" : ""}
                onMouseDown={() => setSel(i)}
                onDoubleClick={() => void executeCommand(`${r.symbol} GP`, { newPanel: true })}
              >
                <td className="l amber">{r.symbol}</td>
                <td
                  className="l"
                  style={{
                    color: "var(--text)",
                    maxWidth: 240,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {r.name}
                </td>
                <td className="l dim">{r.exchange}</td>
                <td>{fmtPrice(r.price, r.symbol)}</td>
                <td className="l dim">{r.currency}</td>
                <Sgn as="td" v={r.change_pct}>
                  {fmtPct(r.change_pct)}
                </Sgn>
                <td>{fmtBig(r.market_cap)}</td>
                <td>{fmtNum(r.pe, 1)}</td>
                <td>{fmtBig(r.volume)}</td>
                <td className="dim">{fmtBig(r.avg_volume)}</td>
                <td>
                  <V>{fmtNum(r.dividend_yield, 2)}</V>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {q.data && !rows.length ? (
          <div className="empty">No matches — loosen the filters.</div>
        ) : null}
      </div>
    </>
  );
}

export function registerEQS(): void {
  registerFunction({
    code: "EQS",
    name: "Equity screener",
    description: "Screen by region, sector, market cap, P/E, % change and volume (Yahoo screener)",
    ticker: "none",
    syntax:
      "EQS [REGION=XX] [SECTOR=NAME] [MCAP>10B] [MCAP<..] [PE<25] [CHG>2] [CHG<-2] [VOL>1M] [SORT=MCAP|CHG|VOLUME|PE] [ASC]",
    examples: [
      "EQS",
      "EQS REGION=DK",
      "EQS SECTOR=TECHNOLOGY PE<20 SORT=CHG",
      "EQS REGION=JP CHG>3",
    ],
    category: "Research",
    sectors: ["EQUITY"],
    menu: ["Screening"],
    args: [
      matching(
        "filter",
        /^(REGION=[A-Z]{2}|SECTOR=\S+|MCAP[<>]-?\d+(\.\d+)?[KMBT]?|PE<-?\d+(\.\d+)?[KMBT]?|CHG[<>]-?\d+(\.\d+)?[KMBT]?|VOL>-?\d+(\.\d+)?[KMBT]?|SORT=(MCAP|CHG|VOLUME|PE)|ASC)$/,
        "REGION=XX SECTOR=NAME MCAP>10B MCAP<.. PE<25 CHG>2 CHG<-2 VOL>1M SORT=MCAP|CHG|VOLUME|PE ASC",
        "screen filters",
      ),
    ],
    actions: [],
    component: EQS,
  });
}
