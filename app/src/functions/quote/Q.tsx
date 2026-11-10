import { useEffect, useMemo, useRef, useState } from "react";
import { drill } from "@/core/items";
import type { Meta, Schemas } from "@/core/api";
import { useApi } from "@/core/data";
import { useLiveQuote } from "@/core/live";
import { useTape, tickDir, type Tape } from "@/core/tape";
import { registerFunction, type PanelProps } from "@/core/registry";
import { DataStatus, LatencyTag, Loading } from "@/components/DataStatus";
import { RangeBar } from "@/components/RangeBar";
import { Sparkline } from "@/components/Sparkline";
import {
  fmtBig,
  fmtChange,
  fmtDate,
  fmtHM,
  fmtNum,
  fmtPct,
  fmtPrice,
  fmtTime,
  isSameDay,
  signClass,
} from "@/lib/format";
import { NAValue, Sgn, V } from "@/components/V";
import { bookIsEstimated } from "@/lib/freshness";
import { lastSession } from "@/lib/series";
import { openExternal } from "@/lib/open";
import { venueTz } from "@/lib/venue";
import {
  avgVolume,
  range52w,
  sessionDayOf,
  sessionVwap,
  volumeVsAvgPct,
  vwapForSession,
} from "./stats";

type QuoteResponse = Schemas["QuoteResponse"];
type BarsResponse = Schemas["BarsResponse"];
type NewsResponse = Schemas["NewsResponse"];

/** Rows of the time & sales table on screen (the tape keeps more). */
export const TAPE_ROWS = 15;
export const HEADLINES = 5;

/** A value with where it came from: a dim source tag after it (SPEC §6.1). */
function From({ meta, note }: { meta: Meta | null | undefined; note?: string }) {
  if (!meta) return null;
  return (
    <span className="dim" title={note}>
      {" "}
      <LatencyTag meta={meta} />
    </span>
  );
}

/** Whether the quote's source is a feed of real prints (so a tape can fill). */
export function printsExpected(meta: Meta | null | undefined): boolean {
  return (
    !!meta &&
    meta.latency === "REALTIME" &&
    (meta.venue === "TRD" || meta.source === "Binance (stream)")
  );
}

export function TimeAndSales({
  tape,
  symbol,
  quoteMeta,
}: {
  tape: Tape;
  symbol: string;
  quoteMeta: Meta | null | undefined;
}) {
  if (!tape.rows.length) {
    const why = printsExpected(quoteMeta)
      ? `waiting for the first print from ${quoteMeta!.source}`
      : `no real-time trade feed for this instrument${
          quoteMeta ? ` (quote from ${quoteMeta.source}, ${quoteMeta.tag})` : ""
        }`;
    return (
      <div className="dim" style={{ padding: "0 8px" }} data-testid="tas-na">
        <NAValue /> · {why}
      </div>
    );
  }
  const tz = venueTz(symbol);
  const shown = tape.rows.map((r, i) => ({ r, dir: tickDir(tape.rows, i) })).reverse();
  return (
    <table className="grid" data-testid="tas">
      <thead>
        <tr>
          <th className="l">TIME</th>
          <th>PRICE</th>
          <th>SIZE</th>
          <th className="l">{tape.meta ? <LatencyTag meta={tape.meta} /> : null}</th>
        </tr>
      </thead>
      <tbody>
        {shown.slice(0, TAPE_ROWS).flatMap(({ r, dir }) => [
          <tr key={r.seq} data-seq={r.seq}>
            <td className="l dim">{fmtTime(r.t, false, tz)}</td>
            <td className={dir}>{fmtPrice(r.price, symbol)}</td>
            <td>
              <V>{fmtBig(r.size, 2)}</V>
            </td>
            <td />
          </tr>,
          r.missedBefore > 0 ? (
            <tr key={`gap-${r.seq}`} data-testid="tas-gap">
              <td colSpan={4} className="l dim">
                … {fmtNum(r.missedBefore, 0)} prints not received (more than the stream window)
              </td>
            </tr>
          ) : null,
        ])}
      </tbody>
    </table>
  );
}

function Q({ panel, active }: PanelProps) {
  const symbol = panel.ticker ?? "";
  const rest = useApi<QuoteResponse>(`/quote/${encodeURIComponent(symbol)}`, undefined, {
    staleMs: 5000,
  });
  const prio = active ? "focus" : "other";
  const live = useLiveQuote(symbol, prio);
  const tape = useTape(symbol || null, prio);
  // Prefer the newest of the REST snapshot and the live stream.
  const restTs = rest.data ? new Date(rest.data.meta.fetched_at).getTime() : 0;
  const useLive = live.quote && live.meta && live.at >= restTs;
  const q = useLive ? live.quote : rest.data?.data;
  const meta = useLive ? live.meta : rest.data?.meta;

  // A window not yet focused leaves tight-budget bar sources to the focused one (as GP).
  const [woken, setWoken] = useState(active);
  useEffect(() => {
    if (active) setWoken(true);
  }, [active]);
  const defer = woken ? undefined : true;
  const path = symbol ? `/bars/${encodeURIComponent(symbol)}` : null;
  const intraday = useApi<BarsResponse>(
    path,
    { interval: "5m", lookback: 5, defer },
    { refetchMs: 60_000, staleMs: 30_000 },
  );
  const daily = useApi<BarsResponse>(
    path,
    { interval: "1d", defer },
    { refetchMs: 3_600_000, staleMs: 600_000 },
  );
  const news = useApi<NewsResponse>(
    symbol ? "/news" : null,
    { symbol, limit: HEADLINES },
    { refetchMs: 120_000, staleMs: 60_000 },
  );

  const [flash, setFlash] = useState<{ dir: "up" | "down"; n: number } | null>(null);
  const prev = useRef<number | null>(null);
  useEffect(() => {
    const p = q?.price ?? null;
    if (p != null && prev.current != null && p !== prev.current) {
      setFlash((f) => ({ dir: p > prev.current! ? "up" : "down", n: (f?.n ?? 0) + 1 }));
    }
    prev.current = p;
  }, [q?.price]);

  const iBars = useMemo(() => intraday.data?.data ?? [], [intraday.data]);
  const dBars = useMemo(() => daily.data?.data ?? [], [daily.data]);
  const computedVwap = useMemo(() => sessionVwap(iBars), [iBars]);
  const avg30 = useMemo(() => avgVolume(dBars, 30, sessionDayOf(iBars)), [dBars, iBars]);
  const r52 = useMemo(() => range52w(dBars), [dBars]);
  const spark = useMemo(() => lastSession(iBars).map((b) => b.c), [iBars]);

  if (!q && rest.isLoading) return <Loading what={symbol} />;
  const spread = q?.bid != null && q?.ask != null ? q.ask - q.bid : null;
  const mid = q?.bid != null && q?.ask != null ? (q.ask + q.bid) / 2 : null;
  const est = bookIsEstimated(meta) ? " est." : "";
  const sessionVwapOk = vwapForSession(computedVwap, q?.low, q?.high);
  const vwap = q?.vwap ?? sessionVwapOk;
  const volPct = volumeVsAvgPct(q?.volume, avg30);
  const w52 =
    q?.week52_low != null && q?.week52_high != null
      ? { low: q.week52_low, high: q.week52_high, meta }
      : r52
        ? { ...r52, meta: daily.data?.meta }
        : null;
  const headlines = (news.data?.data ?? []).slice(0, HEADLINES);

  return (
    <>
      <DataStatus
        meta={meta}
        error={live.error && !useLive ? live.error : rest.error}
        fetching={rest.isFetching}
        updatedAt={rest.dataUpdatedAt}
      />
      {q ? (
        <div style={{ overflow: "auto" }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 14, padding: "6px 8px" }}>
            <span
              key={flash?.n}
              className={flash ? `flash-${flash.dir}` : ""}
              style={{ fontSize: 26, fontWeight: 700, color: "var(--fg)" }}
            >
              {fmtPrice(q.price, symbol)}
            </span>
            <span
              className={signClass(q.change, fmtChange(q.change, symbol, q.price))}
              style={{ fontSize: 16 }}
            >
              {fmtChange(q.change, symbol, q.price)} ({fmtPct(q.change_pct)})
            </span>
            <span className="dim">{q.currency ?? ""}</span>
            <span className="cyan">{q.market_state ?? ""}</span>
            <span style={{ marginLeft: "auto" }} data-testid="q-spark">
              <Sparkline
                values={spark}
                change={q.change}
                width={160}
                height={28}
                label={`${symbol} intraday`}
                title={`${intraday.data?.meta.source ?? ""} ${intraday.data?.meta.tag ?? ""} · last session, 5m`}
                naTitle={`intraday: ${
                  intraday.error
                    ? (intraday.error as Error).message
                    : intraday.isLoading
                      ? "loading"
                      : "no intraday bars"
                }`}
              />
            </span>
          </div>
          <div className="dim" style={{ padding: "0 8px 4px" }}>
            {q.name ?? symbol} · <V>{q.exchange}</V> · last trade {fmtTime(q.ts, true)}
          </div>
          {q.ext_price != null ? (
            <div style={{ padding: "0 8px 4px" }}>
              <span className="amber">
                {q.ext_session === "PRE" ? "PRE-MARKET" : "AFTER-HOURS"}
              </span>{" "}
              {fmtPrice(q.ext_price, symbol)}{" "}
              <Sgn as="span" v={q.ext_change_pct}>
                {fmtPct(q.ext_change_pct)}
              </Sgn>
            </div>
          ) : null}
          <div className="section-title">BOOK</div>
          <dl className="kv" style={{ gridTemplateColumns: "max-content 1fr max-content 1fr" }}>
            <dt>BID{est}</dt>
            <dd className={q.bid != null ? "up" : undefined}>
              <V>{fmtPrice(q.bid, symbol)}</V>{" "}
              {q.bid_size != null ? <span className="dim">× {fmtBig(q.bid_size, 2)}</span> : null}
            </dd>
            <dt>ASK{est}</dt>
            <dd className={q.ask != null ? "down" : undefined}>
              <V>{fmtPrice(q.ask, symbol)}</V>{" "}
              {q.ask_size != null ? <span className="dim">× {fmtBig(q.ask_size, 2)}</span> : null}
            </dd>
            <dt>SPREAD{est}</dt>
            <dd>
              <V>{fmtPrice(spread, symbol)}</V>
              {spread != null && mid ? (
                <span className="dim"> ({fmtNum((spread / mid) * 10000, 1)} bp)</span>
              ) : null}
            </dd>
            <dt>MID{est}</dt>
            <dd>
              <V>{fmtPrice(mid, symbol)}</V>
            </dd>
          </dl>
          {q.bid == null && q.ask == null ? (
            <div className="dim" style={{ padding: "0 8px" }}>
              No bid/ask from the source for this instrument or session.
            </div>
          ) : null}
          <div className="section-title">SESSION</div>
          <dl className="kv" style={{ gridTemplateColumns: "max-content 1fr max-content 1fr" }}>
            <dt>OPEN</dt>
            <dd>{fmtPrice(q.open, symbol)}</dd>
            <dt>PREV CLOSE</dt>
            <dd>{fmtPrice(q.prev_close, symbol)}</dd>
            <dt>HIGH</dt>
            <dd>{fmtPrice(q.high, symbol)}</dd>
            <dt>LOW</dt>
            <dd>{fmtPrice(q.low, symbol)}</dd>
            <dt>VWAP</dt>
            <dd data-testid="q-vwap">
              <V>{fmtPrice(vwap, symbol)}</V>
              {q.vwap != null ? (
                <From meta={meta} />
              ) : computedVwap != null && sessionVwapOk === null ? (
                <span
                  className="dim"
                  title="the 5m bars are not this quote's session (VWAP outside its low–high)"
                >
                  {" "}
                  bars ≠ session
                </span>
              ) : computedVwap != null ? (
                <>
                  <span className="dim"> calc 5m</span>
                  <From
                    meta={intraday.data?.meta}
                    note="computed from the last session's 5m bars"
                  />
                </>
              ) : null}
            </dd>
            <dt>VOLUME</dt>
            <dd>{fmtBig(q.volume)}</dd>
            <dt>VOL / 30D AVG</dt>
            <dd data-testid="q-volavg">
              <V>{fmtPct(volPct, 0, false)}</V>
              {avg30 != null ? (
                <span className="dim">
                  {" "}
                  of {fmtBig(avg30)}
                  <From meta={daily.data?.meta} note="average of the last 30 full sessions" />
                </span>
              ) : null}
            </dd>
            <dt>MKT CAP</dt>
            <dd>{fmtBig(q.market_cap)}</dd>
          </dl>
          <RangeBar symbol={symbol} label="DAY" low={q.low} high={q.high} value={q.price} />
          <RangeBar symbol={symbol} label="52W" low={w52?.low} high={w52?.high} value={q.price} />
          {w52 && w52.meta !== meta ? (
            <div className="dim" style={{ padding: "0 8px" }}>
              52W from daily bars
              <From meta={w52.meta} />
            </div>
          ) : null}
          <div className="section-title">TIME &amp; SALES</div>
          <TimeAndSales tape={tape} symbol={symbol} quoteMeta={meta} />
          <div className="section-title">
            HEADLINES {news.data ? <From meta={news.data.meta} /> : null}
          </div>
          <div data-testid="q-news">
            {news.isLoading ? (
              <div className="dim" style={{ padding: "0 8px" }}>
                loading…
              </div>
            ) : headlines.length ? (
              headlines.map((n) => (
                <div
                  key={n.id}
                  className="q-headline"
                  title={n.summary ?? n.headline}
                  onDoubleClick={() => void openExternal(n.url)}
                  style={{ padding: "1px 8px", display: "flex", gap: 8, cursor: "pointer" }}
                >
                  <span className="amber" style={{ minWidth: 70 }}>
                    {isSameDay(n.published) ? fmtHM(n.published) : fmtDate(n.published)}
                  </span>
                  <span className="dim" style={{ minWidth: 90 }}>
                    {n.source}
                  </span>
                  <span>{n.headline}</span>
                </div>
              ))
            ) : (
              <div className="dim" style={{ padding: "0 8px" }}>
                <NAValue /> ·{" "}
                {news.error
                  ? (news.error as Error).message
                  : "no headlines for this symbol from the enabled news sources"}
              </div>
            )}
          </div>
        </div>
      ) : null}
    </>
  );
}

export function registerQ(): void {
  registerFunction({
    code: "Q",
    name: "Quote",
    description:
      "Last, change, bid/ask with sizes, OHLC, VWAP, volume vs 30-day average, day and " +
      "52-week range, intraday sparkline, time & sales, latest headlines",
    ticker: "required",
    syntax: "<TICKER> Q",
    examples: ["AAPL US EQUITY Q", "BTCUSD CURNCY Q", "EURDKK CURNCY Q"],
    category: "Market",
    sectors: ["EQUITY", "INDEX", "COMDTY", "CURNCY"],
    menu: ["Quotes"],
    args: [],
    actions: [drill(1, "Chart", "GP"), drill(2, "Description", "DES"), drill(3, "News", "CN")],
    component: Q,
  });
}
