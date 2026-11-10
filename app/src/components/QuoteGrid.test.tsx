import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { QuoteState } from "@/core/live";
import { NO_SOURCE_HINT, QuoteGrid } from "./QuoteGrid";

describe("QuoteGrid (review 1a #9/#13/#14)", () => {
  it("missing values render as dim N.A. while loading", () => {
    const html = renderToStaticMarkup(
      <QuoteGrid
        rows={[{ symbol: "SPX INDEX", label: "S&P 500" }]}
        quotes={new Map()}
        sel={0}
        onSelect={() => {}}
        onOpen={() => {}}
      />,
    );
    const cells = html.match(/<td[^>]*>(.*?)<\/td>/g) ?? [];
    const na = cells.filter((c) => c.includes("N.A."));
    expect(na.length).toBeGreaterThanOrEqual(5);
    for (const c of na) expect(c).toMatch(/class="na"|class="dim"/);
  });

  it("TIME is exchange-local, not the user zone", () => {
    const quotes = new Map<string, QuoteState>([
      [
        "SPX INDEX",
        {
          quote: { symbol: "SPX INDEX", price: 6000, ts: new Date().toISOString() },
        } as unknown as QuoteState,
      ],
    ]);
    const now = new Date();
    const ny = new Intl.DateTimeFormat("en-GB", {
      timeZone: "America/New_York",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).format(now);
    const html = renderToStaticMarkup(
      <QuoteGrid
        rows={[{ symbol: "SPX INDEX", label: "S&P 500" }]}
        quotes={quotes}
        sel={0}
        onSelect={() => {}}
        onOpen={() => {}}
      />,
    );
    expect(html).toContain(ny.slice(0, 5));
  });
});

describe("QuoteGrid: a row without a source is not an error", () => {
  const grid = (quotes: Map<string, QuoteState>) =>
    renderToStaticMarkup(
      <QuoteGrid
        rows={[
          { symbol: "^GSPC", label: "S&P 500" },
          { symbol: "^GDAXI", label: "DAX" },
        ]}
        quotes={quotes}
        sel={0}
        onSelect={() => {}}
        onOpen={() => {}}
      />,
    );
  const state = (error: string) => ({ quote: null, meta: null, error, at: 1 }) as QuoteState;

  it("no enabled source: dim N.A. with the yfinance hint, no red ERR", () => {
    const html = grid(new Map([["^GSPC", state("[no_provider] no enabled provider for index")]]));
    expect(html).toContain('data-testid="no-source"');
    expect(html).toContain(`title="${NO_SOURCE_HINT}"`);
    expect(html).toContain("no source; enable yfinance in PDF");
    expect(html).not.toContain(">ERR<");
    const last = /data-testid="no-source"><span class="na">N.A.<\/span>/;
    expect(html).toMatch(last);
  });

  it("a real failure stays a red ERR", () => {
    const html = grid(new Map([["^GDAXI", state("[upstream] eodhd: HTTP 500")]]));
    expect(html).toContain('<span class="down">ERR</span>');
    expect(html).not.toContain("no-source");
  });
});

describe("QuoteGrid: WEI columns from the row info (SPEC §8 WEI)", () => {
  const grid = (state: "OPEN" | "CLOSED" | "HOLIDAY" | "BREAK" | null) =>
    renderToStaticMarkup(
      <QuoteGrid
        rows={[{ symbol: "^N225", label: "Nikkei 225", group: "APAC" }]}
        quotes={new Map()}
        sel={-1}
        onSelect={() => {}}
        onOpen={() => {}}
        info={() => ({ state, currency: "JPY", ytd: <b>YTD</b>, spark: <i>SPARK</i> })}
      />,
    );

  it("has the spec's columns and fills them from the info", () => {
    const html = grid("OPEN");
    for (const h of ["YTD%", "CCY", "INTRADAY", "TIME", "STATE"]) expect(html).toContain(h);
    expect(html).not.toContain(">LOW<");
    expect(html).toContain("JPY");
    expect(html).toContain("<b>YTD</b>");
    expect(html).toContain("<i>SPARK</i>");
    expect(html).toContain('<td class="l up">OPEN</td>');
  });

  it("closed and holiday markets are dimmed, a lunch break is not", () => {
    expect(grid("CLOSED")).toMatch(/<tr[^>]*data-state="CLOSED" class="closed"/);
    expect(grid("HOLIDAY")).toContain('class="closed"');
    expect(grid("BREAK")).not.toContain('class="closed"');
    expect(grid("OPEN")).not.toContain('class="closed"');
  });

  it("an unknown session state is N.A., not CLOSED", () => {
    const html = grid(null);
    expect(html).not.toContain(">CLOSED<");
    expect(html).not.toContain('class="closed"');
    expect(html).toMatch(/class="l dim"><span class="na">N.A.<\/span>/);
  });
});
