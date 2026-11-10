/**
 * ECO — economic calendar from official calendars (SPEC §8). Columns: date/time (CPH),
 * country, event, period, actual, survey (N.A.: no official consensus), prior, revised (N.A.),
 * importance. Filters: country, importance, date range. The next event is highlighted with a
 * countdown. A time marked `*` is the issuer's standard release time (the calendar gives the
 * date only).
 */
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useApi } from "@/core/data";
import { executeCommand } from "@/core/executor";
import { usePanelKeys } from "@/core/keys";
import { oneOf, registerFunction, type PanelProps } from "@/core/registry";
import { DataStatus, Loading } from "@/components/DataStatus";
import { fmtCountdown, fmtDate, fmtDayHeader, fmtHM, NA } from "@/lib/format";
import { cycle, serverNow } from "@/functions/news/model";
import {
  applyFilter,
  COUNTRIES,
  COUNTRY_LABEL,
  FETCH_DAYS_AHEAD,
  FETCH_DAYS_BACK,
  filterFromArgs,
  FILTER_TOKENS,
  fmtValue,
  IMPORTANCE,
  importanceDots,
  nextEvent,
  RANGES,
  type EcoEvent,
  type EcoFilter,
  type EcoResponse,
} from "./model";

const SURVEY_TIP = "No official source publishes consensus forecasts (survey N.A.)";
const REVISED_TIP = "Revisions need data vintages, which are not kept (revised N.A.)";
const STD_TIP =
  "* the calendar gives the date only; the time is the issuer's standard release time";

function Value({ e, v }: { e: EcoEvent; v: number | null | undefined }) {
  if (v === null || v === undefined) {
    return (
      <span className="na" title={e.note ?? undefined}>
        {NA}
      </span>
    );
  }
  return <span>{fmtValue(v, e.unit, e.digits)}</span>;
}

function Row({
  e,
  idx,
  sel,
  next,
  now,
  onClick,
}: {
  e: EcoEvent;
  idx: number;
  sel: boolean;
  next: boolean;
  now: number;
  onClick: () => void;
}) {
  const cls = [sel ? "sel" : "", next ? "eco-next" : "", e.released ? "" : "eco-upcoming"]
    .filter(Boolean)
    .join(" ");
  const src = e.series_source ? ` · values: ${e.series_source} (${e.series})` : "";
  return (
    <tr
      className={cls}
      data-idx={idx}
      data-testid="eco-row"
      onClick={onClick}
      title={`${e.source}${src}${e.tentative ? " · tentative date" : ""}`}
    >
      <td className="l">
        {fmtHM(e.time)}
        {e.time_kind === "standard" ? <span title={STD_TIP}>*</span> : null}
        {e.tentative ? <span className="dim"> (t)</span> : null}
      </td>
      <td className="l">{e.country}</td>
      <td className="l eco-event">
        {e.event}
        {next ? (
          <span className="amber" data-testid="eco-countdown">
            {" "}
            in {fmtCountdown(Date.parse(e.time) - now)}
          </span>
        ) : null}
      </td>
      <td className="l">{e.period ?? <span className="na">{NA}</span>}</td>
      <td className={e.actual !== null && e.actual !== undefined ? "amber" : ""}>
        <Value e={e} v={e.actual} />
      </td>
      <td>
        <span className="na" title={SURVEY_TIP}>
          {NA}
        </span>
      </td>
      <td>
        <Value e={e} v={e.prior} />
      </td>
      <td>
        <span className="na" title={REVISED_TIP}>
          {NA}
        </span>
      </td>
      <td className="l amber" title={`importance ${e.importance} of 3`}>
        {importanceDots(e.importance)}
      </td>
    </tr>
  );
}

function ECO({ id, panel }: PanelProps) {
  const q = useApi<EcoResponse>(
    "/eco",
    { days_back: FETCH_DAYS_BACK, days_ahead: FETCH_DAYS_AHEAD },
    { refetchMs: 120_000, staleMs: 60_000 },
  );
  const argKey = panel.args.join(" ");
  const [filter, setFilter] = useState<EcoFilter>(() => filterFromArgs(panel.args));
  useEffect(() => setFilter(filterFromArgs(argKey ? argKey.split(" ") : [])), [argKey]);
  const [sel, setSel] = useState(0);
  const [tick, setTick] = useState(0);
  const bodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 1000); // the countdown
    return () => clearInterval(t);
  }, []);
  const now = useMemo(
    () => serverNow(q.data?.now, q.dataUpdatedAt),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [q.data?.now, q.dataUpdatedAt, tick],
  );
  const all = q.data?.data;
  const events = useMemo(() => applyFilter(all ?? [], filter, now), [all, filter, now]);
  const next = nextEvent(events, now);
  const cur = events[Math.min(sel, events.length - 1)];
  const noSource = filter.country !== null && (q.data?.no_source ?? []).includes(filter.country);
  const failed = (q.data?.sources ?? []).filter((s) => !s.ok);

  useEffect(() => {
    bodyRef.current?.querySelector(`[data-idx="${sel}"]`)?.scrollIntoView({ block: "nearest" });
  }, [sel]);
  const setF = (f: EcoFilter) => {
    setFilter(f);
    setSel(0);
  };
  usePanelKeys(id, "ECO", (a) => {
    if (a === "down") setSel((s) => Math.min(events.length - 1, s + 1));
    else if (a === "up") setSel((s) => Math.max(0, s - 1));
    else if (a === "country") setF({ ...filter, country: cycle(COUNTRIES, filter.country) });
    else if (a === "importance")
      setF({
        ...filter,
        minImportance: filter.minImportance === 1 ? 2 : filter.minImportance === 2 ? 3 : 1,
      });
    else if (a === "range") {
      const i = RANGES.findIndex((r) => r.token === filter.range);
      setF({ ...filter, range: RANGES[(i + 1) % RANGES.length]!.token });
    } else if (a === "next") {
      if (next) setSel(events.indexOf(next)); // nothing ahead: still ours, not typed
    } else if (a === "open") {
      // Enter → ECST history of the line's series (SPEC §8); unmapped lines have none
      if (cur?.indicator)
        void executeCommand(`ECST ${cur.indicator.toUpperCase()}`, { newPanel: true });
    } else if (a === "refresh") void q.refetch();
    else return false;
    return true;
  });

  if (q.isLoading) return <Loading what="economic calendar" />;
  const imp = IMPORTANCE.find((x) => x.min === filter.minImportance);
  const range = RANGES.find((r) => r.token === filter.range)!;
  let lastDay = "";
  return (
    <div className="eco" data-testid="eco">
      <DataStatus
        meta={q.data?.meta}
        error={q.error}
        fetching={q.isFetching}
        updatedAt={q.dataUpdatedAt}
        extra={
          failed.length ? (
            <span
              className="down"
              title={failed.map((s) => `${s.label}: ${s.detail ?? "failed"}`).join("\n")}
              data-testid="eco-failed"
            >
              {failed.map((s) => s.label).join(", ")} FAILED
            </span>
          ) : null
        }
      />
      <div className="toolbar eco-toolbar" data-testid="eco-toolbar">
        <span className="amber">ECONOMIC CALENDAR</span>
        <span className={filter.country ? "amber" : "dim"}>
          COUNTRY (c) {filter.country ? COUNTRY_LABEL[filter.country] : "ALL"}
        </span>
        <span className={imp ? "amber" : "dim"}>IMPORTANCE (i) {imp ? imp.label : "ALL"}</span>
        <span className="amber">RANGE (d) {range.label}</span>
        <span className="dim">{events.length} events</span>
        <span className="eco-nextbox" data-testid="eco-next">
          {next ? (
            <>
              NEXT (n){" "}
              <b className="amber">
                {next.country} {next.event}
              </b>{" "}
              {fmtDate(next.time)} {fmtHM(next.time)} · in{" "}
              <b className="amber">{fmtCountdown(Date.parse(next.time) - now)}</b>
            </>
          ) : (
            <span className="dim">NEXT: none in this range</span>
          )}
        </span>
      </div>
      {noSource ? (
        <div className="eco-empty" data-testid="eco-nosource">
          {COUNTRY_LABEL[filter.country!]}: no free official release calendar is connected yet —
          N.A. (connected: US via FRED/BEA/Federal Reserve, euro area via Eurostat/ECB, Denmark via
          Statistics Denmark)
        </div>
      ) : null}
      <div className="eco-body" ref={bodyRef}>
        <table className="grid eco-table">
          <thead>
            <tr>
              <th className="l" title="Your time zone (Settings; Copenhagen by default)">
                TIME
              </th>
              <th className="l">C</th>
              <th className="l">EVENT</th>
              <th className="l">PERIOD</th>
              <th>ACTUAL</th>
              <th title={SURVEY_TIP}>SURVEY</th>
              <th>PRIOR</th>
              <th title={REVISED_TIP}>REVISED</th>
              <th className="l">IMP</th>
            </tr>
          </thead>
          <tbody>
            {events.map((e, i) => {
              const day = fmtDate(e.time);
              const header = day !== lastDay;
              lastDay = day;
              return (
                <Fragment key={e.id}>
                  {header ? (
                    <tr className="grp" data-testid="eco-day">
                      <td className="l" colSpan={9}>
                        {fmtDayHeader(e.time)}
                      </td>
                    </tr>
                  ) : null}
                  <Row
                    e={e}
                    idx={i}
                    sel={e === cur}
                    next={e === next}
                    now={now}
                    onClick={() => setSel(i)}
                  />
                </Fragment>
              );
            })}
          </tbody>
        </table>
        {!events.length && !noSource ? (
          <div className="eco-empty">No releases in this range for this filter.</div>
        ) : null}
      </div>
      <div className="eco-foot dim">
        * standard release time (the calendar gives the date only) · (t) tentative · survey, revised
        N.A.: no official consensus, no vintages kept
      </div>
    </div>
  );
}

export function registerECO(): void {
  registerFunction({
    code: "ECO",
    name: "Economic calendar",
    description:
      "Official release calendars (BEA, Federal Reserve, FRED dates for BLS/Census, Eurostat, " +
      "ECB, Statistics Denmark): time in your zone, actual and prior from the official series, " +
      "survey N.A.; country, importance and date-range filters; countdown to the next release",
    ticker: "none",
    syntax: `ECO [${FILTER_TOKENS.join("|")}]…`,
    examples: ["ECO", "ECO DK", "ECO US HIGH", "ECO TODAY"],
    category: "Macro",
    sectors: ["GOVT", "M-MKT"],
    menu: ["Economics"],
    args: [
      oneOf("country", COUNTRIES, "country filter"),
      oneOf(
        "importance",
        IMPORTANCE.map((x) => x.token),
        "minimum importance",
      ),
      oneOf(
        "range",
        RANGES.map((x) => x.token),
        "date range",
      ),
    ],
    actions: [],
    component: ECO,
    title: (p) => (p.args.length ? `Economic calendar · ${p.args.join(" ")}` : "Economic calendar"),
  });
}
