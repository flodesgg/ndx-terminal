import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const D = 86400;
const META = {
  fetched_at: new Date().toISOString(),
  tag: "DEMO",
  source: "demo",
  latency: "DELAYED",
  attempts: [],
};
// Responses by path and interval; each test fills what it needs.
let quote: Record<string, unknown> = {};
let intraday: unknown[] = [];
let daily: unknown[] = [];
let news: unknown[] = [];

vi.mock("@/core/data", () => ({
  useApi: (path: string | null, params?: { interval?: string }) => {
    if (path === null) return { isLoading: false, data: undefined };
    if (path.startsWith("/quote/")) return { isLoading: false, data: { data: quote, meta: META } };
    if (path === "/news") return { isLoading: false, data: { data: news, meta: META, errors: [] } };
    const data = params?.interval === "5m" ? intraday : daily;
    return { isLoading: false, data: { data, meta: { ...META, source: "bars" } } };
  },
}));
vi.mock("@/core/live", () => ({ useLiveQuote: () => ({ quote: null, meta: null, at: 0 }) }));
vi.mock("@/core/tape", async (orig) => ({
  ...(await orig<typeof import("@/core/tape")>()),
  useTape: () => ({ rows: [], meta: null }),
}));

import { getFunction, type PanelProps } from "@/core/registry";
import type { PanelSpec } from "@/core/layout/tree";
import type { Meta } from "@/core/api";
import { EMPTY_TAPE, mergeTape, type TapePrint } from "@/core/tape";
import { TimeAndSales, printsExpected, registerQ } from "./Q";

function render(ticker: string): string {
  if (!getFunction("Q")) registerQ();
  const Q = getFunction("Q")!.component!;
  const panel = { fn: "Q", ticker, args: [] } as PanelSpec;
  const props = { panel, id: "w1", active: true } as unknown as PanelProps;
  return renderToStaticMarkup(<Q {...props} />);
}

beforeEach(() => {
  quote = {};
  intraday = [];
  daily = [];
  news = [];
});

describe("Q book (SPEC §1.2: missing → dim N.A.; review 1b #12)", () => {
  it("a missing bid/ask (and so spread/mid) is dim N.A., not green/red", () => {
    quote = { symbol: "EURUSD CURNCY", price: 1.08, bid: null, ask: null };
    const html = render("EURUSD CURNCY");
    const book = html.slice(html.indexOf("BOOK"));
    const bid = /<dt>BID<\/dt><dd([^>]*)>(.*?)<\/dd>/.exec(book)!;
    const ask = /<dt>ASK<\/dt><dd([^>]*)>(.*?)<\/dd>/.exec(book)!;
    const spread = /<dt>SPREAD<\/dt><dd([^>]*)>(.*?)<\/dd>/.exec(book)!;
    const mid = /<dt>MID<\/dt><dd([^>]*)>(.*?)<\/dd>/.exec(book)!;
    for (const m of [bid, ask, spread, mid]) {
      expect(m[1]).not.toMatch(/up|down/);
      expect(m[2]).toContain('<span class="na">N.A.</span>');
    }
  });
});

describe("Q to spec (SPEC §8 Q)", () => {
  const session = 20_400 * D;
  beforeEach(() => {
    quote = {
      symbol: "AAPL",
      price: 231.4,
      change: 2.25,
      volume: 4_500_000,
      vwap: null,
      low: 229,
      high: 233,
    };
    intraday = [
      { t: session + 34_200, o: 230, h: 231, l: 229, c: 230, v: 1_000_000 },
      { t: session + 34_500, o: 230, h: 233, l: 231, c: 232, v: 3_000_000 },
    ];
    daily = Array.from({ length: 400 }, (_, i) => ({
      t: session - (400 - i) * D,
      o: 200,
      h: 200 + (i % 50),
      l: 180 - (i % 30),
      c: 200,
      v: 3_000_000,
    }));
    news = [1, 2, 3, 4, 5, 6].map((i) => ({
      id: `n${i}`,
      headline: `Headline ${i}`,
      source: "Pub",
      provider: "rss",
      published: new Date(Date.now() - i * 60_000).toISOString(),
      summary: null,
      tickers: ["AAPL"],
      url: "https://example.com",
    }));
  });

  it("VWAP is computed from the 5m bars when the source states none, and says so", () => {
    const html = render("AAPL US EQUITY");
    const vwap = /data-testid="q-vwap">(.*?)<\/dd>/s.exec(html)![1]!;
    expect(vwap).toContain("231.50"); // (230·1M + 232·3M) / 4M
    expect(vwap).toContain("calc 5m");
  });

  it("5m bars of another session give no VWAP, and say why", () => {
    quote = { ...quote, low: 240, high: 245 };
    const vwap = /data-testid="q-vwap">(.*?)<\/dd>/s.exec(render("AAPL US EQUITY"))![1]!;
    expect(vwap).toContain('<span class="na">N.A.</span>');
    expect(vwap).toContain("bars ≠ session");
  });

  it("volume against the 30-day average of full sessions, as a percentage", () => {
    const html = render("AAPL US EQUITY");
    const vol = /data-testid="q-volavg">(.*?)<\/dd>/s.exec(html)![1]!;
    expect(vol).toContain("150%");
  });

  it("52-week range from daily bars when the quote has none; five headlines", () => {
    const html = render("AAPL US EQUITY");
    expect(html).toContain("52W from daily bars");
    expect(html.match(/class="q-headline"/g)).toHaveLength(5);
    expect(html).toContain("Headline 1");
    expect(html).not.toContain("Headline 6");
    expect(html).toContain('data-testid="spark"');
  });

  it("an index without volume: VWAP and volume vs average are N.A., never 0", () => {
    quote = { symbol: "^GSPC", price: 6700, volume: null };
    intraday = [{ t: session + 34_200, o: 1, h: 1, l: 1, c: 1, v: null }];
    daily = [];
    const html = render("SPX INDEX");
    expect(/data-testid="q-vwap">(.*?)<\/dd>/s.exec(html)![1]).toBe('<span class="na">N.A.</span>');
    expect(/data-testid="q-volavg">(.*?)<\/dd>/s.exec(html)![1]).toBe(
      '<span class="na">N.A.</span>',
    );
    expect(html).toContain('data-testid="tas-na"');
  });
});

describe("Q time & sales", () => {
  const trd = { source: "Finnhub (stream)", latency: "REALTIME", venue: "TRD", tag: "RT·TRD" };
  const p = (seq: number, price: number): TapePrint => ({
    seq,
    t: new Date(1_794_249_640_000 + seq * 1000).toISOString(),
    price,
    size: 100,
  });

  it("is N.A. with the reason when the quote source carries no prints", () => {
    const html = renderToStaticMarkup(
      <TimeAndSales
        tape={EMPTY_TAPE}
        symbol="NOVOB DC EQUITY"
        quoteMeta={{ source: "EODHD", tag: "D15", latency: "DELAYED" } as Meta}
      />,
    );
    expect(html).toContain("no real-time trade feed for this instrument");
    expect(html).toContain("EODHD");
    expect(printsExpected(trd as Meta)).toBe(true);
    expect(printsExpected({ ...trd, venue: "REF" } as Meta)).toBe(false); // Tiingo: no prints
  });

  it("waits for the first print on a trade feed", () => {
    const html = renderToStaticMarkup(
      <TimeAndSales tape={EMPTY_TAPE} symbol="AAPL" quoteMeta={trd as Meta} />,
    );
    expect(html).toContain("waiting for the first print from Finnhub (stream)");
  });

  it("lists prints newest first, ticks coloured, gaps shown", () => {
    let tape = mergeTape(EMPTY_TAPE, [p(1, 100), p(2, 101)], trd as Meta);
    tape = mergeTape(tape, [p(6, 100.5)], trd as Meta);
    const html = renderToStaticMarkup(
      <TimeAndSales tape={tape} symbol="AAPL US EQUITY" quoteMeta={trd as Meta} />,
    );
    const seqs = [...html.matchAll(/data-seq="(\d+)"/g)].map((m) => m[1]);
    expect(seqs).toEqual(["6", "2", "1"]);
    expect(html).toContain("3 prints not received");
    expect(html).toMatch(/data-seq="2"><td[^>]*>[^<]*<\/td><td class="up">/);
    expect(html).toMatch(/data-seq="6"><td[^>]*>[^<]*<\/td><td class="down">/);
  });
});
