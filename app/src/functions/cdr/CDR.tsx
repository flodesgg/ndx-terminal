/** CDR — exchange calendars (SPEC §8): DST-aware hours, holidays, early closes, session state. */
import { useEffect, useRef, useState } from "react";
import type { Schemas } from "@/core/api";
import { useApi } from "@/core/data";
import { usePanelKeys } from "@/core/keys";
import { anyText, registerFunction, type PanelProps } from "@/core/registry";
import { DataStatus, Loading } from "@/components/DataStatus";
import { NAValue } from "@/components/V";
import { fmtHM, fmtTime, NA } from "@/lib/format";
import { useNow } from "@/lib/freshness";
import {
  countdown,
  describeSpecial,
  filterVenues,
  fmtDst,
  fmtHours,
  fmtOffset,
  nextSpecial,
  stateClass,
  type Venue,
} from "./venues";

function CDR({ id, panel }: PanelProps) {
  const q = useApi<Schemas["CalendarResponse"]>("/calendar", undefined, { refetchMs: 60_000 });
  const now = useNow();
  const rows = filterVenues(q.data?.venues ?? [], panel.args);
  const [sel, setSel] = useState(0);
  const body = useRef<HTMLTableSectionElement>(null);
  const cur: Venue | undefined = rows[Math.min(sel, rows.length - 1)];
  usePanelKeys(id, "CDR", (a) => {
    if (a === "down") setSel((s) => Math.min(rows.length - 1, s + 1));
    else if (a === "up") setSel((s) => Math.max(0, s - 1));
    else return false;
    return true;
  });
  useEffect(() => {
    body.current?.querySelector(`[data-idx="${sel}"]`)?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  if (q.isLoading) return <Loading what="calendars" />;
  return (
    <>
      <DataStatus
        meta={q.data?.meta}
        error={q.error}
        fetching={q.isFetching}
        updatedAt={q.dataUpdatedAt}
      />
      <div className="ds dim">
        Hours in each venue&apos;s own time zone; next change in yours. ↑/↓ select.
      </div>
      <div style={{ overflow: "auto", flex: 1 }} data-testid="cdr">
        {q.data && rows.length === 0 ? (
          <div className="empty">No venue matches {panel.args.join(" ")}.</div>
        ) : (
          <table className="grid">
            <thead>
              <tr>
                <th className="l">VENUE</th>
                <th className="l">CAL</th>
                <th className="l">LOCAL</th>
                <th className="l">STATE</th>
                <th className="l">TODAY (LOCAL)</th>
                <th className="l">NEXT CHANGE</th>
                <th className="l">NEXT HOLIDAY / EARLY CLOSE</th>
                <th className="l">CLOCK CHANGE</th>
              </tr>
            </thead>
            <tbody ref={body}>
              {rows.map((v, i) => (
                <tr
                  key={v.code}
                  data-idx={i}
                  data-venue={v.code}
                  className={i === sel ? "sel" : ""}
                  onMouseDown={() => setSel(i)}
                >
                  <td className="l" style={{ color: "var(--text)" }}>
                    {v.name}
                  </td>
                  <td className="l amber">{v.mic}</td>
                  <td className="l">
                    {fmtHM(now, v.tz)} <span className="dim">{fmtOffset(v.utc_offset_s)}</span>
                  </td>
                  <td className={`l ${stateClass(v.state)}`} data-testid="venue-state">
                    {v.state ?? <NAValue />}
                  </td>
                  <td className="l">
                    {v.state === null || v.state === undefined ? (
                      <NAValue />
                    ) : v.today ? (
                      fmtHours(v.today, v.tz)
                    ) : (
                      <span className="dim">no session</span>
                    )}
                  </td>
                  <td className="l">
                    {v.next_change ? (
                      <>
                        {fmtTime(v.next_change, true)}{" "}
                        <span className="dim">{countdown(v.next_change, now)}</span>
                      </>
                    ) : (
                      <NAValue />
                    )}
                  </td>
                  <td className="l">{v.state ? nextSpecial(v) : NA}</td>
                  <td className="l dim">{fmtDst(v)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {cur ? <Detail v={cur} now={now} /> : null}
    </>
  );
}

function Detail({ v, now }: { v: Venue; now: number }) {
  return (
    <div className="ds" style={{ display: "block", whiteSpace: "normal" }} data-testid="cdr-detail">
      <b>{v.name}</b> <span className="dim">{v.tz}</span> · next session{" "}
      {v.next_session ? `${v.next_session.day} ${fmtHours(v.next_session, v.tz)}` : NA}
      {v.known_until ? <span className="dim"> · calendar known to {v.known_until}</span> : null}
      {v.state === null || v.state === undefined ? (
        <span className="dim"> · calendar unavailable: state, hours and holidays N.A.</span>
      ) : null}
      <div>
        {v.special.length ? (
          v.special.map((d) => (
            <span key={`${d.day}${d.kind}`} className={d.kind === "holiday" ? "amber" : ""}>
              {describeSpecial(d, v.tz)}
              {" · "}
            </span>
          ))
        ) : (
          <span className="dim">No holidays or early closes in the next 60 days.</span>
        )}
      </div>
      {v.dst_change ? (
        <div className="dim">
          Clock change {fmtTime(v.dst_change, true)} ({countdown(v.dst_change, now)}):{" "}
          {fmtOffset(v.utc_offset_s)} → {fmtOffset(v.dst_offset_s)}
        </div>
      ) : null}
    </div>
  );
}

export function registerCDR(): void {
  registerFunction({
    code: "CDR",
    name: "Exchange calendars",
    description:
      "Trading hours (DST-aware), session state, holidays, early closes and clock changes per " +
      "venue, from exchange_calendars",
    ticker: "none",
    syntax: "CDR [WORDS]",
    examples: ["CDR", "CDR DC", "CDR TOKYO"],
    category: "Market",
    sectors: ["EQUITY", "INDEX"],
    menu: ["Calendars"],
    args: [anyText("words", "words to filter by (code, calendar, name, country)")],
    actions: [],
    component: CDR,
  });
}
