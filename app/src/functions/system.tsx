/** System functions: BLANK, HELP, LOG, PROV, LAYOUT. */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, type Schemas } from "@/core/api";
import { useApi } from "@/core/data";
import { usePanelKeys } from "@/core/keys";
import { useWorkspace } from "@/core/layout/store";
import {
  LAYOUT_WORDS,
  layoutCommand,
  layoutOf,
  layoutSummary,
  sessionFromStored,
} from "@/core/layout/named";
import { executeCommand } from "@/core/executor";
import { HELP_TOPICS, helpSearch } from "@/core/helpsearch";
import { runItem } from "@/core/items";
import { NOTICES } from "@/core/notices";
import { openExternal } from "@/lib/open";
import { sectorToken } from "@/core/sectors";
import {
  allFunctions,
  anyText,
  functionsForSector,
  getFunction,
  helpText,
  matching,
  oneOf,
  registerFunction,
  type FunctionDef,
  type PanelProps,
} from "@/core/registry";
import { ErrorBanner, Loading } from "@/components/DataStatus";
import { fmtNum, fmtPct, fmtTime, relTime } from "@/lib/format";
import { quotaText } from "@/lib/statusbar";
import { filterLog, logArgs, parseLogLine, type LogEntry, type LogLevel } from "@/lib/logview";
import { setAlertsClient } from "./alrt/ALRT";
import { setPortfolioClient } from "./port/PORT";
import { setWatchlistClient } from "./w/watchlists";
import { NAValue, V } from "@/components/V";

export function scrollKeys(ref: React.RefObject<HTMLElement | null>) {
  return (action: string): boolean => {
    const el = ref.current;
    if (!el) return false;
    if (action === "top") el.scrollTop = 0;
    else if (action === "bottom") el.scrollTop = el.scrollHeight;
    else {
      const step = {
        down: 40,
        up: -40,
        "page-down": el.clientHeight,
        "page-up": -el.clientHeight,
      }[action];
      if (step === undefined) return false;
      el.scrollBy({ top: step });
    }
    return true;
  };
}

function Blank() {
  return (
    <div className="empty">
      Empty panel. Type a command (e.g. <span className="amber">AAPL GP</span>) and press Enter.
      Press <kbd>?</kbd> for keys, <span className="amber">HELP</span> for functions.
    </div>
  );
}

function FunctionTable({ fns }: { fns: FunctionDef[] }) {
  const cats = [...new Set(fns.map((f) => f.category))];
  return (
    <>
      {cats.map((c) => (
        <div key={c}>
          <div className="section-title">{c.toUpperCase()}</div>
          <table className="grid">
            <tbody>
              {fns
                .filter((f) => f.category === c)
                .map((f) => (
                  <tr key={f.code}>
                    <td className="l" style={{ width: 70 }}>
                      <button
                        type="button"
                        className="link amber"
                        onClick={() => void executeCommand(`HELP ${f.code}`)}
                      >
                        {f.code}
                      </button>
                    </td>
                    <td className="l" style={{ width: 200 }}>
                      {f.name}
                    </td>
                    <td className="l dim">{f.description}</td>
                    <td className="l cyan">{f.examples.join(" · ")}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      ))}
    </>
  );
}

/** HELP → Data sources: what each provider is used for and the notices its terms require. */
function DataSources() {
  const optIn = useApi<Schemas["OptInProviders"]>("/providers/opt-in");
  return (
    <div data-testid="help-sources">
      <div className="ds">
        DATA SOURCES · notices and attributions the providers require · personal, non-commercial use
        only · opt-in sources are switched in <span className="amber">PDF</span>
      </div>
      {NOTICES.map((n) => (
        <div key={n.source} className="notice" data-notice={n.source}>
          <div>
            <span className="amber">{n.source}</span> <span className="dim">· {n.use}</span>
            {n.optIn ? (
              <span>
                {" · "}
                {optIn.data ? (
                  optIn.data[n.optIn] ? (
                    <span className="amber">
                      ON (enabled by you in PDF)
                      {n.optIn === "yfinance" && optIn.data.yfinance_scope === "dk_indices"
                        ? " · Danish stocks and indices only"
                        : ""}
                    </span>
                  ) : (
                    "OFF (default)"
                  )
                ) : (
                  <NAValue />
                )}
              </span>
            ) : null}
          </div>
          <div>
            {n.text}{" "}
            {n.links.map((l) => (
              <button
                key={l.url}
                type="button"
                className="link cyan"
                title={l.url}
                onClick={() => void openExternal(l.url)}
              >
                {l.label}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Help search (F1 twice): an amber field; every word must appear in the help page. */
function HelpSearch({ panel, update }: PanelProps) {
  const [q, setQ] = useState(panel.args.slice(1).join(" "));
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => field.current?.focus({ preventScroll: true }), []);
  const hits = helpSearch(q);
  return (
    <div data-testid="help-search">
      <div className="ds">
        HELP SEARCH ·{" "}
        <input
          ref={field}
          className="amber-field"
          data-testid="help-search-field"
          value={q}
          spellCheck={false}
          placeholder="words to find in every help page"
          onChange={(e) => {
            setQ(e.target.value);
            const words = e.target.value.toUpperCase().split(/\s+/).filter(Boolean);
            update({ ...panel, args: ["SEARCH", ...words] });
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && hits[0]) {
              e.preventDefault();
              useWorkspace.getState().open(hits[0].target);
            }
          }}
        />{" "}
        · Enter opens the first hit
      </div>
      {q.trim() && !hits.length ? <div className="empty">No help page mentions “{q}”.</div> : null}
      <table className="grid">
        <tbody>
          {hits.map((h) => (
            <tr key={h.label}>
              <td className="l" style={{ width: 120 }}>
                <button
                  type="button"
                  className="link amber"
                  onClick={() => useWorkspace.getState().open(h.target)}
                >
                  {h.label}
                </button>
              </td>
              <td className="l">{h.desc}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Help(props: PanelProps) {
  const { id, panel } = props;
  const ref = useRef<HTMLDivElement>(null);
  usePanelKeys(id, "HELP", scrollKeys(ref));
  const filter = panel.args[0];
  const one = filter ? getFunction(filter) : undefined;
  let body: React.ReactNode;
  if (filter === "SOURCES") body = <DataSources />;
  else if (filter === "SEARCH") body = <HelpSearch {...props} />;
  else if (one) {
    body = (
      <pre className="help-page" data-testid="help-page">
        {helpText(one).join("\n")}
      </pre>
    );
  } else {
    const sector = filter ? sectorToken(filter) : undefined;
    const fns = sector
      ? functionsForSector(sector)
      : allFunctions().filter((f) => !filter || f.category.toUpperCase() === filter);
    body = (
      <>
        <div className="ds">
          SYNTAX: <span className="amber">&lt;SECURITY&gt; &lt;FUNCTION&gt; [ARGS]</span> · bare
          function for global views · ⇧Enter opens in a new tab · <kbd>?</kbd> keyboard cheatsheet
          {sector ? ` · ${sector} functions (the numbered menu is MENU ${sector})` : ""}
        </div>
        {filter ? null : (
          <div className="help-topics" data-testid="help-topics">
            {HELP_TOPICS.map((t, i) => (
              <button
                key={t.label}
                type="button"
                className="item"
                onClick={() => runItem(id, i + 1)}
              >
                <span className="item-n">{i + 1})</span> {t.label}{" "}
                <span className="dim">{t.desc}</span>
              </button>
            ))}
          </div>
        )}
        <FunctionTable fns={fns} />
      </>
    );
  }
  return (
    <div ref={ref} style={{ overflow: "auto", flex: 1 }}>
      {body}
    </div>
  );
}

const LEVEL_CLASS: Record<LogLevel, string> = {
  DEBUG: "dim",
  INFO: "",
  WARNING: "amber",
  ERROR: "down",
  CRITICAL: "down",
};

function LogPanel({ id, panel }: PanelProps) {
  const ref = useRef<HTMLDivElement>(null);
  const { lines: n, level } = logArgs(panel.args);
  const [text, setText] = useState("");
  const q = useApi<Schemas["LogResponse"]>("/logs", { lines: n }, { refetchMs: 3000 });
  usePanelKeys(id, "LOG", scrollKeys(ref));
  const entries = useMemo(
    () =>
      filterLog(
        (q.data?.lines ?? []).map(parseLogLine).filter((e): e is LogEntry => e !== null),
        level,
        text,
      ),
    [q.data, level, text],
  );
  useEffect(() => {
    const el = ref.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 80) el.scrollTop = el.scrollHeight;
  }, [entries.length]);
  if (q.isLoading) return <Loading what="log" />;
  return (
    <>
      {q.error ? <ErrorBanner error={q.error} /> : null}
      <div className="ds">
        FILE {q.data?.path ?? <NAValue />} · last {n} lines · level ≥ {level} · refresh 3s · filter{" "}
        <input
          className="amber-field"
          data-testid="log-filter"
          value={text}
          spellCheck={false}
          onChange={(e) => setText(e.target.value)}
          style={{ width: 160 }}
        />{" "}
        · LOG [LINES] [DEBUG|INFO|WARN|ERROR]
      </div>
      <div ref={ref} style={{ overflow: "auto", flex: 1 }} data-testid="log">
        {entries.length === 0 ? (
          <div className="empty">
            {q.data?.lines.length ? "No log lines match." : "The log is empty."}
          </div>
        ) : (
          <table className="grid log">
            <tbody>
              {entries.map((e, i) => (
                <tr key={i} className={LEVEL_CLASS[e.level]} data-level={e.level}>
                  <td className="l" style={{ width: 150 }}>
                    <V>{e.ts ? fmtTime(e.ts, true) : null}</V>
                  </td>
                  <td className="l" style={{ width: 70 }}>
                    {e.level}
                  </td>
                  <td className="l dim" style={{ width: 160 }}>
                    {e.logger}
                  </td>
                  <td className="l" style={{ whiteSpace: "pre-wrap" }}>
                    {e.msg}
                    {e.exc ? <div className="dim">{e.exc}</div> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

/** PROV (SPEC §6.3): every number comes from the server's counters; none yet → N.A. */
function Providers({ id }: PanelProps) {
  const ref = useRef<HTMLDivElement>(null);
  const q = useApi<Schemas["ProviderStatus"][]>("/providers", undefined, { refetchMs: 3000 });
  usePanelKeys(id, "PROV", scrollKeys(ref));
  if (q.isLoading) return <Loading />;
  const na = (v: number | null | undefined, text: (n: number) => string) =>
    v == null ? <NAValue /> : text(v);
  return (
    <>
      {q.error ? <ErrorBanner error={q.error} /> : null}
      <div className="ds">
        Latency and error rate over the last 200 requests · quota = requests taken in the current
        window of the budget (PROVIDERS.md §6) · streams: symbols used of the cap
      </div>
      <div ref={ref} style={{ overflow: "auto", flex: 1 }} data-testid="prov">
        <table className="grid">
          <thead>
            <tr>
              <th className="l">PROVIDER</th>
              <th className="l">STATE</th>
              <th className="l">TAG</th>
              <th>P50 MS</th>
              <th>P95 MS</th>
              <th>ERR %</th>
              <th>LAST OK</th>
              <th className="l">QUOTA USED</th>
              <th>LEFT</th>
              <th className="l">BREAKER</th>
              <th className="l">KEY</th>
              <th className="l">DOMAINS</th>
              <th className="l">DETAIL</th>
            </tr>
          </thead>
          <tbody>
            {(q.data ?? []).map((p) => (
              <tr key={p.name} data-provider={p.name}>
                <td className="l amber">{p.label}</td>
                <td className="l">
                  <span className={`dot dot-${p.state}`} />
                  {p.state.toUpperCase()}
                </td>
                <td className="l">{p.tag}</td>
                <td>{na(p.latency_p50_ms, (v) => fmtNum(v, 0))}</td>
                <td>{na(p.latency_p95_ms, (v) => fmtNum(v, 0))}</td>
                <td className={p.error_rate ? "down" : ""}>
                  {na(p.error_rate, (v) => fmtPct(v * 100, 1, false))}
                </td>
                <td>{p.last_ok ? `${relTime(p.last_ok)} ago` : <NAValue />}</td>
                <td className="l">{p.quota_limit == null ? <NAValue /> : quotaText(p)}</td>
                <td className={p.quota_left === 0 ? "amber" : ""}>
                  {na(p.quota_left, (v) => fmtNum(v, 0))}
                </td>
                <td className={`l ${p.breaker === "open" ? "down" : ""}`}>
                  {p.breaker ? p.breaker.toUpperCase().replace("_", "-") : <NAValue />}
                </td>
                <td className="l">
                  {p.requires_key ? (
                    p.has_key ? (
                      "SET"
                    ) : (
                      <span className="down">MISSING</span>
                    )
                  ) : (
                    "n/a"
                  )}
                </td>
                <td className="l dim">{p.domains.join(" ")}</td>
                <td className="l dim" style={{ whiteSpace: "normal" }}>
                  {p.detail ?? ""}
                  {p.last_error_at ? ` (${fmtTime(p.last_error_at, true)})` : ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {q.data?.length === 0 ? <div className="empty">No providers registered.</div> : null}
      </div>
    </>
  );
}

function LayoutCells({ tree }: { tree: unknown }) {
  const sum = layoutSummary(tree);
  if (!sum) {
    return (
      <>
        <td className="l down">unreadable</td>
        <td>
          <NAValue />
        </td>
      </>
    );
  }
  return (
    <>
      <td className="l">{sum.mode.toUpperCase()}</td>
      <td>{fmtNum(sum.windows, 0)}</td>
    </>
  );
}

function Layouts() {
  const q = useQuery({
    queryKey: ["layouts"],
    queryFn: () => api.get<Schemas["Layout"][]>("/layouts"),
  });
  if (q.isLoading) return <Loading />;
  return (
    <>
      {q.error ? <ErrorBanner error={q.error} /> : null}
      <div className="ds">
        LAYOUT SAVE &lt;name&gt; · LAYOUT &lt;name&gt; · LAYOUT DEL &lt;name&gt; · LAYOUT RESET ·
        LAYOUT CLASSIC · LAYOUT WORKSPACE
      </div>
      <table className="grid">
        <thead>
          <tr>
            <th className="l">NAME</th>
            <th className="l">MODE</th>
            <th>WINDOWS</th>
            <th>UPDATED</th>
          </tr>
        </thead>
        <tbody>
          {(q.data ?? []).map((l) => (
            <tr key={l.name}>
              <td className="l amber">{l.name}</td>
              <LayoutCells tree={l.tree} />
              <td>
                <V>{l.updated_at ? fmtTime(l.updated_at, true) : null}</V>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {q.data?.length === 0 ? <div className="empty">No saved layouts yet.</div> : null}
    </>
  );
}

let queryClientRef: ReturnType<typeof useQueryClient> | null = null;
export function LayoutClientBridge() {
  queryClientRef = useQueryClient();
  setWatchlistClient(queryClientRef);
  setAlertsClient(queryClientRef);
  setPortfolioClient(queryClientRef);
  return null;
}

async function layoutAction(args: string[]): Promise<boolean> {
  const cmd = layoutCommand(args);
  const ws = useWorkspace.getState();
  const refresh = () => void queryClientRef?.invalidateQueries({ queryKey: ["layouts"] });
  switch (cmd.op) {
    case "error":
      throw new Error(cmd.error);
    case "list":
      return false;
    case "save":
      await api.put(`/layouts/${encodeURIComponent(cmd.name)}`, {
        name: cmd.name,
        tree: layoutOf(ws.session),
      });
      ws.notify(`Layout "${cmd.name}" saved`);
      refresh();
      return true;
    case "load": {
      const l = await api.get<Schemas["Layout"]>(`/layouts/${encodeURIComponent(cmd.name)}`);
      const s = sessionFromStored(l.tree);
      if (!s) throw new Error(`Layout "${cmd.name}" is corrupt`);
      ws.loadSession(s);
      ws.notify(`Layout "${cmd.name}" loaded`);
      return true;
    }
    case "del":
      await api.del(`/layouts/${encodeURIComponent(cmd.name)}`);
      ws.notify(`Layout "${cmd.name}" deleted`);
      refresh();
      return true;
    case "reset":
      ws.reset();
      ws.notify("Default layout restored");
      return true;
    case "mode":
      ws.setMode(cmd.mode);
      ws.notify(`${cmd.mode === "classic" ? "Classic" : "Workspace"} mode`);
      return true;
  }
}

export function registerSystemFunctions(): void {
  registerFunction({
    code: "BLANK",
    name: "Empty panel",
    description: "Empty panel",
    ticker: "none",
    syntax: "BLANK",
    examples: [],
    category: "System",
    sectors: [],
    menu: ["Windows"],
    args: [],
    actions: [],
    hidden: true,
    component: Blank,
  });
  registerFunction({
    code: "HELP",
    name: "Function list",
    description: "All functions with syntax and examples",
    ticker: "none",
    syntax: "HELP [FUNCTION|CATEGORY|SECTOR|SOURCES] · HELP SEARCH [WORDS]",
    examples: ["HELP", "HELP GP", "HELP SOURCES", "HELP SEARCH CHART"],
    category: "System",
    sectors: [],
    menu: ["Help"],
    args: [
      anyText(
        "topic",
        "a function mnemonic, a category, a sector, SOURCES (data sources) or SEARCH <words>",
      ),
    ],
    structuredArgs: (a) =>
      a.length === 1 &&
      (a[0] === "SOURCES" ||
        getFunction(a[0]!) !== undefined ||
        allFunctions(true).some((f) => f.category.toUpperCase() === a[0])),
    actions: [],
    items: (p) =>
      p.args.length
        ? []
        : HELP_TOPICS.map((t, i) => ({
            n: i + 1,
            label: t.label,
            content: true,
            to: () => t.target,
          })),
    component: Help,
  });
  registerFunction({
    code: "LOG",
    name: "Application log",
    description:
      "The structured log (server and client, secrets redacted): time, level, logger, message; " +
      "minimum level and a text filter.",
    ticker: "none",
    syntax: "LOG [LINES] [DEBUG|INFO|WARN|ERROR]",
    examples: ["LOG", "LOG 2000", "LOG ERROR"],
    category: "System",
    sectors: [],
    menu: ["Diagnostics"],
    args: [
      matching("lines", /^\d{1,5}$/, "<lines>", "trailing lines to show (default 400, max 5000)"),
      oneOf("level", ["DEBUG", "INFO", "WARN", "WARNING", "ERROR", "CRITICAL"], "minimum level"),
    ],
    actions: [],
    component: LogPanel,
  });
  registerFunction({
    code: "PROV",
    name: "Data providers",
    description:
      "Every data provider and stream: state, freshness tag, latency p50/p95, error rate, last " +
      "success, quota used/left, circuit breaker",
    ticker: "none",
    syntax: "PROV",
    examples: ["PROV"],
    category: "System",
    sectors: [],
    menu: ["Diagnostics"],
    args: [],
    actions: [],
    component: Providers,
  });
  registerFunction({
    code: "LAYOUT",
    name: "Layouts",
    description:
      "Save, load and list named layouts (windows, tabs, history, links of both modes); " +
      "LAYOUT CLASSIC / LAYOUT WORKSPACE switch the mode. The last session restores on launch.",
    ticker: "none",
    syntax: "LAYOUT [SAVE|DEL] <NAME> · LAYOUT <NAME> · LAYOUT [LIST|RESET|CLASSIC|WORKSPACE]",
    examples: ["LAYOUT SAVE MORNING", "LAYOUT MORNING", "LAYOUT", "LAYOUT WORKSPACE"],
    category: "System",
    sectors: [],
    menu: ["Windows"],
    args: [
      oneOf("command", LAYOUT_WORDS, "what to do (a bare name loads that layout)"),
      anyText("name", "layout name"),
    ],
    actions: [],
    component: Layouts,
    run: (cmd) => layoutAction(cmd.args),
  });
}
