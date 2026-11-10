/**
 * News (SPEC §8): TOP (ranked headlines), N (news menu), CN (news of the loaded security).
 * The server clusters near-duplicates (≥ 0.85 title similarity within 2 h, earliest kept),
 * tags regions / asset classes / topics and ranks; this view filters, marks NEW (< 5 min),
 * shows ticker chips, a reader pane and the keyword alerts.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, errorMessage, type Schemas } from "@/core/api";
import { useApi } from "@/core/data";
import { executeCommand } from "@/core/executor";
import { runItem } from "@/core/items";
import { usePanelKeys } from "@/core/keys";
import { oneOf, registerFunction, type PanelProps } from "@/core/registry";
import { DataStatus, Loading } from "@/components/DataStatus";
import { NAValue } from "@/components/V";
import { fmtDate, fmtHM, fmtNum, isSameDay, relTime } from "@/lib/format";
import { openExternal } from "@/lib/open";
import {
  applyFilter,
  ASSETS,
  chipLabel,
  cycle,
  FILTER_TOKENS,
  filterFromArgs,
  isNew,
  N_MENU,
  REGIONS,
  serverNow,
  TOPICS,
  type NewsFilter,
  type NewsItem,
  type NewsResponse,
} from "./model";

type NewsAlerts = Schemas["NewsAlerts"];
const ALERTS_KEY = ["news-alerts"];

/** `HH:MM` today, else the date (news-server clock in DEMO). */
function timeLabel(iso: string, now: number): string {
  return isSameDay(iso, undefined, now) ? fmtHM(iso) : fmtDate(iso);
}

function Chips({ tickers }: { tickers: readonly string[] }) {
  return (
    <>
      {tickers.slice(0, 5).map((t) => (
        <button
          key={t}
          type="button"
          className="chip chip-security news-chip"
          title={`${t} — open its quote (Q)`}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            void executeCommand(`${t} Q`, { newPanel: true });
          }}
        >
          {chipLabel(t)}
        </button>
      ))}
    </>
  );
}

function Tag({ label, value }: { label: string; value: string | null }) {
  return (
    <span className={value ? "amber" : "dim"}>
      {label} {value ?? "ALL"}
    </span>
  );
}

function KeywordAlerts({ inputRef }: { inputRef: React.RefObject<HTMLInputElement | null> }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ALERTS_KEY, queryFn: () => api.get<NewsAlerts>("/news/alerts") });
  const [draft, setDraft] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const rules = q.data?.rules ?? [];
  const save = (keywords: string[]) =>
    api
      .put<NewsAlerts>("/news/alerts", { rules: keywords.map((keyword) => ({ keyword })) })
      .then((r) => {
        qc.setQueryData(ALERTS_KEY, r);
        setErr(null);
      })
      .catch((e: unknown) => setErr(errorMessage(e)));
  return (
    <span data-testid="news-alerts" title="Checked every 2 minutes while the app runs">
      <span className="dim">ALERTS</span>{" "}
      {rules.map((r) => (
        <span key={r.keyword} className="chip" data-testid="news-alert-rule">
          {r.keyword}
          <button
            type="button"
            className="link"
            title={`Remove the alert "${r.keyword}"`}
            onClick={() => void save(rules.filter((x) => x !== r).map((x) => x.keyword))}
          >
            ✕
          </button>
        </span>
      ))}
      <input
        ref={inputRef}
        data-testid="news-alert-input"
        value={draft}
        placeholder="keyword (b)"
        maxLength={40}
        style={{ width: 110 }}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            if (e.key === "Enter" && draft.trim().length >= 2)
              void save([...rules.map((x) => x.keyword), draft.trim()]).then(() => setDraft(""));
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
      {err ? <span className="down"> {err}</span> : null}
    </span>
  );
}

function Reader({ n, now }: { n: NewsItem | undefined; now: number }) {
  if (!n) return <div className="news-reader empty">Select a headline.</div>;
  return (
    <div className="news-reader" data-testid="news-reader">
      <div className="news-reader-head">{n.headline}</div>
      <div className="dim">
        <span className="cyan">{n.source}</span> via {n.provider} · {fmtDate(n.published)}{" "}
        {fmtHM(n.published)} ({relTime(n.published, now)})
        {isNew(n.published, now) ? <span className="news-new"> NEW</span> : null}
      </div>
      <div className="news-summary">
        {n.summary ?? (
          <>
            <NAValue /> <span className="dim">{n.summary_note ?? "no summary"}</span>
          </>
        )}
      </div>
      {n.tickers.length ? (
        <div>
          <Chips tickers={n.tickers} />
        </div>
      ) : null}
      <div className="dim" title="Tags come from tickers and keyword rules, not from the source">
        {[...n.regions, ...n.asset_classes, ...n.topics].join(" · ") || "no tags"}
      </div>
      <button
        type="button"
        className="link amber"
        data-testid="news-open"
        onClick={() => void openExternal(n.url)}
      >
        Open original ↗ (Enter)
      </button>
      {n.similar.length ? (
        <div data-testid="news-similar">
          <div className="dim">+{n.similar.length} similar</div>
          {n.similar.map((s) => (
            <div key={s.id} className="news-similar-row">
              <span className="amber">{fmtHM(s.published)}</span>{" "}
              <span className="cyan">{s.source}</span>{" "}
              <button type="button" className="link" onClick={() => void openExternal(s.url)}>
                {s.headline}
              </button>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function NewsView({ id, panel, fn }: PanelProps & { fn: "TOP" | "CN" }) {
  const symbol = fn === "CN" ? panel.ticker : undefined;
  const [sortOverride, setSort] = useState<"rank" | "time" | null>(null);
  const q = useApi<NewsResponse>(
    "/news",
    { symbol, limit: 120, sort: sortOverride ?? undefined },
    { refetchMs: 120_000, staleMs: 60_000 },
  );
  const [filter, setFilter] = useState<NewsFilter>(() => filterFromArgs(panel.args));
  const [text, setText] = useState("");
  const [sel, setSel] = useState(0);
  const [tick, setTick] = useState(0);
  const textRef = useRef<HTMLInputElement>(null);
  const alertRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const argKey = panel.args.join(" ");
  // A new command (TOP DK → TOP US) resets the filters; re-renders of the same one do not.
  useEffect(() => setFilter(filterFromArgs(argKey ? argKey.split(" ") : [])), [argKey]);
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 30_000); // NEW and relative times age
    return () => clearInterval(t);
  }, []);
  const now = useMemo(
    () => serverNow(q.data?.now, q.dataUpdatedAt),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [q.data?.now, q.dataUpdatedAt, tick],
  );
  const items = useMemo(
    () => applyFilter(q.data?.data ?? [], filter, text),
    [q.data, filter, text],
  );
  const cur = items[Math.min(sel, items.length - 1)];
  const sort = q.data?.sort ?? (fn === "CN" ? "time" : "rank");

  useEffect(() => {
    listRef.current?.querySelector(`[data-idx="${sel}"]`)?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  const setF = (f: NewsFilter) => {
    setFilter(f);
    setSel(0);
  };
  usePanelKeys(id, fn, (a) => {
    if (a === "down") setSel((s) => Math.min(items.length - 1, s + 1));
    else if (a === "up") setSel((s) => Math.max(0, s - 1));
    else if (a === "open" && cur) void openExternal(cur.url);
    else if (a === "filter") textRef.current?.focus();
    else if (a === "alert") alertRef.current?.focus();
    else if (a === "region")
      setF({
        ...filter,
        region: cycle(
          REGIONS.map((x) => x.value),
          filter.region,
        ),
      });
    else if (a === "asset")
      setF({
        ...filter,
        asset: cycle(
          ASSETS.map((x) => x.value),
          filter.asset,
        ),
      });
    else if (a === "topic")
      setF({
        ...filter,
        topic: cycle(
          TOPICS.map((x) => x.value),
          filter.topic,
        ),
      });
    else if (a === "mine") setF({ ...filter, mine: !filter.mine });
    else if (a === "sort") {
      setSort(sort === "rank" ? "time" : "rank");
      setSel(0);
    } else if (a === "refresh") void q.refetch();
    else if (a === "chart" && cur?.tickers[0])
      void executeCommand(`${cur.tickers[0]} GP`, { newPanel: true });
    else if (a === "company" && cur?.tickers[0])
      void executeCommand(`${cur.tickers[0]} CN`, { newPanel: true });
    else return false;
    return true;
  });

  if (q.isLoading) return <Loading what={symbol ? `${symbol} news` : "top news"} />;

  return (
    <>
      <DataStatus
        meta={q.data?.meta}
        error={q.error}
        fetching={q.isFetching}
        updatedAt={q.dataUpdatedAt}
        extra={
          q.data?.errors.length ? (
            <span className="down" title={q.data.errors.join("\n")}>
              {q.data.errors.length} SOURCE(S) FAILED
            </span>
          ) : null
        }
      />
      <div className="toolbar news-toolbar" data-testid="news-toolbar">
        <span className="amber">{symbol ? `${symbol} NEWS` : "TOP NEWS"}</span>
        <Tag
          label="REGION (r)"
          value={REGIONS.find((x) => x.value === filter.region)?.label ?? null}
        />
        <Tag
          label="ASSET (a)"
          value={ASSETS.find((x) => x.value === filter.asset)?.label ?? null}
        />
        <Tag
          label="TOPIC (t)"
          value={TOPICS.find((x) => x.value === filter.topic)?.label ?? null}
        />
        <span className={filter.mine ? "amber" : "dim"} data-testid="news-mine">
          MY LISTS (w) {filter.mine ? "ON" : "OFF"}
        </span>
        <span className="dim" data-testid="news-sort">
          SORT (s) {sort === "rank" ? "RANK" : "TIME"}
        </span>
        <input
          ref={textRef}
          value={text}
          placeholder="filter (f)"
          onChange={(e) => {
            setText(e.target.value);
            setSel(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape" || e.key === "Enter") {
              e.preventDefault();
              e.stopPropagation();
              (e.target as HTMLInputElement).blur();
              document.querySelector<HTMLElement>(`[data-panel-id="${id}"]`)?.focus();
            }
          }}
          style={{ width: 120 }}
        />
        <span className="dim" data-testid="news-count">
          {items.length} of {q.data?.data.length ?? 0}
        </span>
        <KeywordAlerts inputRef={alertRef} />
      </div>
      <div className="news-body">
        <div className="news-body-inner">
          <div ref={listRef} className="news-list" data-testid="news-list">
            {items.map((n, i) => (
              <div
                key={n.id}
                data-idx={i}
                data-testid="news-row"
                className={`news-row${i === sel ? " sel" : ""}`}
                title={`${n.source} via ${n.provider}${n.score != null ? ` · rank ${fmtNum(n.score, 3)}` : ""}`}
                onMouseDown={() => setSel(i)}
                onDoubleClick={() => void openExternal(n.url)}
              >
                <span className="amber">{timeLabel(n.published, now)}</span>
                <span className="dim">{relTime(n.published, now)}</span>
                <span
                  className="news-new"
                  data-testid={isNew(n.published, now) ? "news-new" : undefined}
                >
                  {isNew(n.published, now) ? "NEW" : ""}
                </span>
                <span className="cyan news-src">{n.source}</span>
                <span className="news-head">
                  {n.watch ? (
                    <span className="amber" title="On one of my watchlists">
                      ●{" "}
                    </span>
                  ) : null}
                  {n.headline} <Chips tickers={n.tickers} />
                  {n.similar.length ? (
                    <span className="dim" data-testid="news-similar-count">
                      {" "}
                      +{n.similar.length} similar
                    </span>
                  ) : null}
                </span>
              </div>
            ))}
            {!items.length && !q.error ? (
              <div className="empty">
                {q.data?.data.length ? "No headline matches the filters." : "No news items."}
              </div>
            ) : null}
          </div>
          <Reader n={cur} now={now} />
        </div>
      </div>
    </>
  );
}

function Top(props: PanelProps) {
  return <NewsView {...props} fn="TOP" />;
}

function Company(props: PanelProps) {
  return <NewsView {...props} fn="CN" />;
}

/** N — the news menu: numbered rows open TOP with a filter, or CN for the loaded security. */
function NMenu({ id, panel }: PanelProps) {
  const rows = nMenuRows(panel.ticker);
  const [sel, setSel] = useState(0);
  usePanelKeys(id, "N", (a) => {
    if (a === "down") setSel((s) => Math.min(rows.length - 1, s + 1));
    else if (a === "up") setSel((s) => Math.max(0, s - 1));
    else if (a === "open") runItem(id, rows[sel]!.n);
    else return false;
    return true;
  });
  return (
    <div style={{ overflow: "auto", flex: 1 }} data-testid="n-menu">
      <div className="ds">NEWS MENU · N + Enter or ↑↓ Enter</div>
      {rows.map((r, i) => (
        <button
          key={r.n}
          type="button"
          className={`menu-row${i === sel ? " on" : ""}`}
          onMouseDown={() => setSel(i)}
          onClick={() => runItem(id, r.n)}
        >
          <span className="item-n amber">{r.n})</span>
          {r.label} <span className="dim">— {r.hint}</span>
        </button>
      ))}
    </div>
  );
}

function nMenuRows(ticker: string | undefined) {
  const rows = N_MENU.map((m, i) => ({
    n: i + 1,
    label: m.label,
    hint: m.hint,
    to: { fn: "TOP", args: m.args } as { fn: string; ticker?: string; args: string[] },
  }));
  if (ticker)
    rows.push({
      n: rows.length + 1,
      label: `Company news: ${ticker}`,
      hint: "CN",
      to: { fn: "CN", ticker, args: [] },
    });
  return rows;
}

const SOURCES_TEXT =
  "Sources: Finnhub market news (general, forex, crypto, merger) and company news for US " +
  "listings, GDELT headlines for companies outside North America, RSS feeds you add in PDF " +
  "NEWS, Yahoo when opted in (PERSONAL USE). Near-duplicates (title similarity ≥ 0.85 within " +
  "2 h) collapse into the earliest. Rank = source weight × recency (half-life 6 h) × " +
  "watchlist match (×1.5) × cluster size. Region/asset/topic tags come from tickers and " +
  "keyword rules. NEW = under 5 minutes old. Keyword alerts are checked every 2 minutes while " +
  "the app runs.";

export function registerN(): void {
  const filterArgs = [
    oneOf(
      "region",
      REGIONS.map((x) => x.token),
      "region filter",
    ),
    oneOf(
      "asset",
      ASSETS.map((x) => x.token),
      "asset-class filter",
    ),
    oneOf(
      "topic",
      TOPICS.map((x) => x.token),
      "topic filter",
    ),
    oneOf("mine", ["MY"], "only tickers on my watchlists"),
  ];
  registerFunction({
    code: "TOP",
    name: "Top news",
    description: `Ranked headlines with NEW markers, ticker chips, filters and a reader. ${SOURCES_TEXT}`,
    ticker: "none",
    syntax: `TOP [${FILTER_TOKENS.join("|")}]…`,
    examples: ["TOP", "TOP DK", "TOP US EARNINGS", "TOP MY"],
    category: "Research",
    sectors: [],
    menu: ["News"],
    args: filterArgs,
    actions: [],
    component: Top,
    title: (p) => (p.args.length ? `Top news · ${p.args.join(" ")}` : "Top news"),
  });
  registerFunction({
    code: "N",
    name: "News menu",
    description:
      "News menu: numbered rows open TOP with a region, asset-class, topic or " +
      "watchlist filter; with a security loaded, its company news (CN).",
    ticker: "optional",
    syntax: "N · <SECURITY> N",
    examples: ["N", "NOVOB DC EQUITY N"],
    category: "Research",
    sectors: ["EQUITY"],
    menu: ["News"],
    args: [],
    actions: [],
    items: (p) =>
      nMenuRows(p.ticker).map((r) => ({
        n: r.n,
        label: r.label,
        content: true,
        to: () => ({ ...r.to }),
      })),
    component: NMenu,
    title: () => "News menu",
  });
  registerFunction({
    code: "CN",
    name: "Company news",
    description: `News for the loaded security, newest first (s switches to rank). ${SOURCES_TEXT}`,
    ticker: "required",
    syntax: "<SECURITY> CN",
    examples: ["AAPL US EQUITY CN", "NOVOB DC EQUITY CN"],
    category: "Research",
    sectors: ["EQUITY"],
    menu: ["News"],
    args: filterArgs,
    actions: [],
    component: Company,
    title: () => "Company news",
  });
}
