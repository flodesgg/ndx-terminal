import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ApiError, type Meta } from "@/core/api";
import { DataStatus } from "./DataStatus";

const meta = (fetchedAgoS: number): Meta =>
  ({
    source: "finnhub",
    latency: "realtime",
    tag: "RT",
    fetched_at: new Date(Date.now() - fetchedAgoS * 1000).toISOString(),
    stale_after_s: 1800,
    attempts: ["finnhub"],
    cached: false,
    personal_use: false,
    demo: false,
  }) as unknown as Meta;

describe("DataStatus STALE is by age, not by a failed refetch (review 1a #20)", () => {
  it("a failed refetch of fresh data keeps its tag", () => {
    const html = renderToStaticMarkup(
      <DataStatus meta={meta(300)} error={new Error("boom")} updatedAt={Date.now() - 300_000} />,
    );
    expect(html).toContain("FETCH FAILED");
    expect(html).toContain("showing data from");
    expect(html).not.toContain("STALE");
  });

  it("data older than 2× its refresh is STALE", () => {
    const html = renderToStaticMarkup(
      <DataStatus meta={meta(4000)} error={new Error("boom")} updatedAt={Date.now() - 4_000_000} />,
    );
    expect(html).toContain("STALE");
  });
});

describe("a request waiting in a provider's queue is not an error", () => {
  const queued = new ApiError(
    429,
    {
      error: "Massive rate limit: queued, turn in 15 s",
      code: "rate_limited",
      attempts: ["massive"],
      retry_after_s: 15,
      provider: "Massive",
    },
    "Massive rate limit: queued, turn in 15 s",
  );

  it("shows who it waits for and when it repeats", () => {
    const html = renderToStaticMarkup(<DataStatus fetching waiting={queued} />);
    expect(html).toContain('data-testid="rate-wait"');
    expect(html).toMatch(/waiting for Massive rate limit, retry in 1[4-6] s/);
    expect(html).not.toContain("FETCH FAILED");
  });

  it("no caption once the fetch is over", () => {
    expect(renderToStaticMarkup(<DataStatus waiting={queued} />)).not.toContain("rate-wait");
  });

  it("a deferred answer (window not in focus) is neutral, not red", () => {
    const deferred = new ApiError(
      425,
      {
        error: "Massive: tight budget, loads when the window is focused",
        code: "deferred",
        attempts: [],
        retry_after_s: null,
        provider: "Massive",
      },
      "Massive: tight budget, loads when the window is focused",
    );
    const html = renderToStaticMarkup(<DataStatus error={deferred} />);
    expect(html).toContain('data-testid="deferred"');
    expect(html).toContain("loads when the window is focused");
    expect(html).not.toContain("FETCH FAILED");
  });
});
