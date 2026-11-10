import { useEffect, useMemo, useRef, useState } from "react";
import type { Schemas } from "@/core/api";
import { useApi } from "@/core/data";
import { usePanelKeys } from "@/core/keys";
import { registerFunction, type PanelProps } from "@/core/registry";
import { DataStatus, Loading } from "@/components/DataStatus";
import { fmtBig, fmtPrice } from "@/lib/format";
import { openExternal } from "@/lib/open";
import { V } from "@/components/V";

type Filings = Schemas["FilingsResponse"];
type Insiders = Schemas["InsidersResponse"];

const FORM_FILTERS: { key: string; label: string; match: (f: string) => boolean }[] = [
  { key: "0", label: "ALL", match: () => true },
  { key: "1", label: "10-K", match: (f) => f.startsWith("10-K") || f === "20-F" },
  { key: "2", label: "10-Q", match: (f) => f.startsWith("10-Q") },
  { key: "3", label: "8-K", match: (f) => f.startsWith("8-K") || f === "6-K" },
  { key: "4", label: "FORM 4", match: (f) => f === "4" || f === "3" || f === "5" },
  { key: "5", label: "PROXY", match: (f) => f.includes("14A") },
];

function useListKeys(
  id: string,
  fn: "CF" | "INS",
  n: number,
  onEnter: (i: number) => void,
  extra?: (action: string) => boolean,
) {
  const [sel, setSel] = useState(0);
  usePanelKeys(id, fn, (a) => {
    if (extra?.(a)) return true;
    if (a === "down") setSel((s) => Math.min(n - 1, s + 1));
    else if (a === "up") setSel((s) => Math.max(0, s - 1));
    else if (a === "open") onEnter(sel);
    else return false;
    return true;
  });
  return [sel, setSel] as const;
}

function CF({ id, panel }: PanelProps) {
  const symbol = panel.ticker ?? "";
  const q = useApi<Filings>(`/filings/${encodeURIComponent(symbol)}`, undefined, {
    staleMs: 600_000,
  });
  const [filter, setFilter] = useState(0);
  const rows = useMemo(
    () => (q.data?.data ?? []).filter((f) => FORM_FILTERS[filter]!.match(f.form)),
    [q.data, filter],
  );
  const [sel, setSel] = useListKeys(
    id,
    "CF",
    rows.length,
    (i) => rows[i] && void openExternal(rows[i].url),
    (a) => {
      const idx = FORM_FILTERS.findIndex((f) => `filter-${f.key}` === a);
      if (idx < 0) return false;
      setFilter(idx);
      setSel(0);
      return true;
    },
  );
  const body = useRef<HTMLTableSectionElement>(null);
  useEffect(() => {
    body.current?.querySelector(`[data-idx="${sel}"]`)?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  if (q.isLoading) return <Loading what={`${symbol} filings`} />;
  return (
    <>
      <DataStatus
        meta={q.data?.meta}
        error={q.error}
        fetching={q.isFetching}
        updatedAt={q.dataUpdatedAt}
      />
      <div className="toolbar">
        {FORM_FILTERS.map((f, i) => (
          <button key={f.key} className={i === filter ? "on" : ""} onClick={() => setFilter(i)}>
            {f.key} {f.label}
          </button>
        ))}
        <span className="dim">{rows.length} filings</span>
      </div>
      <div style={{ overflow: "auto", flex: 1 }}>
        <table className="grid">
          <thead>
            <tr>
              <th className="l">DATE</th>
              <th className="l">FORM</th>
              <th className="l">DESCRIPTION</th>
              <th className="l">LINK</th>
            </tr>
          </thead>
          <tbody ref={body}>
            {rows.map((f, i) => (
              <tr
                key={`${f.url}-${i}`}
                data-idx={i}
                className={i === sel ? "sel" : ""}
                onMouseDown={() => setSel(i)}
                onDoubleClick={() => void openExternal(f.url)}
              >
                <td className="l dim">{f.date}</td>
                <td className="l amber">{f.form}</td>
                <td className="l" style={{ color: "var(--text)" }}>
                  {f.title ?? ""}
                </td>
                <td className="l">
                  <a onClick={() => void openExternal(f.url)}>{new URL(f.url).hostname}</a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function INS({ id, panel }: PanelProps) {
  const symbol = panel.ticker ?? "";
  const q = useApi<Insiders>(`/insiders/${encodeURIComponent(symbol)}`, undefined, {
    staleMs: 600_000,
  });
  const rows = useMemo(() => q.data?.data ?? [], [q.data]);
  const [sel, setSel] = useListKeys(id, "INS", rows.length, () => undefined);
  const body = useRef<HTMLTableSectionElement>(null);
  useEffect(() => {
    body.current?.querySelector(`[data-idx="${sel}"]`)?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  const summary = useMemo(() => {
    const cutoff = Date.now() - 182 * 86400_000;
    let buys = 0;
    let sells = 0;
    for (const r of rows) {
      if (!r.date || Date.parse(r.date) < cutoff || r.value == null) continue;
      const t = (r.text ?? "").toLowerCase();
      if (t.startsWith("purchase") || t.includes("buy")) buys += r.value;
      else if (t.startsWith("sale")) sells += r.value;
    }
    return { buys, sells };
  }, [rows]);

  if (q.isLoading) return <Loading what={`${symbol} insiders`} />;
  return (
    <>
      <DataStatus
        meta={q.data?.meta}
        error={q.error}
        fetching={q.isFetching}
        updatedAt={q.dataUpdatedAt}
      />
      <div className="toolbar">
        <span>
          LAST 6M: open-market buys <span className="up">{fmtBig(summary.buys)}</span> · sales{" "}
          <span className="down">{fmtBig(summary.sells)}</span>
        </span>
        <span className="dim">
          (value as reported; grants/option exercises excluded from the sums)
        </span>
      </div>
      <div style={{ overflow: "auto", flex: 1 }}>
        <table className="grid">
          <thead>
            <tr>
              <th className="l">DATE</th>
              <th className="l">INSIDER</th>
              <th className="l">RELATION</th>
              <th className="l">TRANSACTION</th>
              <th>SHARES</th>
              <th>VALUE</th>
              <th>~PRICE</th>
              <th className="l">OWN</th>
            </tr>
          </thead>
          <tbody ref={body}>
            {rows.map((r, i) => {
              const t = (r.text ?? "").toLowerCase();
              const cls = t.startsWith("sale") ? "down" : t.startsWith("purchase") ? "up" : "";
              return (
                <tr
                  key={i}
                  data-idx={i}
                  className={i === sel ? "sel" : ""}
                  onMouseDown={() => setSel(i)}
                >
                  <td className="l dim">{r.date}</td>
                  <td className="l amber">{r.insider}</td>
                  <td className="l dim">{r.relation ?? ""}</td>
                  <td className={`l ${cls}`}>
                    <V>{r.text}</V>
                  </td>
                  <td>{fmtBig(r.shares)}</td>
                  <td>{fmtBig(r.value)}</td>
                  <td className="dim">
                    <V>{r.shares && r.value ? fmtPrice(r.value / r.shares) : null}</V>
                  </td>
                  <td className="l dim">{r.ownership ?? ""}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {q.data && !rows.length ? (
          <div className="empty">No insider transactions reported.</div>
        ) : null}
      </div>
    </>
  );
}

export function registerFilings(): void {
  registerFunction({
    code: "CF",
    name: "SEC filings",
    description: "10-K, 10-Q, 8-K, Form 4 and other filings with links (EDGAR when configured)",
    ticker: "required",
    syntax: "<TICKER> CF",
    examples: ["AAPL US EQUITY CF", "TSLA US EQUITY CF"],
    category: "Research",
    sectors: ["EQUITY"],
    menu: ["Filings"],
    args: [],
    actions: [],
    component: CF,
  });
  registerFunction({
    code: "INS",
    name: "Insider transactions",
    description: "Insider buys/sells from Form 4 filings with 6-month totals",
    ticker: "required",
    syntax: "<TICKER> INS",
    examples: ["AAPL US EQUITY INS", "NVDA US EQUITY INS"],
    category: "Research",
    sectors: ["EQUITY"],
    menu: ["Filings"],
    args: [],
    actions: [],
    component: INS,
  });
}
