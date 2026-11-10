/**
 * GLCO — commodities monitor (SPEC §7). Front-month futures on the WEI board (only the opt-in
 * personal-use source carries them: N.A. otherwise, SPEC §6.2), and official spot prices from
 * FRED with each series' own observation date.
 */
import type { Schemas } from "@/core/api";
import { useApiMany } from "@/core/data";
import { executeCommand } from "@/core/executor";
import { registerFunction, type PanelProps } from "@/core/registry";
import { LatencyTag } from "@/components/DataStatus";
import { Sgn, V } from "@/components/V";
import { fmtChange, fmtNum, fmtPct } from "@/lib/format";
import { Board } from "@/functions/wei/WEI";
import type { WeiRow } from "@/functions/wei/rows";
import { SPOT_SERIES, spotRow } from "./spot";

type Macro = Schemas["MacroResponse"];

/** Canonical continuous front-month IDs (data/symbology/futures.csv). */
export const GLCO_ROWS: readonly WeiRow[] = [
  { symbol: "CL1 COMDTY", label: "WTI crude oil", group: "ENERGY FUTURES" },
  { symbol: "CO1 COMDTY", label: "Brent crude oil", group: "ENERGY FUTURES" },
  { symbol: "NG1 COMDTY", label: "Natural gas (Henry Hub)", group: "ENERGY FUTURES" },
  { symbol: "GC1 COMDTY", label: "Gold", group: "METALS FUTURES" },
  { symbol: "SI1 COMDTY", label: "Silver", group: "METALS FUTURES" },
  { symbol: "HG1 COMDTY", label: "Copper", group: "METALS FUTURES" },
];

const note = () => " · futures need the opt-in source (PDF); spot prices below are official";

function Spot() {
  const qs = useApiMany<Macro>(
    SPOT_SERIES.map((s) => `/macro/${s.id}`),
    undefined,
    { refetchMs: 3_600_000, staleMs: 1_800_000 },
  );
  let lastGroup = "";
  return (
    <table className="grid" data-testid="glco-spot">
      <thead>
        <tr>
          <th className="l">SPOT (FRED)</th>
          <th className="l">SERIES</th>
          <th>LAST</th>
          <th>CHG</th>
          <th>CHG%</th>
          <th className="l" title="Date of the last observation, and of the one compared with">
            AS OF
          </th>
          <th className="l">UNITS</th>
          <th className="l">SRC</th>
        </tr>
      </thead>
      <tbody>
        {SPOT_SERIES.map((s, i) => {
          const q = qs[i];
          const r = spotRow(q?.data?.data);
          const header =
            s.group !== lastGroup ? (
              <tr key={`g-${s.group}`}>
                <td
                  colSpan={8}
                  className="l"
                  style={{ background: "var(--header-hl)", color: "var(--fg)", fontWeight: 700 }}
                >
                  {s.group} SPOT
                </td>
              </tr>
            ) : null;
          lastGroup = s.group;
          return [
            header,
            <tr
              key={s.id}
              data-series={s.id}
              data-pending={q?.isPending ? "" : undefined}
              title={q?.data?.data.title ?? (q?.error ? String(q.error) : "")}
              onDoubleClick={() => void executeCommand(`ECO ${s.id}`, { newPanel: true })}
            >
              <td className="l" style={{ color: "var(--text)" }}>
                {s.label}
              </td>
              <td className="l amber">{s.id}</td>
              <td>
                {q?.isPending ? (
                  <span className="dim">…</span>
                ) : q?.error && !q.data ? (
                  <span className="down">ERR</span>
                ) : (
                  <V>{fmtNum(r.last)}</V>
                )}
              </td>
              <Sgn as="td" v={r.chg}>
                {fmtChange(r.chg, undefined, r.last)}
              </Sgn>
              <Sgn as="td" v={r.pct}>
                {fmtPct(r.pct)}
              </Sgn>
              <td className="l dim">
                <V>{r.date}</V>
                {r.prevDate ? <span> vs {r.prevDate}</span> : null}
                {q?.data?.data.frequency ? (
                  <span> · {q.data.data.frequency.toLowerCase()}</span>
                ) : null}
              </td>
              <td className="l dim">
                <V>{q?.data?.data.units}</V>
              </td>
              <td className="l">{q?.data ? <LatencyTag meta={q.data.meta} /> : null}</td>
            </tr>,
          ];
        })}
      </tbody>
    </table>
  );
}

function GLCO({ id, active }: PanelProps) {
  return (
    <>
      <div style={{ display: "flex", flexDirection: "column", flex: "1 1 60%", minHeight: 0 }}>
        <Board id={id} active={active} scope="GLCO" candidates={GLCO_ROWS} note={note} />
      </div>
      <div style={{ overflow: "auto", flex: "0 1 auto", maxHeight: "40%" }}>
        <Spot />
      </div>
    </>
  );
}

export function registerGLCO(): void {
  registerFunction({
    code: "GLCO",
    name: "Commodities monitor",
    description:
      "Energy and metals: front-month futures (opt-in source only) and official spot prices " +
      "from FRED (EIA daily, IMF monthly) with their observation dates",
    ticker: "none",
    syntax: "GLCO",
    examples: ["GLCO"],
    category: "Market",
    sectors: ["COMDTY"],
    menu: ["Commodities"],
    args: [],
    actions: [],
    component: GLCO,
  });
}
