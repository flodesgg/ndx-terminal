import { describe, expect, it } from "vitest";
import { pdfArgs } from "@/core/pdf";
import {
  applyFilter,
  argsFromFilter,
  chipLabel,
  cycle,
  filterFromArgs,
  isNew,
  N_MENU,
  NO_FILTER,
  serverNow,
  type NewsItem,
} from "./model";

function item(over: Partial<NewsItem>): NewsItem {
  return {
    id: "x",
    headline: "Headline",
    url: "https://example.com/x",
    source: "Pub",
    provider: "DEMO",
    published: "2026-11-09T14:28:00Z",
    tickers: [],
    regions: [],
    asset_classes: [],
    topics: [],
    similar: [],
    watch: false,
    ...over,
  } as NewsItem;
}

describe("news filters", () => {
  it("args ↔ filter, any order, unknown tokens ignored", () => {
    const f = filterFromArgs(["earnings", "DK", "MY", "STOCKS"]);
    expect(f).toEqual({ region: "DK", asset: "EQUITY", topic: "EARNINGS", mine: true });
    expect(argsFromFilter(f)).toEqual(["DK", "STOCKS", "EARNINGS", "MY"]);
    expect(filterFromArgs(["MA", "COMMOD"])).toEqual({
      ...NO_FILTER,
      asset: "COMMODITIES",
      topic: "M&A",
    });
    expect(filterFromArgs([])).toEqual(NO_FILTER);
  });

  it("applies every filter and the text filter", () => {
    const items = [
      item({ id: "a", regions: ["DK", "EU"], asset_classes: ["EQUITY"], watch: true }),
      item({ id: "b", regions: ["US"], topics: ["CENTRAL BANKS"], headline: "Fed holds" }),
      item({ id: "c", asset_classes: ["CRYPTO"], tickers: ["BTCUSD CURNCY"] }),
    ];
    const ids = (f: Partial<typeof NO_FILTER>, text = "") =>
      applyFilter(items, { ...NO_FILTER, ...f }, text).map((n) => n.id);
    expect(ids({})).toEqual(["a", "b", "c"]);
    expect(ids({ region: "EU" })).toEqual(["a"]);
    expect(ids({ topic: "CENTRAL BANKS" })).toEqual(["b"]);
    expect(ids({ asset: "CRYPTO" })).toEqual(["c"]);
    expect(ids({ mine: true })).toEqual(["a"]);
    expect(ids({}, "fed")).toEqual(["b"]);
    expect(ids({}, "btcusd")).toEqual(["c"]);
  });

  it("cycles all → each value → all", () => {
    const v = ["US", "EU"] as const;
    expect(cycle(v, null)).toBe("US");
    expect(cycle(v, "US")).toBe("EU");
    expect(cycle(v, "EU")).toBeNull();
  });
});

describe("NEW and the server clock", () => {
  const now = Date.parse("2026-11-09T14:30:00Z");
  it("NEW is under 5 minutes", () => {
    expect(isNew("2026-11-09T14:26:00Z", now)).toBe(true);
    expect(isNew("2026-11-09T14:25:00Z", now)).toBe(false);
    expect(isNew("bad", now)).toBe(false);
  });
  it("server now advances with the client clock since the fetch", () => {
    expect(serverNow("2026-11-09T14:30:00Z", 1000, 61_000)).toBe(now + 60_000);
    expect(serverNow(null, 1000, 5000)).toBe(5000);
  });
});

describe("N menu and chips", () => {
  it("every menu row's args parse back to a filter", () => {
    for (const m of N_MENU) expect(argsFromFilter(filterFromArgs(m.args))).toEqual(m.args);
  });
  it("chip shows the ticker", () => {
    expect(chipLabel("NOVOB DC EQUITY")).toBe("NOVOB");
  });
});

describe("PDF NEWS", () => {
  it("opens the feeds page; URLs are not command tokens", () => {
    expect(pdfArgs(["NEWS"])).toEqual({ section: "NEWS" });
    expect(pdfArgs(["NEWS", "X"])).toHaveProperty("error");
  });
});
