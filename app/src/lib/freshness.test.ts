import { describe, expect, it } from "vitest";
import type { Meta } from "@/core/api";
import { bookIsEstimated, freshnessClass, freshnessLabel, isStale, provenance } from "./freshness";

const NOW = Date.parse("2026-11-09T08:42:30Z");

function meta(p: Partial<Meta>): Meta {
  return {
    source: "Finnhub",
    latency: "REALTIME",
    delay_minutes: null,
    venue: null,
    provider_symbol: "AAPL",
    as_of: "2026-11-09T08:42:00Z",
    fetched_at: "2026-11-09T08:42:20Z",
    cached: false,
    stale: false,
    stale_after_s: 20,
    personal_use: false,
    demo: false,
    attempts: ["finnhub"],
    note: null,
    tag: "RT",
    ...p,
  };
}

describe("freshness tags (SPEC §6.1)", () => {
  it("passes the backend tag through", () => {
    for (const tag of ["RT", "RT·TRD", "RT·REF", "RT·IEX", "D15", "D20", "EOD"]) {
      expect(freshnessLabel(meta({ tag }), NOW)).toBe(tag);
    }
  });
  it("CACHE carries hh:mm in the user's time zone", () => {
    expect(freshnessLabel(meta({ tag: "CACHE" }), NOW, "Europe/Copenhagen")).toBe("CACHE 09:42");
    expect(freshnessLabel(meta({ tag: "CACHE" }), NOW, "UTC")).toBe("CACHE 08:42");
  });
  it("turns STALE after 2x the expected refresh", () => {
    expect(isStale(meta({}), NOW)).toBe(false);
    expect(freshnessLabel(meta({}), NOW + 15_000)).toBe("STALE");
    expect(freshnessLabel(meta({ tag: "STALE" }), NOW)).toBe("STALE");
  });
  it("DEMO always wins", () => {
    expect(freshnessLabel(meta({ tag: "DEMO" }), NOW + 1e9)).toBe("DEMO");
  });
  it("classes", () => {
    expect(freshnessClass("RT·TRD")).toBe("RT");
    expect(freshnessClass("D15")).toBe("D");
    expect(freshnessClass("CACHE 09:42")).toBe("CACHE");
  });
  it("hover card lists provider, provider symbol, as_of, fetched_at, personal use", () => {
    const text = provenance(meta({ personal_use: true }), "UTC");
    expect(text).toContain("Provider: Finnhub");
    expect(text).toContain("Provider symbol: AAPL");
    expect(text).toContain("As of: 2026-11-09 08:42:00");
    expect(text).toContain("Fetched: 2026-11-09 08:42:20");
    expect(text).toContain("PERSONAL USE");
    expect(provenance(meta({ provider_symbol: null, as_of: null }))).toContain("As of: N.A.");
  });
});

describe("bookIsEstimated (SPEC §6.1 RT·REF)", () => {
  it("only a derived reference price has estimated bid/ask", () => {
    expect(bookIsEstimated({ venue: "REF" })).toBe(true);
    expect(bookIsEstimated({ venue: "TRD" })).toBe(false);
    expect(bookIsEstimated({ venue: null })).toBe(false);
    expect(bookIsEstimated(null)).toBe(false);
  });
});
