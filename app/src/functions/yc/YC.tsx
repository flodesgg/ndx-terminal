import { useMemo } from "react";
import type { Schemas } from "@/core/api";
import { useApi } from "@/core/data";
import { registerFunction } from "@/core/registry";
import { DataStatus, Loading } from "@/components/DataStatus";
import { LineChart } from "@/components/LineChart";
import { fmtPct, fmtSigned, fmtYield } from "@/lib/format";
import { token } from "@/theme/tokens";
import { Sgn, V } from "@/components/V";

type Resp = Schemas["YieldCurveResponse"];

const bp = (a: number | null | undefined, b: number | null | undefined) =>
  a != null && b != null ? Math.round((a - b) * 100) : null;

function spread(r: Resp, long: string, short: string, which: "current" | "month_ago" | "year_ago") {
  const c = r[which];
  if (!c) return null;
  const li = r.tenors.indexOf(long);
  const si = r.tenors.indexOf(short);
  const l = c.yields[li];
  const s = c.yields[si];
  return l != null && s != null ? Math.round((l - s) * 100) : null;
}

function YC() {
  const q = useApi<Resp>("/yields/us", undefined, { refetchMs: 3600_000, staleMs: 600_000 });
  const d = q.data;
  const x = useMemo(() => (d ? d.tenors.map((_, i) => i) : []), [d]);
  const series = useMemo(() => {
    if (!d) return [];
    const out = [
      { label: `Now ${d.current.date}`, values: d.current.yields, color: token("amber"), width: 2 },
    ];
    if (d.month_ago)
      out.push({
        label: `1M ago ${d.month_ago.date}`,
        values: d.month_ago.yields,
        color: token("link"),
        width: 1.5,
      });
    if (d.year_ago)
      out.push({
        label: `1Y ago ${d.year_ago.date}`,
        values: d.year_ago.yields,
        color: token("value-dim"),
        width: 1.5,
      });
    return out;
  }, [d]);

  if (q.isLoading) return <Loading what="yield curve" />;
  return (
    <>
      <DataStatus
        meta={d?.meta}
        error={q.error}
        fetching={q.isFetching}
        updatedAt={q.dataUpdatedAt}
      />
      {d ? (
        <>
          <div style={{ flex: 1, minHeight: 180, padding: 4 }}>
            <LineChart
              x={x}
              series={series}
              categories={d.tenors}
              yFormat={(v) => fmtPct(v, 2, false)}
            />
          </div>
          <div style={{ overflow: "auto", maxHeight: "45%" }}>
            <table className="grid">
              <thead>
                <tr>
                  <th className="l">TENOR</th>
                  <th>NOW</th>
                  <th>1M AGO</th>
                  <th>Δ1M bp</th>
                  <th>1Y AGO</th>
                  <th>Δ1Y bp</th>
                </tr>
              </thead>
              <tbody>
                {d.tenors.map((t, i) => {
                  const now = d.current.yields[i];
                  const m = d.month_ago?.yields[i];
                  const y = d.year_ago?.yields[i];
                  return (
                    <tr key={t}>
                      <td className="l amber">{t}</td>
                      <td>
                        <V>{fmtYield(now)}</V>
                      </td>
                      <td className="dim">
                        <V>{fmtYield(m)}</V>
                      </td>
                      <Sgn as="td" v={bp(now, m)}>
                        {fmtSigned(bp(now, m), 0)}
                      </Sgn>
                      <td className="dim">
                        <V>{fmtYield(y)}</V>
                      </td>
                      <Sgn as="td" v={bp(now, y)}>
                        {fmtSigned(bp(now, y), 0)}
                      </Sgn>
                    </tr>
                  );
                })}
                {[
                  ["2s10s", "10Yr", "2Yr"],
                  ["3m10y", "10Yr", "3Mo"],
                ].map(([label, l, s]) => {
                  const now = spread(d, l!, s!, "current");
                  const m = spread(d, l!, s!, "month_ago");
                  const y = spread(d, l!, s!, "year_ago");
                  return (
                    <tr key={label}>
                      <td className="l cyan">{label} bp</td>
                      <Sgn as="td" v={now}>
                        {fmtSigned(now, 0)}
                      </Sgn>
                      <td className="dim">
                        <V>{fmtSigned(m, 0)}</V>
                      </td>
                      <Sgn as="td" v={now != null && m != null ? now - m : null}>
                        {fmtSigned(now != null && m != null ? now - m : null, 0)}
                      </Sgn>
                      <td className="dim">
                        <V>{fmtSigned(y, 0)}</V>
                      </td>
                      <Sgn as="td" v={now != null && y != null ? now - y : null}>
                        {fmtSigned(now != null && y != null ? now - y : null, 0)}
                      </Sgn>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </>
  );
}

export function registerYC(): void {
  registerFunction({
    code: "YC",
    name: "US yield curve",
    description: "Treasury par yield curve now vs 1 month and 1 year ago, 2s10s and 3m10y spreads",
    ticker: "none",
    syntax: "YC",
    examples: ["YC"],
    category: "Macro",
    sectors: ["GOVT"],
    menu: ["Rates"],
    args: [],
    actions: [],
    component: YC,
  });
}
