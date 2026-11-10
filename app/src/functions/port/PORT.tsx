import { useEffect, useRef, useState } from "react";
import { useQuery, type QueryClient } from "@tanstack/react-query";
import { api, errorMessage, type Schemas } from "@/core/api";
import type { ParsedCommand } from "@/core/command/parser";
import { executeCommand } from "@/core/executor";
import { usePanelKeys } from "@/core/keys";
import { useWorkspace } from "@/core/layout/store";
import { anyText, registerFunction, type PanelProps } from "@/core/registry";
import { ErrorBanner, LatencyTag, Loading } from "@/components/DataStatus";
import { fmtBig, fmtBigSigned, fmtNum, fmtPct, fmtPrice, fmtTime } from "@/lib/format";
import { NAValue, Sgn, V } from "@/components/V";

type Portfolio = Schemas["PortfolioResponse"];
type Trade = Schemas["Trade"];

let qc: QueryClient | null = null;
export function setPortfolioClient(c: QueryClient): void {
  qc = c;
}
const refresh = () => qc?.invalidateQueries({ queryKey: ["portfolio"] });

const CSV_HELP =
  "CSV with a header row: date,security,side,qty,price[,fees][,note] — date YYYY-MM-DD, " +
  "side BUY or SELL, fees added to the price. All or nothing: any bad row imports nothing.";

/** "PORT BUY AAPL 10 @180" / "PORT SELL AAPL 5" / "PORT DEL 7" */
export function parseTradeArgs(
  args: string[],
): { side: "BUY" | "SELL"; symbol: string; qty: number; price: number | null } | null {
  const [side, symbol, qtyRaw, priceRaw] = args;
  if ((side !== "BUY" && side !== "SELL") || !symbol || !qtyRaw) return null;
  const qty = Number(qtyRaw);
  if (!Number.isFinite(qty) || qty <= 0) return null;
  let price: number | null = null;
  if (priceRaw !== undefined) {
    if (!priceRaw.startsWith("@")) return null;
    price = Number(priceRaw.slice(1));
    if (!Number.isFinite(price) || price <= 0) return null;
  }
  return { side, symbol, qty, price };
}

async function portAction(cmd: ParsedCommand): Promise<boolean> {
  const ws = useWorkspace.getState();
  const sub = cmd.args[0];
  if (sub === "BUY" || sub === "SELL") {
    const t = parseTradeArgs(cmd.args);
    if (!t) throw new Error("Usage: PORT BUY|SELL <SYMBOL> <QTY> [@PRICE]");
    const trade = await api.post<Trade>("/portfolio/trades", {
      symbol: t.symbol,
      qty: t.side === "BUY" ? t.qty : -t.qty,
      price: t.price,
    });
    ws.notify(
      `${t.side} ${trade.qty > 0 ? trade.qty : -trade.qty} ${trade.symbol} @ ${fmtPrice(trade.price, trade.symbol)} ${trade.note}`,
    );
    void refresh();
    return true;
  }
  if (sub === "DEL") {
    const id = Number(cmd.args[1]);
    if (!Number.isInteger(id)) throw new Error("Usage: PORT DEL <TRADE_ID>");
    await api.del(`/portfolio/trades/${id}`);
    ws.notify(`Trade #${id} deleted`);
    void refresh();
    return true;
  }
  return false;
}

function ExposureBars({ title, rows }: { title: string; rows: Schemas["Exposure"][] }) {
  return (
    <div style={{ flex: 1, minWidth: 220 }}>
      <div className="section-title">{title}</div>
      {rows.map((r) => (
        <div
          key={r.name}
          style={{
            display: "grid",
            gridTemplateColumns: "130px 1fr 52px",
            gap: 6,
            padding: "1px 8px",
            alignItems: "center",
          }}
        >
          <span
            style={{
              color: "var(--text)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {r.name}
          </span>
          <div style={{ height: 8, background: "var(--track)" }}>
            <div
              style={{
                width: `${Math.min(100, r.weight)}%`,
                height: "100%",
                background: "var(--fg-dim)",
              }}
            />
          </div>
          <span style={{ textAlign: "right" }}>{fmtPct(r.weight, 2, false)}</span>
        </div>
      ))}
    </div>
  );
}

function PORT({ id }: PanelProps) {
  const q = useQuery({
    queryKey: ["portfolio"],
    queryFn: () => api.get<Portfolio>("/portfolio"),
    refetchInterval: 30_000,
  });
  const trades = useQuery({
    queryKey: ["portfolio", "trades"],
    queryFn: () => api.get<Trade[]>("/portfolio/trades"),
  });
  const [view, setView] = useState<"positions" | "trades">("positions");
  const [sel, setSel] = useState(0);
  const body = useRef<HTMLTableSectionElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [importMsg, setImportMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const importCsv = async (f: File) => {
    try {
      const r = await api.post<Schemas["TradeImportResult"]>("/portfolio/import", {
        csv: await f.text(),
      });
      setImportMsg(
        r.errors.length
          ? { ok: false, text: `Nothing imported: ${r.errors.join(" · ")}` }
          : { ok: true, text: `Imported ${r.imported} trades from ${f.name}` },
      );
      void refresh();
    } catch (e) {
      setImportMsg({ ok: false, text: `Import failed: ${errorMessage(e)}` });
    }
  };
  const p = q.data;
  const rows = view === "positions" ? (p?.positions ?? []) : [...(trades.data ?? [])].reverse();
  useEffect(() => {
    body.current?.querySelector(`[data-idx="${sel}"]`)?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  usePanelKeys(id, "PORT", (a) => {
    if (a === "down") setSel((s) => Math.min(rows.length - 1, s + 1));
    else if (a === "up") setSel((s) => Math.max(0, s - 1));
    else if (a === "trades") {
      setView((v) => (v === "positions" ? "trades" : "positions"));
      setSel(0);
    } else if (a === "import") {
      fileRef.current?.click();
    } else if (a === "chart" && view === "positions" && p?.positions[sel]) {
      void executeCommand(`${p.positions[sel].symbol} GP`, { newPanel: true });
    } else if (a === "delete" && view === "trades") {
      const t = rows[sel] as Trade | undefined;
      if (t) void executeCommand(`PORT DEL ${t.id}`);
    } else if (a === "refresh") void refresh();
    else return false;
    return true;
  });

  if (q.isLoading) return <Loading what="portfolio" />;
  const base = p?.base_currency ?? "";
  return (
    <>
      {q.error ? <ErrorBanner error={q.error} /> : null}
      {p ? (
        <div className="ds" style={{ gap: 18, fontSize: 12 }}>
          <span>
            VALUE <b className="amber">{fmtBig(p.total_value)}</b> {base}
            {p.partial ? (
              <b className="amber" title={p.warnings.join("\n")}>
                {" "}
                PARTIAL
              </b>
            ) : null}
          </span>
          <span>
            COST <span style={{ color: "var(--text)" }}>{fmtBig(p.total_cost)}</span>
          </span>
          <span>
            UNREALIZED{" "}
            <Sgn as="span" v={p.unrealized_pnl}>
              {fmtBigSigned(p.unrealized_pnl)}
            </Sgn>
          </span>
          <span>
            REALIZED{" "}
            <Sgn as="span" v={p.realized_pnl}>
              {fmtBigSigned(p.realized_pnl)}
            </Sgn>
          </span>
          <span>
            DAY{" "}
            <Sgn as="span" v={p.day_pnl}>
              {fmtBigSigned(p.day_pnl)}
            </Sgn>
          </span>
          <span className="dim">as of {fmtTime(p.as_of)}</span>
        </div>
      ) : null}
      {p?.warnings.length ? (
        <div className="ds amber" style={{ whiteSpace: "normal" }}>
          NOTE: {p.warnings.join(" · ")}
        </div>
      ) : null}
      {importMsg ? (
        <div
          className={`ds ${importMsg.ok ? "amber" : "down"}`}
          style={{ whiteSpace: "normal" }}
          data-testid="port-import-msg"
        >
          {importMsg.text}
        </div>
      ) : null}
      <div className="toolbar">
        <button className={view === "positions" ? "on" : ""} onClick={() => setView("positions")}>
          POSITIONS {p?.positions.length ?? 0}
        </button>
        <button className={view === "trades" ? "on" : ""} onClick={() => setView("trades")}>
          TRADES {trades.data?.length ?? 0}
        </button>
        <button onClick={() => fileRef.current?.click()} title={CSV_HELP}>
          IMPORT CSV
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".csv,text/csv"
          data-testid="port-import"
          style={{ display: "none" }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) void importCsv(f);
          }}
        />
        <span className="hint" style={{ marginLeft: "auto" }}>
          PORT BUY AAPL 10 · PORT SELL AAPL 5 @210 · fills at the live quote unless @price is given
        </span>
      </div>
      <div style={{ overflow: "auto", flex: 1, minHeight: 80 }}>
        {view === "positions" ? (
          <table className="grid">
            <thead>
              <tr>
                <th className="l">SYMBOL</th>
                <th>QTY</th>
                <th>AVG COST</th>
                <th>LAST</th>
                <th className="l">CCY</th>
                <th>VALUE {base}</th>
                <th>P&amp;L</th>
                <th>P&amp;L%</th>
                <th>DAY</th>
                <th>WEIGHT</th>
                <th className="l">SECTOR</th>
                <th className="l">SRC</th>
              </tr>
            </thead>
            <tbody ref={body}>
              {(p?.positions ?? []).map((x, i) => (
                <tr
                  key={x.symbol}
                  data-idx={i}
                  className={i === sel ? "sel" : ""}
                  onMouseDown={() => setSel(i)}
                >
                  <td className="l amber">{x.symbol}</td>
                  <td>{fmtNum(x.qty, x.qty % 1 ? 4 : 0)}</td>
                  <td>{fmtPrice(x.avg_cost, x.symbol)}</td>
                  <td>{fmtPrice(x.last, x.symbol)}</td>
                  <td className="l dim">{x.currency ?? "?"}</td>
                  <td>{fmtBig(x.market_value)}</td>
                  <Sgn as="td" v={x.unrealized_pnl}>
                    {fmtBigSigned(x.unrealized_pnl)}
                  </Sgn>
                  <Sgn as="td" v={x.unrealized_pct}>
                    {fmtPct(x.unrealized_pct)}
                  </Sgn>
                  <Sgn as="td" v={x.day_pnl}>
                    {fmtBigSigned(x.day_pnl)}
                  </Sgn>
                  <td>
                    <V>{fmtPct(x.weight, 2, false)}</V>
                  </td>
                  <td className="l dim">{x.sector ?? ""}</td>
                  <td className="l">{x.quote_meta ? <LatencyTag meta={x.quote_meta} /> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <table className="grid">
            <thead>
              <tr>
                <th>#</th>
                <th className="l">TIME</th>
                <th className="l">SYMBOL</th>
                <th className="l">SIDE</th>
                <th>QTY</th>
                <th>PRICE</th>
                <th className="l">NOTE</th>
              </tr>
            </thead>
            <tbody ref={body}>
              {(rows as Trade[]).map((t, i) => (
                <tr
                  key={t.id}
                  data-idx={i}
                  className={i === sel ? "sel" : ""}
                  onMouseDown={() => setSel(i)}
                >
                  <td className="dim">{t.id}</td>
                  <td className="l dim">{fmtTime(t.ts, true)}</td>
                  <td className="l amber">{t.symbol}</td>
                  <td className={`l ${t.qty > 0 ? "up" : "down"}`}>{t.qty > 0 ? "BUY" : "SELL"}</td>
                  <td>{fmtNum(Math.abs(t.qty), Math.abs(t.qty) % 1 ? 4 : 0)}</td>
                  <td>{fmtPrice(t.price, t.symbol)}</td>
                  <td className="l dim">{t.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {p && !p.positions.length && view === "positions" ? (
          <div className="empty">
            Empty paper portfolio. Try <span className="amber">PORT BUY SPY 10</span> or{" "}
            <span className="amber">PORT BUY NOVO-B.CO 20</span>.
          </div>
        ) : null}
      </div>
      {p && p.positions.length ? (
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            borderTop: "1px solid var(--line)",
            maxHeight: "42%",
            overflow: "auto",
            flex: "0 0 auto",
          }}
        >
          <ExposureBars title="BY SECTOR" rows={p.by_sector} />
          <ExposureBars title="BY ASSET CLASS" rows={p.by_asset_class} />
          <div style={{ flex: 1, minWidth: 220 }}>
            <div className="section-title">RISK</div>
            {p.risk ? (
              <dl className="kv">
                <dt>VOLATILITY (ann.)</dt>
                <dd>
                  <V>
                    {p.risk.volatility_ann != null
                      ? fmtPct(p.risk.volatility_ann * 100, 2, false)
                      : null}
                  </V>
                </dd>
                <dt>MAX DRAWDOWN</dt>
                <dd className="down">
                  <V>{p.risk.max_drawdown != null ? fmtPct(p.risk.max_drawdown * 100) : null}</V>
                </dd>
                <dt>BETA vs SPY</dt>
                <dd>{fmtNum(p.risk.beta_vs_spy, 2)}</dd>
                <dt className="dim">METHOD</dt>
                <dd className="dim" style={{ textAlign: "left", whiteSpace: "normal" }}>
                  {p.risk.method}
                </dd>
              </dl>
            ) : (
              <div className="empty">
                <NAValue />
              </div>
            )}
          </div>
        </div>
      ) : null}
    </>
  );
}

export function registerPORT(): void {
  registerFunction({
    code: "PORT",
    name: "Paper portfolio",
    description:
      "Positions, P&L, sector/asset-class exposure, volatility, max drawdown, beta vs SPY",
    ticker: "none",
    syntax: "PORT · PORT BUY|SELL <SYMBOL> <QTY> [@PRICE] · PORT DEL <TRADE_ID>",
    examples: ["PORT", "PORT BUY AAPL 10", "PORT SELL AAPL 5 @230", "PORT BUY BTCUSDT 0.05"],
    category: "Tools",
    sectors: ["CLIENT"],
    menu: ["Portfolio"],
    args: [anyText("trade", "BUY|SELL <SYMBOL> <QTY> [@PRICE] · DEL <TRADE_ID>")],
    actions: [],
    component: PORT,
    run: portAction,
    structuredArgs: (a) =>
      parseTradeArgs(a) !== null || (a[0] === "DEL" && /^\d+$/.test(a[1] ?? "")),
  });
}
