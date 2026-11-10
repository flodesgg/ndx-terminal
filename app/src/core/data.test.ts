import { describe, expect, it } from "vitest";
import { ApiError, queuedTurn } from "./api";
import { QUEUE_RETRIES, retryDelayMs, shouldRetry } from "./data";

const queued = (s: number) =>
  new ApiError(
    429,
    {
      error: "Massive rate limit: queued, turn in 15 s",
      code: "rate_limited",
      attempts: ["massive"],
      retry_after_s: s,
      provider: "Massive",
    },
    "Massive rate limit: queued",
  );

describe("a request queued for a provider's budget repeats itself on its turn", () => {
  it("is retried after the turn the backend holds, many times", () => {
    const e = queued(15);
    expect(queuedTurn(e)).toEqual({ provider: "Massive", at: e.at + 15_000 });
    expect(shouldRetry(0, e)).toBe(true);
    expect(shouldRetry(QUEUE_RETRIES - 1, e)).toBe(true);
    expect(shouldRetry(QUEUE_RETRIES, e)).toBe(false);
    const ms = retryDelayMs(0, e);
    expect(ms).toBeGreaterThan(14_000);
    expect(ms).toBeLessThanOrEqual(15_300);
  });

  it("a rate limit without a queue place and other errors keep the old policy", () => {
    const plain = new ApiError(
      429,
      { error: "x", code: "rate_limited", attempts: [], retry_after_s: null, provider: null },
      "x",
    );
    expect(queuedTurn(plain)).toBeNull();
    expect(shouldRetry(0, plain)).toBe(true);
    expect(shouldRetry(1, plain)).toBe(false);
    expect(retryDelayMs(0, plain)).toBe(1000);
    const deferred = new ApiError(
      425,
      { error: "d", code: "deferred", attempts: [], retry_after_s: null, provider: "Massive" },
      "d",
    );
    expect(shouldRetry(0, deferred)).toBe(false);
  });
});
