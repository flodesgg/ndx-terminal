import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Coalescer, MAX_REPAINTS_PER_S } from "./coalesce";

describe("tick coalescing (perf smoke: 100 ticks/s stream)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("100 ticks/s across 20 symbols repaints each cell <= 4x/s and keeps the last tick", () => {
    const flushes = new Map<string, number[]>();
    const c = new Coalescer(
      (k) => flushes.set(k, [...(flushes.get(k) ?? []), Date.now()]),
      undefined,
      () => Date.now(),
    );
    const symbols = Array.from({ length: 20 }, (_, i) => `S${i}`);
    const seconds = 5;
    for (let tick = 0; tick < 100 * seconds; tick++) {
      c.push(symbols[tick % symbols.length]!);
      vi.advanceTimersByTime(10); // 100 ticks per second overall
    }
    vi.advanceTimersByTime(1000);
    for (const s of symbols) {
      const times = flushes.get(s) ?? [];
      expect(times.length).toBeGreaterThan(0);
      for (let i = 0; i + MAX_REPAINTS_PER_S < times.length; i++) {
        // any 5 consecutive repaints span at least one second -> <= 4 per second
        expect(times[i + MAX_REPAINTS_PER_S]! - times[i]!).toBeGreaterThanOrEqual(1000);
      }
    }
  });

  it("a hot symbol at 100 ticks/s is capped at 4 repaints/s", () => {
    let n = 0;
    const c = new Coalescer(() => n++);
    for (let i = 0; i < 100; i++) {
      c.push("BTCUSDT");
      vi.advanceTimersByTime(10);
    }
    vi.advanceTimersByTime(500);
    expect(n).toBeLessThanOrEqual(MAX_REPAINTS_PER_S + 1);
    expect(n).toBeGreaterThanOrEqual(MAX_REPAINTS_PER_S);
  });
});
