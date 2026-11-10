/**
 * ECST — economic statistics (SPEC §8): the history of a series behind an ECO line. Left: the
 * mapped indicators (data/symbology/eco_events.csv); right: the selected one's chart, its last
 * observations, and the last/next release from the official calendars. Values are the official
 * series after the line's transform (level, % m/m, % y/y, change); STALE is frequency-aware.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useApi } from "@/core/data";
import { usePanelKeys } from "@/core/keys";
import { matching, registerFunction, type PanelProps } from "@/core/registry";
import { DataStatus, Loading } from "@/components/DataStatus";
import { LineChart } from "@/components/LineChart";
import { fmtCountdown, fmtDate, fmtHM, fmtNum, fmtSigned, NA } from "@/lib/format";
import { token } from "@/theme/tokens";
import { serverNow } from "@/functions/news/model";
import { COUNTRY_LABEL, fmtValue, importanceDots, type Country } from "./model";
import {
  ECST_RANGES,
  inRange,
  recent,
  sortIndicators,
  toSeconds,
  type EcoHistory,
  type EcoIndicatorsResponse,
  type EcstRange,
} from "./series";

const FREQ_LABEL: Record<string, string> = {
  D: "daily",
  W: "weekly",
  M: "monthly",
  Q: "quarterly",
  A: "annual",
};

function when(iso: string | null | undefined): string {
  return iso ? `${fmtDate(iso)} ${fmtHM(iso)}` : NA;
}

function ECST({ id, panel }: PanelProps) {
  const list = useApi<EcoIndicatorsResponse>("/eco/indicators", undefined, {
    staleMs: 3_600_000,
  });
  const indicators = useMemo(() => sortIndicators(list.data?.data ?? []), [list.data]);
  const argKey = (panel.args[0] ?? "").toLowerCase();
  const [key, setKey] = useState<string | undefined>(argKey || undefined);
  useEffect(() => setKey(argKey || undefined), [argKey]);
  const selected = key ?? indicators[0]?.key;
  const listRef = useRef<HTMLDivElement>(null);

  const path = selected ? `/eco/indicators/${encodeURIComponent(selected)}` : null;
  const q = useApi<EcoHistory>(path, undefined, { refetchMs: 15 * 60_000, staleMs: 5 * 60_000 });
  const [range, setRange] = useState<EcstRange>("10Y");
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 1000); // next-release countdown
    return () => clearInterval(t);
  }, []);
  const h = q.data && q.data.indicator.key === selected ? q.data : undefined;
  const now = useMemo(
    () => serverNow(h?.now, q.dataUpdatedAt),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [h?.now, q.dataUpdatedAt, tick],
  );
  const shown = useMemo(() => (h ? inRange(h.data, range) : []), [h, range]);
  const rows = useMemo(() => (h ? recent(h.data, 12) : []), [h]);
  const idx = indicators.findIndex((i) => i.key === selected);

  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-key="${selected}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  usePanelKeys(id, "ECST", (a) => {
    if (a === "down" || a === "up") {
      const n = indicators.length;
      if (!n) return true;
      const next = a === "down" ? Math.min(n - 1, idx + 1) : Math.max(0, idx - 1);
      setKey(indicators[next]!.key);
    } else if (a.startsWith("range-")) {
      const r = ECST_RANGES[Number(a.slice(6)) - 1];
      if (r) setRange(r.token);
    } else if (a === "refresh") void q.refetch();
    else return false;
    return true;
  });

  if (list.isLoading) return <Loading what="economic series" />;
  const ind = h?.indicator ?? indicators[idx];
  const unknown = argKey && !list.isLoading && !indicators.some((i) => i.key === argKey);
  const last = rows[0];
  const color = token("amber");
  let lastCountry = "";
  return (
    <div className="ecst" data-testid="ecst">
      <DataStatus
        meta={h?.meta}
        error={q.error ?? list.error}
        fetching={q.isFetching}
        updatedAt={q.dataUpdatedAt}
      />
      {unknown ? (
        <div className="eco-empty" data-testid="ecst-unknown">
          No ECST series {argKey.toUpperCase()}: pick one from the list (or press Enter on an ECO
          line).
        </div>
      ) : null}
      <div className="ecst-body">
        <div className="ecst-list" ref={listRef} data-testid="ecst-list">
          {indicators.map((i) => {
            const header = i.country !== lastCountry;
            lastCountry = i.country;
            return (
              <div key={i.key}>
                {header ? (
                  <div className="ecst-group">
                    {COUNTRY_LABEL[i.country as Country] ?? i.country}
                  </div>
                ) : null}
                <div
                  className={`ecst-item${i.key === selected ? " sel" : ""}`}
                  data-key={i.key}
                  data-testid="ecst-item"
                  onClick={() => setKey(i.key)}
                >
                  <span className="amber">{importanceDots(i.importance)}</span> {i.event}
                </div>
              </div>
            );
          })}
        </div>
        <div className="ecst-detail" data-testid="ecst-detail">
          {ind ? (
            <>
              <div className="ecst-head">
                <b className="amber" data-testid="ecst-title">
                  {ind.country} {ind.event}
                </b>{" "}
                <span className="dim">
                  · {ind.transform_label}
                  {h?.frequency ? ` · ${FREQ_LABEL[h.frequency] ?? h.frequency}` : ""} ·{" "}
                  {ind.series}
                </span>
              </div>
              <div className="ecst-facts" data-testid="ecst-facts">
                <span>
                  LAST{" "}
                  <b className="amber" data-testid="ecst-last">
                    {last ? fmtValue(last.obs.value, ind.unit, ind.digits) : NA}
                  </b>{" "}
                  {last ? last.obs.period : ""}
                </span>
                <span>CHG {last && last.chg !== null ? fmtSigned(last.chg, ind.digits) : NA}</span>
                <span title="When the source last updated the series">
                  UPDATED {when(h?.updated)}
                </span>
                <span title={`Release dates: ${ind.calendar}`}>
                  LAST RELEASE {when(h?.last_release)}
                </span>
                <span data-testid="ecst-next" title={`Release dates: ${ind.calendar}`}>
                  NEXT{" "}
                  {h?.next_release ? (
                    <>
                      {when(h.next_release)} · in{" "}
                      <b className="amber">{fmtCountdown(Date.parse(h.next_release) - now)}</b>
                    </>
                  ) : (
                    <span className="na" title="Not in the official calendars' next 30 days">
                      {NA}
                    </span>
                  )}
                </span>
              </div>
              <div className="toolbar" data-testid="ecst-ranges">
                {ECST_RANGES.map((r, i) => (
                  <button
                    key={r.token}
                    className={r.token === range ? "on" : ""}
                    onClick={() => setRange(r.token)}
                  >
                    {i + 1}) {r.token}
                  </button>
                ))}
                <span className="dim">{shown.length} observations</span>
              </div>
              {q.isLoading ? (
                <Loading what={ind.event} />
              ) : shown.length ? (
                <div className="ecst-chart" data-testid="ecst-chart">
                  <LineChart
                    key={`${selected}-${range}`}
                    time
                    x={shown.map((o) => toSeconds(o.date))}
                    series={[
                      {
                        label: `${ind.event} (${ind.transform_label})`,
                        values: shown.map((o) => o.value),
                        color,
                        width: 2,
                      },
                    ]}
                    yFormat={(v) => fmtNum(v, ind.digits)}
                  />
                </div>
              ) : (
                <div className="eco-empty">No observations ({NA}).</div>
              )}
              <div className="ecst-table">
                <table className="grid">
                  <thead>
                    <tr>
                      <th className="l">PERIOD</th>
                      <th>VALUE</th>
                      <th>CHG</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(({ obs, chg }) => (
                      <tr key={obs.period} data-testid="ecst-row">
                        <td className="l">{obs.period}</td>
                        <td>{fmtValue(obs.value, ind.unit, ind.digits)}</td>
                        <td>
                          {chg === null ? (
                            <span className="na">{NA}</span>
                          ) : (
                            fmtSigned(chg, ind.digits)
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : (
            <div className="eco-empty">No series selected.</div>
          )}
        </div>
      </div>
    </div>
  );
}

export function registerECST(): void {
  registerFunction({
    code: "ECST",
    name: "Economic statistics",
    description:
      "History of the official series behind an ECO line (FRED in memory, Eurostat, ECB, " +
      "Statistics Denmark): chart 2Y/5Y/10Y/MAX, last observations, last and next release, " +
      "frequency-aware STALE",
    ticker: "none",
    syntax: "ECST [indicator]",
    examples: ["ECST", "ECST US-CPI-YOY", "ECST DK-CPI-YOY"],
    category: "Macro",
    sectors: ["GOVT", "M-MKT"],
    menu: ["Economics"],
    args: [matching("indicator", /^[a-z0-9-]+$/i, "us-cpi-yoy", "indicator key (ECST list)")],
    actions: [],
    component: ECST,
    title: (p) =>
      p.args.length ? `Economic statistics · ${p.args[0]!.toUpperCase()}` : "Economic statistics",
  });
}
