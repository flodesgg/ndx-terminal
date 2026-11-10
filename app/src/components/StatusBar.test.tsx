import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Schemas } from "@/core/api";
import { StatusBar } from "./StatusBar";

const NYSE = {
  code: "NYSE",
  name: "New York",
  tz: "America/New_York",
  is_open: true,
  holiday: false,
  next_change: null,
} as Schemas["ExchangeStatus"];

function html(setup: (c: QueryClient) => void): string {
  const client = new QueryClient();
  setup(client);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <StatusBar />
    </QueryClientProvider>,
  );
}

describe("status bar: unknown is N.A., never a stale or assumed state (review 1b #8, #9)", () => {
  it("before the first /health answer the server is N.A., not DOWN", () => {
    const out = html(() => {});
    expect(out).toContain("SERVER N.A.");
    expect(out).not.toContain("SERVER DOWN");
  });

  it("when /markets starts failing, the last market states are not shown next to N.A.", () => {
    const out = html((c) => {
      c.setQueryData(["markets"], [NYSE]);
      c.getQueryCache()
        .find({ queryKey: ["markets"] })!
        .setState({ status: "error", error: new Error("down") });
    });
    expect(out).toContain("MARKETS N.A.");
    expect(out).not.toContain(">OPEN<");
  });
});
