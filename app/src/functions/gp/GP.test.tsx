import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const asked: Record<string, unknown>[] = [];
vi.mock("@/core/data", () => ({
  useApi: (_path: string | null, params?: Record<string, unknown>) => {
    asked.push(params ?? {});
    return { isLoading: true, isFetching: true, data: undefined, error: null };
  },
  useApiMany: () => [],
}));
vi.mock("@/core/live", () => ({
  useLiveQuote: () => ({ quote: null, meta: null, at: 0 }),
  useLiveBars: () => undefined,
}));

import type { PanelSpec } from "@/core/layout/tree";
import type { PanelProps } from "@/core/registry";
import { GP } from "./GP";

function render(active: boolean): Record<string, unknown> {
  asked.length = 0;
  const panel = { fn: "GP", ticker: "AAPL US EQUITY", args: [] } as unknown as PanelSpec;
  const props = { panel, id: "w1", active, update: () => undefined } as unknown as PanelProps;
  renderToStaticMarkup(<GP {...props} />);
  return asked[0]!;
}

describe("GP at startup spends a tight bar budget (Massive) only on the focused window", () => {
  it("a window not in focus asks with defer", () => {
    expect(render(false)).toMatchObject({ interval: "1d", defer: true });
  });

  it("the focused window asks normally", () => {
    const params = render(true);
    expect(params.defer).toBeUndefined();
  });
});
