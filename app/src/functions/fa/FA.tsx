import { useMemo, useRef } from "react";
import { api, errorMessage, type Schemas } from "@/core/api";
import { useApi } from "@/core/data";
import { usePanelKeys } from "@/core/keys";
import { useWorkspace } from "@/core/layout/store";
import { oneOf, registerFunction, type PanelProps } from "@/core/registry";
import { DataStatus, Loading } from "@/components/DataStatus";
import { NA, fmtBig, fmtNum, fmtPct, fmtSigned } from "@/lib/format";
import { Sgn } from "@/components/V";

type Resp = Schemas["FinancialsResponse"];
type StatementName = Schemas["Statement"]["name"];

const TABS: { key: StatementName; label: string }[] = [
  { key: "income", label: "INCOME" },
  { key: "balance", label: "BALANCE" },
  { key: "cashflow", label: "CASH FLOW" },
  { key: "ratios", label: "RATIOS" },
];

/** Ratios shown as plain multiples; all others are percentages. */
const PLAIN_RATIOS = new Set(["debt_to_equity", "current_ratio"]);

function fmtCell(tab: StatementName, key: string, v: number | null | undefined): string {
  if (v == null) return NA;
  if (tab === "ratios") return PLAIN_RATIOS.has(key) ? fmtNum(v, 2) : fmtPct(v, 2, false);
  if (key === "DilutedEPS") return fmtNum(v, 2);
  return fmtBig(v, 2);
}

function FA({ id, panel, update }: PanelProps) {
  const symbol = panel.ticker ?? "";
  const quarterly = panel.args.includes("Q");
  const tabArg = panel.args.find((a) => TABS.some((t) => t.key.toUpperCase() === a));
  const tab: StatementName = (tabArg?.toLowerCase() as StatementName | undefined) ?? "income";
  const period = quarterly ? "quarterly" : "annual";
  const q = useApi<Resp>(
    `/financials/${encodeURIComponent(symbol)}`,
    { period },
    { staleMs: 30 * 60_000 },
  );
  const notify = useWorkspace((s) => s.notify);
  const ref = useRef<HTMLDivElement>(null);

  const set = (next: { tab?: StatementName; quarterly?: boolean }) => {
    const t = next.tab ?? tab;
    const qq = next.quarterly ?? quarterly;
    update({ ...panel, args: [t.toUpperCase(), ...(qq ? ["Q"] : [])] });
  };

  const exportCsv = async () => {
    try {
      const r = await api.post<Schemas["ExportResult"]>(
        `/financials/${encodeURIComponent(symbol)}/export?period=${period}`,
      );
      notify(`Exported ${r.rows} rows → ${r.path}`);
    } catch (e) {
      notify(`Export failed: ${errorMessage(e)}`, "error");
    }
  };

  usePanelKeys(id, "FA", (a) => {
    const idx = a.startsWith("tab-") ? Number(a.slice(4)) - 1 : -1;
    if (idx >= 0 && idx < TABS.length) set({ tab: TABS[idx]!.key });
    else if (a === "annual") set({ quarterly: false });
    else if (a === "quarterly") set({ quarterly: true });
    else if (a === "export") void exportCsv();
    else if (a === "down") ref.current?.scrollBy({ top: 40 });
    else if (a === "up") ref.current?.scrollBy({ top: -40 });
    else return false;
    return true;
  });

  const statement = useMemo(() => q.data?.statements.find((s) => s.name === tab), [q.data, tab]);
  if (q.isLoading) return <Loading what={`${symbol} financials`} />;
  const periods = q.data?.periods ?? [];
  const cols = periods.map((_, i) => periods.length - 1 - i); // latest first (SPEC §8)

  return (
    <>
      <DataStatus
        meta={q.data?.meta}
        error={q.error}
        fetching={q.isFetching}
        updatedAt={q.dataUpdatedAt}
        extra={q.data?.currency ? <span>CCY {q.data.currency}</span> : null}
      />
      <div className="toolbar">
        <div className="tabs">
          {TABS.map((t, i) => (
            <button
              key={t.key}
              className={t.key === tab ? "on" : ""}
              title={`key ${i + 1}`}
              onClick={() => set({ tab: t.key })}
            >
              {t.label}
            </button>
          ))}
        </div>
        <span className="sep" />
        <button className={!quarterly ? "on" : ""} onClick={() => set({ quarterly: false })}>
          ANNUAL
        </button>
        <button className={quarterly ? "on" : ""} onClick={() => set({ quarterly: true })}>
          QUARTERLY
        </button>
        <span className="sep" />
        <button onClick={() => void exportCsv()}>EXPORT CSV</button>
      </div>
      <div ref={ref} style={{ overflow: "auto", flex: 1 }}>
        {statement && statement.lines.length ? (
          <table className="grid">
            <thead>
              <tr>
                <th className="l">{statement.name.toUpperCase()}</th>
                {cols.map((i) => (
                  <th key={periods[i]}>{periods[i]}</th>
                ))}
                <th title="Latest vs the period before it">Δ LATEST</th>
              </tr>
            </thead>
            <tbody>
              {statement.lines.map((line) => {
                const vals = line.values;
                const last = vals[vals.length - 1];
                const prev = vals[vals.length - 2];
                const delta =
                  tab === "ratios"
                    ? last != null && prev != null
                      ? last - prev
                      : null
                    : last != null && prev != null && prev !== 0
                      ? ((last - prev) / Math.abs(prev)) * 100
                      : null;
                return (
                  <tr key={line.key} data-testid="fa-line">
                    <td className="l amber">{line.label}</td>
                    {cols.map((i) => {
                      const v = vals[i];
                      return (
                        <td key={i} className={v != null && v < 0 ? "down" : ""}>
                          {fmtCell(tab, line.key, v)}
                        </td>
                      );
                    })}
                    <Sgn as="td" v={delta}>
                      {tab === "ratios" ? fmtSigned(delta, 2) : fmtPct(delta)}
                    </Sgn>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : q.data ? (
          <div className="empty">No {tab} data reported for this period type.</div>
        ) : q.error ? (
          <div className="empty" data-testid="fa-na">
            {NA} — no free source covers {symbol}&apos;s statements: SEC EDGAR covers US filers (and
            foreign filers of 20-F/40-F); others need the opt-in yfinance source (PDF).
          </div>
        ) : null}
      </div>
      <div className="ds hint">
        1-4 statement · A annual · Q quarterly · E export CSV to ~/Downloads · latest period first ·
        Δ LATEST = change vs the period before
      </div>
    </>
  );
}

export function registerFA(): void {
  registerFunction({
    code: "FA",
    name: "Financial statements",
    description: "Income, balance sheet, cash flow (annual/quarterly), ratios, CSV export",
    ticker: "required",
    syntax: "<TICKER> FA [INCOME|BALANCE|CASHFLOW|RATIOS] [Q]",
    examples: ["AAPL US EQUITY FA", "MSFT US EQUITY FA RATIOS", "NOVOB DC EQUITY FA BALANCE Q"],
    category: "Research",
    sectors: ["EQUITY"],
    menu: ["Financials"],
    args: [
      oneOf("statement", ["INCOME", "BALANCE", "CASHFLOW", "RATIOS"], "default INCOME"),
      oneOf("period", ["Q"], "quarterly (default annual)"),
    ],
    actions: [],
    component: FA,
    title: (p) => `Financials ${p.args.includes("Q") ? "quarterly" : "annual"}`,
  });
}
