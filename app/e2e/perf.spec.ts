/** Perf smoke (SPEC §2, §11): cold start, 5,000-row grid scroll, 100 ticks/s stream -> perf.json. */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { shotPath, writeReport } from "./util";

const results: Record<string, unknown> = {};

/** Tick counter the dev-only stream harness (src/perf/PerfStream.tsx) keeps on `window`. */
declare global {
  interface Window {
    __perfTicks?: number;
  }
}

test.afterAll(() => writeReport("perf", { measured_at: new Date().toISOString(), ...results }));

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

/**
 * A fresh backend process (new port, token and empty data folder) from spawn to an
 * authenticated /health 200: interpreter start, imports, create_app (symbology, user.db) and
 * the bind. It runs in DEMO with NDX_KEYRING=0 (the E2E rule), so it leaves out what a real
 * launch adds before /health: the Keychain reads, building the network providers, the
 * SeedStore and the Binance stream service (seed downloads themselves run in the background
 * and never block /health). OS file and .pyc caches are warm, as on a real relaunch.
 */
async function backendColdStartMs(): Promise<number> {
  const port = await freePort();
  const token = randomBytes(32).toString("hex");
  const tmp = mkdtempSync(join(tmpdir(), "ndx-cold-"));
  const t0 = Date.now();
  const proc = spawn("uv", ["run", "python", "-m", "ndx_server.main"], {
    cwd: join(process.cwd(), "..", "server"),
    stdio: "ignore",
    env: {
      ...process.env,
      NDX_PORT: String(port),
      NDX_TOKEN: token,
      NDX_DEMO: "1",
      NDX_KEYRING: "0",
      NDX_DATA_DIR: join(tmp, "data"),
      NDX_LOG_DIR: join(tmp, "logs"),
    },
  });
  try {
    for (;;) {
      if (Date.now() - t0 > 20_000) throw new Error("backend did not start within 20 s");
      try {
        const r = await fetch(`http://127.0.0.1:${port}/health`, {
          headers: { "x-ndx-token": token },
        });
        if (r.ok) return Date.now() - t0;
      } catch {
        // not listening yet
      }
      await new Promise((r) => setTimeout(r, 20));
    }
  } finally {
    proc.kill();
  }
}

test("cold start → usable UI < 3 s", async ({ page }) => {
  // §2 budget, measured as two parts that run one after the other at app launch: a fresh
  // backend process to /health, then a fresh browser context to a usable UI. Not covered: the
  // Tauri window creation; the UI half loads in an already running Chromium against the warm
  // E2E backend, and Vite serves modules already transformed by earlier specs (a release build
  // serves a prebuilt bundle instead). The backend half's exclusions are listed above.
  const backend = await backendColdStartMs();
  const t0 = Date.now();
  await page.goto("/");
  await expect(page.getByTestId("command-line").first().locator("input")).toBeVisible();
  await expect(page.getByTestId("status-bar")).toBeVisible();
  const ui = Date.now() - t0;
  results.cold_start = { backend_start_ms: backend, ui_ready_ms: ui, total_ms: backend + ui };
  expect(backend + ui).toBeLessThan(3000);
});

test("5,000-row grid scrolls at ~60 fps", async ({ page }) => {
  await page.goto("/?perf=grid");
  const body = page.getByTestId("perf-grid-body");
  await expect(body).toBeVisible();
  await expect(page.getByText("DEMO0000")).toBeVisible();
  const stats = await body.evaluate(async (el) => {
    const frames: number[] = [];
    const total = el.scrollHeight - el.clientHeight;
    const duration = 2000;
    await new Promise<void>((resolve) => {
      let start = 0;
      let prev = 0;
      const step = (t: number) => {
        if (!start) start = prev = t;
        else frames.push(t - prev);
        prev = t;
        const k = Math.min(1, (t - start) / duration);
        el.scrollTop = total * k;
        if (k < 1) requestAnimationFrame(step);
        else resolve();
      };
      requestAnimationFrame(step);
    });
    frames.sort((a, b) => a - b);
    const avg = frames.reduce((a, b) => a + b, 0) / frames.length;
    return {
      frames: frames.length,
      avg_fps: 1000 / avg,
      p95_frame_ms: frames[Math.floor(frames.length * 0.95)]!,
      rendered_rows: el.querySelectorAll(".vgrid-row").length,
    };
  });
  results.grid_5k = stats;
  await page.screenshot({ path: shotPath("perf-grid-5k") });
  expect(stats.rendered_rows).toBeLessThan(200); // virtualized: only visible rows exist
  expect(stats.avg_fps).toBeGreaterThan(50);
  expect(stats.p95_frame_ms).toBeLessThan(34);
});

test("100 ticks/s stream keeps the UI at ~60 fps", async ({ page }) => {
  await page.goto("/?perf=stream");
  const body = page.getByTestId("perf-stream-body");
  await expect(body).toBeVisible();
  await expect(page.getByText("PERF000")).toBeVisible();
  const stats = await page.evaluate(async () => {
    const frames: number[] = [];
    const ticks0 = window.__perfTicks ?? 0;
    const duration = 3000;
    await new Promise<void>((resolve) => {
      let start = 0;
      let prev = 0;
      const step = (t: number) => {
        if (!start) start = prev = t;
        else frames.push(t - prev);
        prev = t;
        if (t - start < duration) requestAnimationFrame(step);
        else resolve();
      };
      requestAnimationFrame(step);
    });
    frames.sort((a, b) => a - b);
    const avg = frames.reduce((a, b) => a + b, 0) / frames.length;
    return {
      ticks_per_s: ((window.__perfTicks ?? 0) - ticks0) / (duration / 1000),
      frames: frames.length,
      avg_fps: 1000 / avg,
      p95_frame_ms: frames[Math.floor(frames.length * 0.95)]!,
    };
  });
  results.stream_100_ticks = stats;
  await page.screenshot({ path: shotPath("perf-stream-100tps") });
  expect(stats.ticks_per_s).toBeGreaterThan(90);
  expect(stats.avg_fps).toBeGreaterThan(50);
  expect(stats.p95_frame_ms).toBeLessThan(34);
});
