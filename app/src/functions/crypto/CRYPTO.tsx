import { useEffect, useMemo, useRef, useState } from "react";
import type { Schemas } from "@/core/api";
import { useApi } from "@/core/data";
import { executeCommand } from "@/core/executor";
import { usePanelKeys } from "@/core/keys";
import { useLayoutNotify } from "@/core/notify";
import { useLiveQuotes } from "@/core/live";
import { useVisibleKeys } from "@/core/visible";
import { matching, registerFunction, type PanelProps } from "@/core/registry";
import { DataStatus, LatencyTag, Loading } from "@/components/DataStatus";
import { fmtBig, fmtPct, fmtPrice } from "@/lib/format";
import { Sgn, V } from "@/components/V";

type Resp = Schemas["CryptoMarketsResponse"];

function CRYPTO({ id, panel, active }: PanelProps) {
  const limit = Math.min(250, Math.max(10, Number(panel.args[0]) || 50));
  const q = useApi<Resp>("/crypto/markets", { limit }, { refetchMs: 120_000, staleMs: 60_000 });
  const rows = useMemo(() => q.data?.data ?? [], [q.data]);
  const pairs = useMemo(
    () => rows.map((r) => r.binance_symbol).filter((s): s is string => !!s),
    [rows],
  );
  const [sel, setSel] = useState(0);
  const bodyRef = useRef<HTMLTableSectionElement>(null);
  const live = useLiveQuotes(pairs, active ? "focus" : "other", useVisibleKeys(bodyRef, pairs));
  const notify = useLayoutNotify();
  const cur = rows[sel];

  useEffect(() => {
    bodyRef.current?.querySelector(`[data-idx="${sel}"]`)?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  usePanelKeys(id, "CRYPTO", (a) => {
    if (a === "down") setSel((s) => Math.min(rows.length - 1, s + 1));
    else if (a === "up") setSel((s) => Math.max(0, s - 1));
    else if ((a === "chart" || a === "des" || a === "quote") && cur) {
      if (!cur.binance_symbol) {
        notify(`${cur.symbol}: no USDT pair on Binance — no chart source`, "error");
        return true;
      }
      const fn = a === "chart" ? "GP" : a === "des" ? "DES" : "Q";
      void executeCommand(`${cur.binance_symbol} ${fn}`, { newPanel: true });
    } else return false;
    return true;
  });

  if (q.isLoading) return <Loading what="crypto markets" />;
  const liveCount = pairs.filter((p) => live.get(p)?.quote).length;

  return (
    <>
      <DataStatus
        meta={q.data?.meta}
        error={q.error}
        fetching={q.isFetching}
        updatedAt={q.dataUpdatedAt}
        extra={
          <span>
            LIVE Binance: {liveCount}/{pairs.length} pairs (USDT)
          </span>
        }
      />
      <div style={{ overflow: "auto", flex: 1 }}>
        <table className="grid">
          <thead>
            <tr>
              <th>#</th>
              <th className="l">COIN</th>
              <th className="l">NAME</th>
              <th>PRICE</th>
              <th className="l">CCY</th>
              <th>24H%</th>
              <th>7D%</th>
              <th>MCAP (USD)</th>
              <th>VOL 24H (USD)</th>
              <th className="l">SRC</th>
            </tr>
          </thead>
          <tbody ref={bodyRef}>
            {rows.map((r, i) => {
              const st = r.binance_symbol ? live.get(r.binance_symbol) : undefined;
              const lq = st?.quote;
              const price = lq?.price ?? r.price_usd;
              const chg24 = lq?.change_pct ?? r.change_24h_pct;
              return (
                <tr
                  key={r.id}
                  data-idx={i}
                  data-row-key={r.binance_symbol ?? undefined}
                  className={i === sel ? "sel" : ""}
                  onMouseDown={() => setSel(i)}
                  onDoubleClick={() =>
                    r.binance_symbol &&
                    void executeCommand(`${r.binance_symbol} GP`, { newPanel: true })
                  }
                >
                  <td className="dim">
                    <V>{r.rank}</V>
                  </td>
                  <td className="l amber">{r.symbol}</td>
                  <td className="l" style={{ color: "var(--text)" }}>
                    {r.name}
                  </td>
                  <td>{fmtPrice(price, "crypto")}</td>
                  <td className="l dim">{lq ? "USDT" : "USD"}</td>
                  <Sgn as="td" v={chg24}>
                    {fmtPct(chg24)}
                  </Sgn>
                  <Sgn as="td" v={r.change_7d_pct}>
                    {fmtPct(r.change_7d_pct)}
                  </Sgn>
                  <td>{fmtBig(r.market_cap)}</td>
                  <td>{fmtBig(r.volume_24h)}</td>
                  <td className="l">
                    {lq && st?.meta ? (
                      <>
                        <LatencyTag meta={st.meta} /> <span className="dim">BINANCE</span>
                      </>
                    ) : q.data ? (
                      <>
                        <LatencyTag meta={q.data.meta} /> <span className="dim">COINGECKO</span>
                      </>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="ds hint">
        Charts, descriptions and quotes use the Binance USDT pair · rank, market cap, 7D from
        CoinGecko
      </div>
    </>
  );
}

export function registerCRYPTO(): void {
  registerFunction({
    code: "CRYPTO",
    name: "Top crypto",
    description: "Top coins by market cap (CoinGecko) with live Binance prices",
    ticker: "none",
    syntax: "CRYPTO [N]",
    examples: ["CRYPTO", "CRYPTO 100"],
    category: "Market",
    sectors: ["CURNCY"],
    menu: ["Crypto"],
    args: [matching("count", /^\d{1,3}$/, "<N>", "how many coins, 10–250 (default 50)")],
    actions: [],
    component: CRYPTO,
  });
}
