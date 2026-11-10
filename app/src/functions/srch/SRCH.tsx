/** SRCH (SPEC §7): global search — functions, securities, notes, news. */
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { api, type Schemas } from "@/core/api";
import { useApi } from "@/core/data";
import { useWorkspace } from "@/core/layout/store";
import { anyText, registerFunction, type PanelProps } from "@/core/registry";
import {
  matchNews,
  matchNotes,
  searchFunctions,
  searchSecurities,
  searchWords,
} from "@/core/search";
import { onSecIndex, secIndex } from "@/core/secindex";
import { DataStatus, ErrorBanner, Loading } from "@/components/DataStatus";
import { NAValue, V } from "@/components/V";
import { fmtDate } from "@/lib/format";
import { openExternal } from "@/lib/open";

const NEWS_LIMIT = 200;

function Section({
  title,
  count,
  unavailable,
  children,
}: {
  title: string;
  count: number;
  /** Nothing could be searched (the source failed or none is enabled): N.A., not "No matches". */
  unavailable?: string;
  children: React.ReactNode;
}) {
  return (
    <div data-testid={`srch-${title.toLowerCase()}`}>
      <div className="section-title">
        {title} <span className="dim">({unavailable ? <NAValue /> : count})</span>
      </div>
      {unavailable ? (
        <div className="dim menu-note">
          <NAValue /> not searched — {unavailable}
        </div>
      ) : count ? (
        children
      ) : (
        <div className="dim menu-note">No matches.</div>
      )}
    </div>
  );
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function Srch({ panel, update }: PanelProps) {
  const words = searchWords(panel.args);
  const [q, setQ] = useState(words.join(" "));
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => setQ(searchWords(panel.args).join(" ")), [panel.args]);
  useEffect(() => {
    if (!words.length) field.current?.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const index = useSyncExternalStore(onSecIndex, secIndex);
  const notes = useQuery({
    queryKey: ["notes"],
    queryFn: () => api.get<Schemas["Note"][]>("/notes"),
    staleTime: 60_000,
  });
  const news = useApi<Schemas["NewsResponse"]>(
    "/news",
    { limit: NEWS_LIMIT },
    { refetchMs: 120_000, staleMs: 60_000 },
  );
  const open = useWorkspace((s) => s.open);
  const fns = searchFunctions(words);
  const secs = searchSecurities(words, index);
  const noteHits = matchNotes(words, notes.data ?? []);
  const newsHits = matchNews(words, news.data?.data ?? []);
  return (
    <div style={{ overflow: "auto", flex: 1 }} data-testid="srch">
      <div className="ds">
        SEARCH{" "}
        <input
          ref={field}
          className="amber-field"
          data-testid="srch-field"
          value={q}
          spellCheck={false}
          placeholder="words to find in functions, securities, notes, news"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              update({ ...panel, args: searchWords([e.currentTarget.value]) });
            }
          }}
        />{" "}
        · Enter searches · every word must match
      </div>
      {!words.length ? (
        <div className="empty">Type words and press Enter.</div>
      ) : (
        <>
          <Section title="FUNCTIONS" count={fns.length}>
            <table className="grid">
              <tbody>
                {fns.map((f) => (
                  <tr key={f.code}>
                    <td className="l" style={{ width: 80 }}>
                      <button
                        type="button"
                        className="link amber"
                        onClick={() =>
                          open(
                            f.ticker === "required"
                              ? { fn: "HELP", args: [f.code] }
                              : { fn: f.code, args: [] },
                          )
                        }
                      >
                        {f.code}
                      </button>
                    </td>
                    <td className="l" style={{ width: 200 }}>
                      {f.name}
                    </td>
                    <td className="l dim">{f.description}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>
          <Section title="SECURITIES" count={secs.length}>
            <table className="grid">
              <tbody>
                {secs.map((s) => (
                  <tr key={s.id}>
                    <td className="l" style={{ width: 200 }}>
                      <button
                        type="button"
                        className="link amber"
                        onClick={() => open({ fn: "MENU", ticker: s.id, args: [] })}
                      >
                        {s.id}
                      </button>
                    </td>
                    <td className="l">
                      <V>{s.name}</V>
                    </td>
                    <td className="l dim">
                      <V>{s.exchange}</V>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="dim menu-note">source: local security index (offline)</div>
          </Section>
          {notes.error ? <ErrorBanner error={notes.error} /> : null}
          <Section
            title="NOTES"
            count={noteHits.length}
            unavailable={notes.error && !notes.data ? errorText(notes.error) : undefined}
          >
            <table className="grid">
              <tbody>
                {noteHits.map((n) => (
                  <tr key={n.symbol}>
                    <td className="l" style={{ width: 200 }}>
                      <button
                        type="button"
                        className="link amber"
                        onClick={() => open({ fn: "NOTE", ticker: n.symbol, args: [] })}
                      >
                        {n.symbol}
                      </button>
                    </td>
                    <td className="l dim">{n.body.slice(0, 160)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>
          {news.isLoading ? (
            <Loading what="news" />
          ) : (
            <Section
              title="NEWS"
              count={newsHits.length}
              unavailable={news.error && !news.data ? errorText(news.error) : undefined}
            >
              <table className="grid">
                <tbody>
                  {newsHits.map((n) => (
                    <tr key={n.id}>
                      <td className="l amber" style={{ width: 90 }}>
                        {fmtDate(n.published)}
                      </td>
                      <td className="l cyan" style={{ width: 130 }}>
                        {n.source}
                      </td>
                      <td className="l">
                        <button
                          type="button"
                          className="link"
                          onClick={() => void openExternal(n.url)}
                        >
                          {n.headline}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Section>
          )}
          <DataStatus
            meta={news.data?.meta}
            error={news.error}
            fetching={news.isFetching}
            updatedAt={news.dataUpdatedAt}
            extra={<span className="dim">news: the latest {NEWS_LIMIT} headlines searched</span>}
          />
        </>
      )}
    </div>
  );
}

export function registerSRCH(): void {
  registerFunction({
    code: "SRCH",
    name: "Search",
    description:
      "Global search: functions, securities (local index, offline), your notes and the latest " +
      "news headlines. Any text that is not a command opens it; so does the last autocomplete row.",
    ticker: "none",
    syntax: "SRCH <WORDS>",
    examples: ["SRCH NOVO", "SRCH CHART"],
    category: "System",
    sectors: [],
    menu: ["Help"],
    args: [anyText("words", "words to find; every word must match")],
    actions: [],
    title: (p) => (p.args.length ? `Search: ${searchWords(p.args).join(" ")}` : "Search"),
    component: Srch,
  });
}
