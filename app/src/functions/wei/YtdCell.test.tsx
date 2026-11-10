import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { NO_SOURCE_HINT } from "@/components/QuoteGrid";
import { YtdCell } from "./WEI";
import type { YtdBase } from "./rows";

const base = (over: Partial<YtdBase>): YtdBase => ({
  symbol: "^OMXC25",
  close: 2000,
  day: "2025-12-30",
  meta: { source: "EODHD", tag: "EOD" } as YtdBase["meta"],
  error: null,
  ...over,
});

describe("WEI % YTD cell", () => {
  it("shows the change since the previous year's close, with its base in the tooltip", () => {
    const html = renderToStaticMarkup(<YtdCell price={2200} base={base({})} />);
    expect(html).toContain("+10.00%");
    expect(html).toContain('class="up"');
    expect(html).toContain("base: close 2025-12-30 · EODHD EOD");
  });

  it("no source is a dim N.A. with the hint; a real failure is a red ERR", () => {
    const none = renderToStaticMarkup(
      <YtdCell price={2200} base={base({ close: null, error: "[no_provider] none" })} />,
    );
    expect(none).toContain('data-testid="ytd-na"');
    expect(none).toContain(NO_SOURCE_HINT);
    expect(none).not.toContain("ERR");
    const bad = renderToStaticMarkup(
      <YtdCell price={2200} base={base({ close: null, error: "[upstream] HTTP 500" })} />,
    );
    expect(bad).toContain('<span class="down" title="[upstream] HTTP 500">ERR</span>');
  });

  it("missing base or price is N.A., never 0", () => {
    for (const html of [
      renderToStaticMarkup(<YtdCell price={2200} base={base({ close: null })} />),
      renderToStaticMarkup(<YtdCell price={null} base={base({})} />),
      renderToStaticMarkup(<YtdCell price={2200} base={undefined} />),
    ]) {
      expect(html).toContain("N.A.");
      expect(html).not.toContain("0.00%");
    }
  });
});
