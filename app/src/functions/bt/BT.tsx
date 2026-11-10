import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, errorMessage, type Schemas } from "@/core/api";
import { usePanelKeys } from "@/core/keys";
import { useWorkspace } from "@/core/layout/store";
import { anyText, registerFunction, type PanelProps } from "@/core/registry";
import { ErrorBanner, Loading } from "@/components/DataStatus";
import { LineChart } from "@/components/LineChart";
import { NA, fmtNum } from "@/lib/format";
import { token } from "@/theme/tokens";

type Scripts = Schemas["BtScriptsResponse"];
type Run = Schemas["BtRunResponse"];

/** Panel args: [SCRIPT.PY, ...ARGS]; the parser upper-cases, so match script names case-insensitively. */
function Result({ run }: { run: Run }) {
  const x = useMemo(() => run.equity.map((p) => Date.parse(p.t) / 1000), [run]);
  const series = useMemo(() => {
    const s = [
      { label: "Strategy", values: run.equity.map((p) => p.v), color: token("amber"), width: 2 },
    ];
    if (run.benchmark.length === run.equity.length) {
      s.push({
        label: "Benchmark",
        values: run.benchmark.map((p) => p.v),
        color: token("value-dim"),
        width: 1.5,
      });
    }
    return s;
  }, [run]);
  return (
    <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
      <div style={{ flex: 3, minWidth: 0, padding: 4 }}>
        <LineChart x={x} series={series} time />
      </div>
      <div
        style={{ flex: 1, minWidth: 220, overflow: "auto", borderLeft: "1px solid var(--line)" }}
      >
        <div className="section-title">STATS</div>
        <dl className="kv">
          {Object.entries(run.stats).map(([k, v]) => (
            <FragmentKV
              key={k}
              k={k}
              v={typeof v === "number" ? fmtNum(v, Math.abs(v) >= 100 ? 0 : 2) : String(v ?? NA)}
            />
          ))}
          <FragmentKV k="Points" v={String(run.equity.length)} />
          <FragmentKV k="Runtime" v={`${fmtNum(run.duration_s, 1)}s`} />
        </dl>
        {run.stderr_tail.length || run.stdout_tail.length ? (
          <>
            <div className="section-title">LOG</div>
            <pre className="log">
              {[...run.stdout_tail, ...run.stderr_tail].slice(-30).join("\n")}
            </pre>
          </>
        ) : null}
      </div>
    </div>
  );
}

function FragmentKV({ k, v }: { k: string; v: string }) {
  return (
    <>
      <dt>{k}</dt>
      <dd>{v}</dd>
    </>
  );
}

function BT({ id, panel, update }: PanelProps) {
  const scripts = useQuery({
    queryKey: ["bt", "scripts"],
    queryFn: () => api.get<Scripts>("/bt/scripts"),
  });
  const list = scripts.data?.scripts ?? [];
  const wanted = panel.args[0];
  const script = list.find((s) => s.name.toUpperCase() === wanted?.toUpperCase());
  const [sel, setSel] = useState(0);
  const [args, setArgs] = useState(panel.args.slice(1).join(" "));
  const [run, setRun] = useState<Run | null>(null);
  const [running, setRunning] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const argsRef = useRef<HTMLInputElement>(null);
  const notify = useWorkspace((s) => s.notify);

  const start = async (name: string, a: string) => {
    setRunning(true);
    setErr(null);
    try {
      const r = await api.post<Run>("/bt/run", {
        script: name,
        args: a.split(/\s+/).filter(Boolean),
      });
      setRun(r);
      if (!r.ok) notify(`BT ${name}: ${r.error}`, "error");
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setRunning(false);
    }
  };

  // "BT SCRIPT.PY ARGS" from the command line runs immediately.
  const autoKey = script ? `${script.name}|${panel.args.slice(1).join(" ")}` : null;
  useEffect(() => {
    if (script && autoKey) {
      setArgs(panel.args.slice(1).join(" "));
      void start(script.name, panel.args.slice(1).join(" "));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoKey]);

  usePanelKeys(id, "BT", (a) => {
    if (a === "down") setSel((s) => Math.min(list.length - 1, s + 1));
    else if (a === "up") setSel((s) => Math.max(0, s - 1));
    else if (a === "args") argsRef.current?.focus();
    else if (a === "run" && list[sel] && !running) {
      update({
        ...panel,
        args: [list[sel].name.toUpperCase(), ...args.toUpperCase().split(/\s+/).filter(Boolean)],
      });
      void start(list[sel].name, args);
    } else return false;
    return true;
  });

  if (scripts.isLoading) return <Loading what="backtest scripts" />;
  const cfg = scripts.data;
  return (
    <>
      {scripts.error ? <ErrorBanner error={scripts.error} /> : null}
      {err ? <ErrorBanner error={new Error(err)} /> : null}
      {cfg && !cfg.configured ? (
        <div className="ds-err">
          <b>BT_RESEARCH_DIR NOT SET</b> Set it in .env to the folder with your backtest scripts
          (see docs/FUNCTIONS.md#bt; an example is in docs/examples/bt/sma_cross.py).
        </div>
      ) : null}
      <div className="toolbar">
        <span className="dim">{cfg?.directory ?? ""}</span>
        <label style={{ marginLeft: "auto" }}>
          ARGS{" "}
          <input
            ref={argsRef}
            value={args}
            placeholder="e.g. SPY 50 200"
            onChange={(e) => setArgs(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                (e.target as HTMLInputElement).blur();
                document.querySelector<HTMLElement>(`[data-panel-id="${id}"]`)?.focus();
              }
            }}
            style={{ width: 200 }}
          />
        </label>
        {running ? <span className="cyan">RUNNING…</span> : null}
      </div>
      <div style={{ maxHeight: 120, overflow: "auto", borderBottom: "1px solid var(--line)" }}>
        <table className="grid">
          <tbody>
            {list.map((s, i) => (
              <tr
                key={s.name}
                className={i === sel ? "sel" : ""}
                onMouseDown={() => setSel(i)}
                onDoubleClick={() => void start(s.name, args)}
              >
                <td className="l amber">{s.name}</td>
                <td className="l" style={{ color: "var(--text)" }}>
                  {s.description ?? ""}
                </td>
                <td className="dim">{s.modified.slice(0, 10)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {cfg?.configured && !list.length ? (
          <div className="empty">No *.py scripts in the research folder.</div>
        ) : null}
      </div>
      {run ? (
        run.ok ? (
          <>
            <div className="ds">
              <span className="lat lat-STATIC">BACKTEST</span>
              <span>
                {run.script} — results come from your script, not from a market data provider
              </span>
            </div>
            <Result run={run} />
          </>
        ) : (
          <div style={{ overflow: "auto", flex: 1 }}>
            <div className="ds-err">
              <b>BT FAILED</b> {run.error} {run.exit_code != null ? `(exit ${run.exit_code})` : ""}
            </div>
            <pre className="log">{[...run.stdout_tail, ...run.stderr_tail].join("\n")}</pre>
          </div>
        )
      ) : (
        <div className="empty">Select a script (↑↓), set ARGS (A), press Enter to run.</div>
      )}
      <div className="ds hint">
        ↑↓ script · A edit args · Enter run · scripts run with `uv run` in the research folder
      </div>
    </>
  );
}

export function registerBT(): void {
  registerFunction({
    code: "BT",
    name: "Backtest runner",
    description: "Run a Python backtest from your research folder and plot its equity curve",
    ticker: "none",
    syntax: "BT · BT <SCRIPT.PY> [ARGS…]",
    examples: ["BT", "BT SMA_CROSS.PY SPY 50 200"],
    category: "Tools",
    sectors: ["CLIENT"],
    menu: ["Backtests"],
    args: [anyText("script", "SCRIPT.PY from the research folder, then its own args")],
    actions: [],
    component: BT,
  });
}
