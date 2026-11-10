import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const venues = [
  {
    code: "DC",
    name: "Nasdaq Copenhagen",
    mic: "XCSE",
    tz: "Europe/Copenhagen",
    country: "DK",
    state: "CLOSED",
    next_change: "2026-11-10T08:00:00Z",
    today: {
      day: "2026-11-09",
      open: "2026-11-09T08:00:00Z",
      close: "2026-11-09T16:00:00Z",
      break_start: null,
      break_end: null,
      early_close: false,
    },
    next_session: null,
    special: [{ day: "2026-12-24", kind: "holiday", name: "Christmas Eve", close: null }],
    known_until: "2027-02-05",
    utc_offset_s: 3600,
    dst_change: "2027-03-28T01:00:00Z",
    dst_offset_s: 7200,
  },
  {
    code: "XSHG",
    name: "Shanghai Stock Exchange",
    mic: "XSHG",
    tz: "Asia/Shanghai",
    country: "CN",
    state: null,
    next_change: null,
    today: null,
    next_session: null,
    special: [],
    known_until: null,
    utc_offset_s: 8 * 3600,
    dst_change: null,
    dst_offset_s: null,
  },
];

vi.mock("@/core/data", () => ({
  useApi: () => ({
    isLoading: false,
    isFetching: false,
    data: {
      venues,
      meta: {
        source: "exchange_calendars 4.13.2",
        latency: "STATIC",
        tag: "STATIC",
        fetched_at: new Date().toISOString(),
        attempts: [],
      },
    },
  }),
}));

import type { PanelSpec } from "@/core/layout/tree";
import { getFunction, type PanelProps } from "@/core/registry";
import { registerCDR } from "./CDR";

describe("CDR", () => {
  it("lists venues with state, local hours and holidays; an unknown calendar is N.A.", () => {
    registerCDR();
    const CDR = getFunction("CDR")!.component!;
    const panel = { fn: "CDR", args: [] } as unknown as PanelSpec;
    const html = renderToStaticMarkup(
      <CDR {...({ panel, id: "w1", active: true } as unknown as PanelProps)} />,
    );
    expect(html).toContain("exchange_calendars 4.13.2");
    expect(html).toContain("09:00–17:00");
    expect(html).toContain("2026-12-24 Christmas Eve");
    expect(html).toContain("2027-03-28 → UTC+2");
    const shanghai = html.slice(html.indexOf('data-venue="XSHG"'));
    expect(shanghai).toMatch(/data-testid="venue-state"><span class="na">N.A.<\/span>/);
    expect(html).not.toMatch(/XSHG[^]*CLOSED/);
  });
});
