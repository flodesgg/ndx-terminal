/**
 * TOP / N / CN (SPEC §8) — pure helpers: filter tokens, filtering, the NEW marker, the N menu.
 * Clusters, tags and rank come from the server (`/news`, server/ndx_server/news.py).
 */
import type { Schemas } from "@/core/api";

export type NewsItem = Schemas["NewsItem"];
export type NewsResponse = Schemas["NewsResponse"];
export type NewsRegion = Schemas["NewsItem"]["regions"][number];
export type NewsAsset = Schemas["NewsItem"]["asset_classes"][number];
export type NewsTopic = Schemas["NewsItem"]["topics"][number];

/** Command tokens → tag values. Tokens avoid sector keys and function codes (`TOP CRYPTO` is
 * fine: a function's args never parse as a security, see parser rule 3/4). */
export const REGIONS: readonly { token: string; value: NewsRegion; label: string }[] = [
  { token: "US", value: "US", label: "US" },
  { token: "EU", value: "EU", label: "Europe" },
  { token: "DK", value: "DK", label: "Denmark" },
  { token: "APAC", value: "APAC", label: "Asia-Pacific" },
];
export const ASSETS: readonly { token: string; value: NewsAsset; label: string }[] = [
  { token: "STOCKS", value: "EQUITY", label: "Stocks" },
  { token: "FX", value: "FX", label: "FX" },
  { token: "RATES", value: "RATES", label: "Rates" },
  { token: "COMMOD", value: "COMMODITIES", label: "Commodities" },
  { token: "CRYPTO", value: "CRYPTO", label: "Crypto" },
];
export const TOPICS: readonly { token: string; value: NewsTopic; label: string }[] = [
  { token: "EARNINGS", value: "EARNINGS", label: "Earnings" },
  { token: "MA", value: "M&A", label: "M&A" },
  { token: "CB", value: "CENTRAL BANKS", label: "Central banks" },
  { token: "MACRO", value: "MACRO", label: "Macro" },
  { token: "IPO", value: "IPO", label: "IPO" },
];
export const MINE_TOKEN = "MY";

export interface NewsFilter {
  region: NewsRegion | null;
  asset: NewsAsset | null;
  topic: NewsTopic | null;
  /** Only items with a ticker on one of my watchlists. */
  mine: boolean;
}

export const NO_FILTER: NewsFilter = { region: null, asset: null, topic: null, mine: false };

export function filterFromArgs(args: readonly string[]): NewsFilter {
  const f = { ...NO_FILTER };
  for (const raw of args) {
    const a = raw.toUpperCase();
    const r = REGIONS.find((x) => x.token === a);
    const s = ASSETS.find((x) => x.token === a);
    const t = TOPICS.find((x) => x.token === a);
    if (r) f.region = r.value;
    else if (s) f.asset = s.value;
    else if (t) f.topic = t.value;
    else if (a === MINE_TOKEN) f.mine = true;
  }
  return f;
}

export function argsFromFilter(f: NewsFilter): string[] {
  return [
    REGIONS.find((x) => x.value === f.region)?.token,
    ASSETS.find((x) => x.value === f.asset)?.token,
    TOPICS.find((x) => x.value === f.topic)?.token,
    f.mine ? MINE_TOKEN : undefined,
  ].filter((x): x is string => !!x);
}

export const FILTER_TOKENS: readonly string[] = [
  ...REGIONS.map((x) => x.token),
  ...ASSETS.map((x) => x.token),
  ...TOPICS.map((x) => x.token),
  MINE_TOKEN,
];

/** Text filter over headline, publisher, summary and tickers. */
export function applyFilter(items: readonly NewsItem[], f: NewsFilter, text = ""): NewsItem[] {
  const q = text.trim().toLowerCase();
  return items.filter(
    (n) =>
      (!f.region || n.regions.includes(f.region)) &&
      (!f.asset || n.asset_classes.includes(f.asset)) &&
      (!f.topic || n.topics.includes(f.topic)) &&
      (!f.mine || n.watch) &&
      (!q ||
        `${n.headline} ${n.source} ${n.summary ?? ""} ${n.tickers.join(" ")}`
          .toLowerCase()
          .includes(q)),
  );
}

/** null → first → … → last → null. */
export function cycle<T>(values: readonly T[], cur: T | null): T | null {
  if (cur === null) return values[0] ?? null;
  const i = values.indexOf(cur);
  return i < 0 || i === values.length - 1 ? null : values[i + 1]!;
}

export const NEW_MS = 5 * 60_000;

/** The server's clock now: its `now` when the list was fetched plus the time since (DEMO's
 * clock is fixed, so NEW and relative times stay reproducible there). */
export function serverNow(
  now: string | null | undefined,
  fetchedAt: number,
  clientNow: number = Date.now(),
): number {
  const base = now ? Date.parse(now) : NaN;
  return Number.isNaN(base) ? clientNow : base + Math.max(0, clientNow - fetchedAt);
}

/** NEW: published less than 5 minutes ago (SPEC §8). */
export function isNew(published: string, nowMs: number): boolean {
  const t = Date.parse(published);
  return !Number.isNaN(t) && nowMs - t < NEW_MS && nowMs - t >= -60_000;
}

/** The short ticker shown on a chip: `NOVOB DC EQUITY` → `NOVOB`. */
export function chipLabel(id: string): string {
  return id.split(" ")[0] ?? id;
}

/** Rows of the N menu: each opens TOP with a filter (or CN for the loaded security). */
export const N_MENU: readonly { label: string; args: string[]; hint: string }[] = [
  { label: "Top news", args: [], hint: "all sources, ranked" },
  { label: "My watchlists", args: [MINE_TOKEN], hint: "tickers on my MON lists" },
  { label: "US", args: ["US"], hint: "region" },
  { label: "Europe", args: ["EU"], hint: "region" },
  { label: "Denmark", args: ["DK"], hint: "region" },
  { label: "Asia-Pacific", args: ["APAC"], hint: "region" },
  { label: "Stocks", args: ["STOCKS"], hint: "asset class" },
  { label: "FX", args: ["FX"], hint: "asset class" },
  { label: "Rates", args: ["RATES"], hint: "asset class" },
  { label: "Commodities", args: ["COMMOD"], hint: "asset class" },
  { label: "Crypto", args: ["CRYPTO"], hint: "asset class" },
  { label: "Earnings", args: ["EARNINGS"], hint: "topic" },
  { label: "M&A", args: ["MA"], hint: "topic" },
  { label: "Central banks", args: ["CB"], hint: "topic" },
  { label: "Macro", args: ["MACRO"], hint: "topic" },
];
