import { useMemo, useState } from "react";
import { executeCommand } from "@/core/executor";
import { usePanelKeys } from "@/core/keys";
import { useLiveQuotes } from "@/core/live";
import { registerFunction, type PanelProps } from "@/core/registry";
import { LatencyTag } from "@/components/DataStatus";
import { directionMark, fmtPct, fmtPrice, fmtTime, signClass } from "@/lib/format";
import { Sgn } from "@/components/V";
import { CURRENCIES, cross, usdSymbol, type UsdRate } from "./matrix";

function FX({ id, panel, active }: PanelProps) {
  const ccys = CURRENCIES;
  const symbols = useMemo(() => ccys.filter((c) => c !== "USD").map(usdSymbol), [ccys]);
  const quotes = useLiveQuotes(symbols, active ? "focus" : "other");
  const rates = new Map<string, UsdRate>();
  for (const c of ccys) {
    if (c === "USD") continue;
    const q = quotes.get(usdSymbol(c))?.quote;
    rates.set(c, { last: q?.price ?? null, prev: q?.prev_close ?? null });
  }
  const [cell, setCell] = useState<[number, number]>([1, 0]);
  const [r, c] = cell;
  const base = ccys[r]!;
  const quote = ccys[c]!;
  const selected = cross(base, quote, rates);

  usePanelKeys(id, panel.fn === "FXC" ? "FXC" : "FX", (a) => {
    const n = ccys.length;
    if (a === "down") setCell(([y, x]) => [Math.min(n - 1, y + 1), x]);
    else if (a === "up") setCell(([y, x]) => [Math.max(0, y - 1), x]);
    else if (a === "right") setCell(([y, x]) => [y, Math.min(n - 1, x + 1)]);
    else if (a === "left") setCell(([y, x]) => [y, Math.max(0, x - 1)]);
    else if (a === "chart" && base !== quote)
      void executeCommand(`${base}${quote} GP`, { newPanel: true });
    else if (a === "quote" && base !== quote)
      void executeCommand(`${base}${quote} Q`, { newPanel: true });
    else return false;
    return true;
  });

  const legs = [base, quote].filter((x) => x !== "USD").map((x) => quotes.get(usdSymbol(x)));
  const missing = ccys.filter((x) => x !== "USD" && rates.get(x)?.last == null);

  return (
    <>
      <div className="ds">
        <span>
          Cross rates derived from USD pairs · cell = units of COLUMN per 1 ROW · colour = change vs
          previous close
        </span>
        {missing.length ? <span className="down">NO DATA: {missing.join(" ")}</span> : null}
      </div>
      <div style={{ overflow: "auto", flex: 1 }}>
        <table className="grid">
          <thead>
            <tr>
              <th className="l">1 ↓ =</th>
              {ccys.map((x, j) => (
                <th key={x} style={{ color: j === c ? "var(--accent)" : undefined }}>
                  {x}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ccys.map((row, i) => (
              <tr key={row}>
                <td
                  className="l"
                  style={{ color: i === r ? "var(--accent)" : "var(--fg)", fontWeight: 700 }}
                >
                  {row}
                </td>
                {ccys.map((col, j) => {
                  const x = cross(row, col, rates);
                  const isSel = i === r && j === c;
                  return (
                    <td
                      key={col}
                      className={row === col ? "dim" : signClass(x.changePct)}
                      style={{
                        background: isSel
                          ? "var(--sel-bg)"
                          : i === r || j === c
                            ? "var(--bg-hover)"
                            : undefined,
                        cursor: "pointer",
                      }}
                      title={x.changePct != null ? fmtPct(x.changePct) : undefined}
                      onMouseDown={() => setCell([i, j])}
                      onDoubleClick={() =>
                        row !== col && void executeCommand(`${row}${col} GP`, { newPanel: true })
                      }
                    >
                      {row === col ? "" : fmtPrice(x.rate, `${row}${col}`)}
                      {row === col ? null : (
                        <span className="dir-mark">{directionMark(x.changePct)}</span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        <div className="section-title">
          {base}/{quote}
        </div>
        <dl className="kv">
          <dt>RATE</dt>
          <dd>{base === quote ? "" : fmtPrice(selected.rate, `${base}${quote}`)}</dd>
          <dt>CHANGE</dt>
          <Sgn as="dd" v={selected.changePct}>
            {fmtPct(selected.changePct)}
          </Sgn>
          {legs.map((st, i) => (
            <FragmentLeg key={i} label={[base, quote].filter((x) => x !== "USD")[i]!} st={st} />
          ))}
        </dl>
      </div>
      <div className="ds hint">▲ ▼ day change of the cross (the % is on hover and below)</div>
    </>
  );
}

function FragmentLeg({
  label,
  st,
}: {
  label: string;
  st: ReturnType<Map<string, import("@/core/live").QuoteState>["get"]>;
}) {
  return (
    <>
      <dt>LEG USD/{label}</dt>
      <dd>
        {fmtPrice(st?.quote?.price, `USD${label}`)} · {fmtTime(st?.quote?.ts, true)}{" "}
        {st?.meta ? (
          <>
            <LatencyTag meta={st.meta} /> <span className="dim">{st.meta.source}</span>
          </>
        ) : null}
        {st?.error ? <span className="down"> {st.error}</span> : null}
      </dd>
    </>
  );
}

export function registerFX(): void {
  for (const code of ["FXC", "FX"] as const)
    registerFunction({
      code,
      name: code === "FXC" ? "Currency matrix" : "Currency matrix (FXC)",
      description:
        "Cross-rate matrix for majors + DKK, SEK, NOK, UAH with daily change" +
        (code === "FX" ? " (alias of FXC)" : ""),
      ticker: "none",
      syntax: code,
      examples: [code],
      category: "Market",
      sectors: ["CURNCY"],
      menu: ["FX"],
      args: [],
      actions: [],
      component: FX,
    });
}
