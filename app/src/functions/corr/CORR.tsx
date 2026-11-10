import { useMemo, useState } from "react";
import type { Schemas } from "@/core/api";
import { useApi } from "@/core/data";
import { executeCommand } from "@/core/executor";
import { usePanelKeys } from "@/core/keys";
import { anyText, matching, registerFunction, type PanelProps } from "@/core/registry";
import { ErrorBanner, Loading } from "@/components/DataStatus";
import { fmtNum } from "@/lib/format";
import { useWatchlists } from "../w/watchlists";
import { withAlpha } from "@/theme/tokens";
import { V } from "@/components/V";

type Resp = Schemas["CorrelationResponse"];

/** -1 red … 0 neutral … +1 green */
export function corrColor(c: number | null | undefined): string {
  if (c == null) return "transparent";
  const a = Math.min(1, Math.abs(c));
  return withAlpha(c >= 0 ? "up" : "down", a * 0.65);
}

function CORR({ id, panel }: PanelProps) {
  const lists = useWatchlists();
  const daysArg = panel.args.find((a) => /^D=\d+$/.test(a));
  const days = daysArg ? Number(daysArg.slice(2)) : 252;
  const explicit = panel.args.filter((a) => !/^D=\d+$/.test(a));
  const symbols = useMemo(
    () => (explicit.length >= 2 ? explicit : (lists.data?.[0]?.symbols ?? [])).slice(0, 30),
    [explicit, lists.data],
  );
  const q = useApi<Resp>(
    symbols.length >= 2 ? "/correlation" : null,
    { symbols: symbols.join(","), days },
    { staleMs: 600_000 },
  );
  const [cell, setCell] = useState<[number, number]>([0, 1]);
  const d = q.data;
  const n = d?.symbols.length ?? 0;

  usePanelKeys(id, "CORR", (a) => {
    if (a === "down") setCell(([r, c]) => [Math.min(n - 1, r + 1), c]);
    else if (a === "up") setCell(([r, c]) => [Math.max(0, r - 1), c]);
    else if (a === "right") setCell(([r, c]) => [r, Math.min(n - 1, c + 1)]);
    else if (a === "left") setCell(([r, c]) => [r, Math.max(0, c - 1)]);
    else if (a === "chart" && d)
      void executeCommand(`${d.symbols[cell[0]]} GP`, { newPanel: true });
    else return false;
    return true;
  });

  if (symbols.length < 2)
    return <div className="empty">Give at least two symbols: CORR AAPL MSFT NVDA</div>;
  if (q.isLoading) return <Loading what={`correlations (${symbols.length} symbols)`} />;
  const sel = d ? d.matrix[cell[0]]?.[cell[1]] : null;

  return (
    <>
      {q.error ? <ErrorBanner error={q.error} /> : null}
      {d ? (
        <div className="ds">
          <span>
            Pearson correlation of daily returns · {d.days} common trading days ({d.start} → {d.end}
            )
          </span>
          <span>SRC {d.sources.join(" + ")} · EOD closes</span>
          {d.errors.length ? <span className="down">MISSING: {d.errors.join("; ")}</span> : null}
        </div>
      ) : null}
      <div style={{ overflow: "auto", flex: 1 }}>
        {d ? (
          <table className="grid" style={{ width: "auto" }}>
            <thead>
              <tr>
                <th />
                {d.symbols.map((s, j) => (
                  <th key={s} style={{ color: j === cell[1] ? "var(--accent)" : undefined }}>
                    {s}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {d.symbols.map((s, i) => (
                <tr key={s}>
                  <td
                    className="l"
                    style={{
                      color: i === cell[0] ? "var(--accent)" : "var(--fg)",
                      fontWeight: 700,
                    }}
                  >
                    {s}
                  </td>
                  {d.matrix[i]!.map((c, j) => (
                    <td
                      key={j}
                      onMouseDown={() => setCell([i, j])}
                      style={{
                        background: corrColor(c),
                        outline:
                          i === cell[0] && j === cell[1] ? "1px solid var(--accent)" : undefined,
                        color: "var(--text)",
                        minWidth: 52,
                      }}
                    >
                      <V>{fmtNum(c, 2)}</V>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
        {d && sel != null ? (
          <div style={{ padding: "6px 8px" }}>
            <span className="amber">{d.symbols[cell[0]]}</span> vs{" "}
            <span className="amber">{d.symbols[cell[1]]}</span>: <b>{fmtNum(sel, 3)}</b>
          </div>
        ) : null}
      </div>
      <div className="ds hint">
        ←↑→↓ move · Enter chart row symbol · CORR SYM1 SYM2 … [D=126] · without symbols uses the
        first watchlist
      </div>
    </>
  );
}

export function registerCORR(): void {
  registerFunction({
    code: "CORR",
    name: "Correlation matrix",
    description: "Correlation of daily returns for a list of tickers (default: first watchlist)",
    ticker: "none",
    syntax: "CORR [SYMBOLS…] [D=DAYS]",
    examples: ["CORR", "CORR SPY QQQ TLT GLD BTCUSDT", "CORR NOVO-B.CO LLY D=126"],
    category: "Research",
    sectors: ["EQUITY", "CLIENT"],
    menu: ["Analytics"],
    args: [
      matching("days", /^D=\d{2,4}$/, "D=<days>", "lookback in trading days"),
      anyText("symbols", "tickers to correlate (default: first watchlist)"),
    ],
    actions: [],
    component: CORR,
  });
}
