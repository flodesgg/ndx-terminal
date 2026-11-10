import { useRef } from "react";
import { drill } from "@/core/items";
import type { Schemas } from "@/core/api";
import { useApi } from "@/core/data";
import { usePanelKeys } from "@/core/keys";
import { useLiveQuote } from "@/core/live";
import { registerFunction, type PanelProps } from "@/core/registry";
import { DataStatus, Loading } from "@/components/DataStatus";
import { RangeBar } from "@/components/RangeBar";
import { fmtBig, fmtDate, fmtNum, fmtPct, fmtPrice } from "@/lib/format";
import { openExternal } from "@/lib/open";
import { NAValue, Sgn, V } from "@/components/V";

type ProfileResponse = Schemas["ProfileResponse"];

function Row({ k, v, cls }: { k: string; v: React.ReactNode; cls?: string }) {
  return (
    <>
      <dt>{k}</dt>
      <dd className={cls}>
        <V>{v}</V>
      </dd>
    </>
  );
}

function DES({ id, panel, active }: PanelProps) {
  const symbol = panel.ticker ?? "";
  const q = useApi<ProfileResponse>(`/profile/${encodeURIComponent(symbol)}`, undefined, {
    staleMs: 30 * 60_000,
  });
  const live = useLiveQuote(symbol, active ? "focus" : "other");
  const ref = useRef<HTMLDivElement>(null);
  usePanelKeys(id, "DES", (a) => {
    const el = ref.current;
    if (!el) return false;
    if (a === "down") el.scrollBy({ top: 40 });
    else if (a === "up") el.scrollBy({ top: -40 });
    else if (a === "web" && q.data?.data.website) void openExternal(q.data.data.website);
    else return false;
    return true;
  });

  if (q.isLoading) return <Loading what={`${symbol} profile`} />;
  const p = q.data?.data;
  const price = live.quote?.price ?? null;
  const days = p?.next_earnings
    ? Math.ceil((new Date(p.next_earnings).getTime() - Date.now()) / 86400000)
    : null;
  const extra = (p?.extra ?? {}) as Record<string, unknown>;
  const num = (k: string) => (typeof extra[k] === "number" ? (extra[k] as number) : null);

  return (
    <>
      <DataStatus
        meta={q.data?.meta}
        error={q.error}
        fetching={q.isFetching}
        updatedAt={q.dataUpdatedAt}
      />
      {p ? (
        <div ref={ref} style={{ overflow: "auto" }} className="sel-text">
          <div style={{ padding: "6px 8px" }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: "var(--fg)" }}>
              {p.name ?? symbol}
            </div>
            <div className="dim">
              {[p.quote_type, p.exchange, p.currency, p.country].filter(Boolean).join(" · ")}
            </div>
            {price != null ? (
              <div style={{ marginTop: 4 }}>
                <span className="amber" style={{ fontSize: 15 }}>
                  {fmtPrice(price, symbol)}
                </span>{" "}
                <Sgn as="span" v={live.quote?.change_pct}>
                  {fmtPct(live.quote?.change_pct)}
                </Sgn>{" "}
                <span className="dim">({live.meta?.source})</span>
              </div>
            ) : null}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 0 }}>
            <div>
              <div className="section-title">CLASSIFICATION</div>
              <dl className="kv">
                <Row k="SECTOR" v={<V>{p.sector}</V>} />
                <Row k="INDUSTRY" v={<V>{p.industry}</V>} />
                <Row k="EMPLOYEES" v={<V>{p.employees ? fmtNum(p.employees, 0) : null}</V>} />
                <Row
                  k="WEBSITE"
                  v={
                    p.website ? (
                      <a onClick={() => void openExternal(p.website!)}>
                        {p.website.replace(/^https?:\/\//, "")}
                      </a>
                    ) : (
                      <NAValue />
                    )
                  }
                />
              </dl>
              <div className="section-title">EVENTS</div>
              <dl className="kv">
                <Row
                  k="NEXT EARNINGS"
                  v={
                    p.next_earnings ? (
                      <>
                        {fmtDate(p.next_earnings)}
                        {days != null ? <span className="dim"> ({days}d)</span> : null}
                        {p.earnings_estimate ? <span className="amber"> EST</span> : null}
                      </>
                    ) : (
                      <NAValue />
                    )
                  }
                />
                <Row k="EX-DIVIDEND" v={fmtDate(p.ex_dividend_date)} />
              </dl>
            </div>
            <div>
              <div className="section-title">KEY STATS</div>
              <dl className="kv">
                <Row k="MARKET CAP" v={fmtBig(p.market_cap)} />
                <Row k="SHARES OUT" v={fmtBig(p.shares_outstanding)} />
                <Row k="P/E (TTM)" v={fmtNum(p.pe_trailing)} />
                <Row k="P/E (FWD)" v={fmtNum(p.pe_forward)} />
                <Row k="EPS (TTM)" v={fmtNum(p.eps_trailing)} />
                <Row k="DIV YIELD" v={<V>{fmtPct(p.dividend_yield, 2, false)}</V>} />
                <Row k="BETA" v={fmtNum(p.beta)} />
                <Row k="AVG VOLUME" v={fmtBig(p.avg_volume)} />
                <Row k="P/B" v={fmtNum(num("price_to_book"))} />
                <Row
                  k="50D / 200D MA"
                  v={
                    <>
                      <V>{fmtPrice(num("fifty_day_avg"), symbol)}</V>
                      {" / "}
                      <V>{fmtPrice(num("two_hundred_day_avg"), symbol)}</V>
                    </>
                  }
                />
              </dl>
            </div>
          </div>
          <RangeBar
            symbol={symbol}
            label="52W"
            low={p.week52_low}
            high={p.week52_high}
            value={price}
          />
          {p.asset_class === "crypto" ? (
            <dl className="kv">
              <Row
                k="PAIR"
                v={`${String(extra.base_asset ?? "")} / ${String(extra.quote_asset ?? "")}`}
              />
              <Row k="STATUS" v={<V>{extra.status == null ? null : String(extra.status)}</V>} />
              <Row
                k="24H HIGH / LOW"
                v={`${fmtPrice(num("high_24h"), symbol)} / ${fmtPrice(num("low_24h"), symbol)}`}
              />
              <Row k="24H VOLUME" v={fmtBig(num("volume_24h_base"))} />
            </dl>
          ) : null}
          {p.description ? (
            <>
              <div className="section-title">BUSINESS</div>
              <p style={{ padding: "4px 8px", margin: 0, color: "var(--text)", lineHeight: 1.5 }}>
                {p.description}
              </p>
            </>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

export function registerDES(): void {
  registerFunction({
    code: "DES",
    name: "Description",
    description: "Profile, sector, key stats, 52-week range, next earnings date",
    ticker: "required",
    syntax: "<TICKER> DES",
    examples: ["AAPL US EQUITY DES", "NOVOB DC EQUITY DES", "BTCUSD CURNCY DES"],
    category: "Research",
    sectors: ["EQUITY", "CURNCY"],
    menu: ["Company"],
    args: [],
    actions: [
      drill(1, "Quote", "Q"),
      drill(2, "Chart", "GP"),
      drill(3, "Financials", "FA"),
      drill(4, "News", "CN"),
    ],
    component: DES,
  });
}
