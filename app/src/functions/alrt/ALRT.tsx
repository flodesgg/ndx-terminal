import { useEffect, useRef, useState } from "react";
import { useQuery, type QueryClient } from "@tanstack/react-query";
import { api, isTauri, type Schemas } from "@/core/api";
import { usePanelKeys } from "@/core/keys";
import { useWorkspace } from "@/core/layout/store";
import { live, useLiveQuotes, type LiveAlert, type LiveNewsAlert } from "@/core/live";
import { anyText, registerFunction, type PanelProps } from "@/core/registry";
import type { ParsedCommand } from "@/core/command/parser";
import { ErrorBanner, Loading } from "@/components/DataStatus";
import { fmtPct, fmtPrice, fmtTime } from "@/lib/format";
import { V } from "@/components/V";

type Alert = Schemas["Alert"];
type AlertKind = Alert["kind"];

const KEY = ["alerts"] as const;
let queryClient: QueryClient | null = null;
export function setAlertsClient(c: QueryClient): void {
  queryClient = c;
}

export function describeAlert(a: Pick<Alert, "symbol" | "kind" | "threshold">): string {
  switch (a.kind) {
    // Thresholds through the shared formatters (§4.2): separators, class precision, U+2212.
    case "above":
      return `${a.symbol} ≥ ${fmtPrice(a.threshold, a.symbol)}`;
    case "below":
      return `${a.symbol} ≤ ${fmtPrice(a.threshold, a.symbol)}`;
    case "pct_above":
      return `${a.symbol} day change ≥ ${fmtPct(a.threshold)}`;
    case "pct_below":
      return `${a.symbol} day change ≤ ${fmtPct(a.threshold)}`;
  }
}

/** ">200", "<180", "%>5", "%<-3" -> kind + threshold */
export function parseCondition(s: string): { kind: AlertKind; threshold: number } | null {
  const m = /^(%?)([<>])(-?\d+(?:\.\d+)?)$/.exec(s.trim());
  if (!m) return null;
  const pct = m[1] === "%";
  const above = m[2] === ">";
  const threshold = Number(m[3]);
  if (!Number.isFinite(threshold) || (!pct && threshold <= 0)) return null;
  return { kind: pct ? (above ? "pct_above" : "pct_below") : above ? "above" : "below", threshold };
}

async function refresh() {
  await queryClient?.invalidateQueries({ queryKey: KEY });
}

async function alrtAction(cmd: ParsedCommand): Promise<boolean> {
  const ws = useWorkspace.getState();
  // "ALRT DEL 3" parses DEL as a ticker (it is a valid symbol): treat it as a subcommand.
  const sub = cmd.ticker === "DEL" || cmd.ticker === "REARM";
  const [first, ...rest] = sub ? [cmd.ticker!, ...cmd.args] : cmd.args;
  if (cmd.ticker && !sub) {
    if (!first) return false; // "AAPL ALRT" opens the panel
    const cond = parseCondition(first);
    if (!cond) throw new Error("Usage: <TICKER> ALRT >200 | <180 | %>5 | %<-3 [note]");
    const a = await api.post<Alert>("/alerts", {
      symbol: cmd.ticker,
      ...cond,
      note: rest.join(" "),
    });
    ws.notify(`Alert #${a.id} armed: ${describeAlert(a)}`);
    await refresh();
    return true;
  }
  if (first === "DEL" || first === "REARM") {
    const n = Number(rest[0]);
    if (!Number.isInteger(n)) throw new Error(`Usage: ALRT ${first} <id>`);
    if (first === "DEL") await api.del(`/alerts/${n}`);
    else await api.post(`/alerts/${n}/rearm`);
    ws.notify(`Alert #${n} ${first === "DEL" ? "deleted" : "re-armed"}`);
    await refresh();
    return true;
  }
  return false;
}

async function nativeNotify(title: string, body: string): Promise<void> {
  try {
    if (isTauri()) {
      const n = await import("@tauri-apps/plugin-notification");
      let ok = await n.isPermissionGranted();
      if (!ok) ok = (await n.requestPermission()) === "granted";
      if (ok) n.sendNotification({ title, body });
      return;
    }
    if (typeof Notification !== "undefined") {
      if (Notification.permission === "default") await Notification.requestPermission();
      if (Notification.permission === "granted") new Notification(title, { body });
    }
  } catch {
    /* notification failures must not break the app; the in-app message still shows */
  }
}

/** Mounted once at the app root: turns server alert events into notifications. */
export function AlertListener() {
  useEffect(
    () =>
      live.onNewsAlert((msg: LiveNewsAlert) => {
        const text = `"${msg.keyword}": ${msg.item.headline} · ${msg.item.source}`;
        useWorkspace.getState().notify(`NEWS ALERT ${text}`, "info");
        void nativeNotify(`News: ${msg.keyword}`, `${msg.item.headline}\n${msg.item.source}`);
      }),
    [],
  );
  useEffect(
    () =>
      live.onAlert((msg: LiveAlert) => {
        const text = `${describeAlert(msg.alert)} — now ${fmtPrice(msg.price, msg.alert.symbol)} (${fmtPct(msg.change_pct)}) · ${msg.meta.source}`;
        useWorkspace.getState().notify(`ALERT #${msg.alert.id}: ${text}`, "error");
        void nativeNotify(
          `Alert: ${msg.alert.symbol}`,
          `${text}${msg.alert.note ? `\n${msg.alert.note}` : ""}`,
        );
        void refresh();
      }),
    [],
  );
  return null;
}

function ALRT({ id }: PanelProps) {
  const q = useQuery({
    queryKey: KEY,
    queryFn: () => api.get<Alert[]>("/alerts"),
    refetchInterval: 30_000,
  });
  const rows = q.data ?? [];
  const quotes = useLiveQuotes([...new Set(rows.filter((a) => a.active).map((a) => a.symbol))]);
  const [sel, setSel] = useState(0);
  const body = useRef<HTMLTableSectionElement>(null);
  const cur = rows[sel];
  const notify = useWorkspace((s) => s.notify);

  usePanelKeys(id, "ALRT", (a) => {
    if (a === "down") setSel((s) => Math.min(rows.length - 1, s + 1));
    else if (a === "up") setSel((s) => Math.max(0, s - 1));
    else if (a === "delete" && cur) {
      void api.del(`/alerts/${cur.id}`).then(() => {
        notify(`Alert #${cur.id} deleted`);
        void refresh();
      });
    } else if (a === "rearm" && cur && !cur.active) {
      void api.post(`/alerts/${cur.id}/rearm`).then(() => void refresh());
    } else if (a === "test") void nativeNotify("NDX alert test", "Notifications are working.");
    else return false;
    return true;
  });

  if (q.isLoading) return <Loading what="alerts" />;
  return (
    <>
      {q.error ? <ErrorBanner error={q.error} /> : null}
      <div className="ds">
        Server checks active alerts every 10s against live quotes (same sources/delays as Q).
        One-shot: a fired alert is disarmed (R re-arms).
      </div>
      <div style={{ overflow: "auto", flex: 1 }}>
        <table className="grid">
          <thead>
            <tr>
              <th>#</th>
              <th className="l">CONDITION</th>
              <th>LAST</th>
              <th>CHG%</th>
              <th className="l">STATE</th>
              <th className="l">FIRED</th>
              <th className="l">NOTE</th>
            </tr>
          </thead>
          <tbody ref={body}>
            {rows.map((a, i) => {
              const lq = quotes.get(a.symbol)?.quote;
              return (
                <tr key={a.id} className={i === sel ? "sel" : ""} onMouseDown={() => setSel(i)}>
                  <td className="dim">{a.id}</td>
                  <td className="l amber">{describeAlert(a)}</td>
                  <td>
                    <V>{a.active ? fmtPrice(lq?.price, a.symbol) : null}</V>
                  </td>
                  <td>
                    <V>{a.active ? fmtPct(lq?.change_pct) : null}</V>
                  </td>
                  <td className={`l ${a.active ? "up" : "dim"}`}>{a.active ? "ARMED" : "FIRED"}</td>
                  <td className="l dim">
                    {a.triggered_at
                      ? `${fmtTime(a.triggered_at, true)} @ ${fmtPrice(a.triggered_price, a.symbol)}`
                      : ""}
                  </td>
                  <td className="l" style={{ color: "var(--text)" }}>
                    {a.note}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!rows.length ? (
          <div className="empty">
            No alerts. Create one: <span className="amber">AAPL ALRT &gt;200</span> ·{" "}
            <span className="amber">BTCUSDT ALRT &lt;60000</span> ·{" "}
            <span className="amber">NVDA ALRT %&lt;-3</span>
          </div>
        ) : null}
      </div>
    </>
  );
}

export function registerALRT(): void {
  registerFunction({
    code: "ALRT",
    name: "Alerts",
    description: "Price / % change alerts with native macOS notifications",
    ticker: "optional",
    syntax:
      "ALRT · <TICKER> ALRT >PRICE | <PRICE | %>PCT | %<PCT [NOTE] · ALRT DEL <ID> · ALRT REARM <ID>",
    examples: [
      "ALRT",
      "AAPL US EQUITY ALRT >250",
      "BTCUSD CURNCY ALRT <60000",
      "NVDA US EQUITY ALRT %<-3 EARNINGS DROP",
    ],
    category: "Tools",
    sectors: ["EQUITY", "INDEX", "COMDTY", "CURNCY", "CLIENT"],
    menu: ["Alerts"],
    args: [
      anyText("rule", ">PRICE, <PRICE, %>PCT or %<PCT then an optional note; DEL <ID>; REARM <ID>"),
    ],
    actions: [],
    component: ALRT,
    run: alrtAction,
    structuredArgs: ([a = "", b = ""]) =>
      parseCondition(a) !== null || ((a === "DEL" || a === "REARM") && /^\d+$/.test(b)),
  });
}
