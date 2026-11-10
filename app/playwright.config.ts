/**
 * E2E + perf smoke in browser mode against a DEMO backend (SPEC §3, §11).
 * A fresh random port and launch token per run, passed by environment only (SPEC §1.5).
 */
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";

// Workers re-evaluate this file; keep the main process's values via the environment.
process.env.NDX_E2E_TOKEN ??= randomBytes(32).toString("hex");
process.env.NDX_E2E_TMP ??= mkdtempSync(join(tmpdir(), "ndx-e2e-"));
process.env.NDX_E2E_PORT ??= String(await freePort());

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

const PORT = process.env.NDX_E2E_PORT;
const TOKEN = process.env.NDX_E2E_TOKEN;
const TMP = process.env.NDX_E2E_TMP;
const UI = "http://localhost:1420";

export default defineConfig({
  testDir: "e2e",
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    ...devices["Desktop Chrome"],
    baseURL: UI,
    viewport: { width: 1600, height: 960 },
    colorScheme: "dark",
  },
  projects: [{ name: "chromium" }],
  webServer: [
    {
      command: "uv run python -m ndx_server.main",
      cwd: "../server",
      // 401 without a token counts as "up" for Playwright's readiness probe.
      url: `http://127.0.0.1:${PORT}/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      // Server logs go to NDX_LOG_DIR (JSON, redacted); keep the test output readable.
      stderr: "ignore",
      env: {
        NDX_PORT: PORT,
        NDX_TOKEN: TOKEN,
        NDX_DEMO: "1",
        NDX_DEV: "1",
        NDX_KEYRING: "0",
        NDX_DATA_DIR: join(TMP, "data"),
        NDX_LOG_DIR: join(TMP, "logs"),
      },
    },
    {
      command: "pnpm exec vite --port 1420 --strictPort",
      url: UI,
      reuseExistingServer: false,
      timeout: 60_000,
      env: { NDX_DEV_PORT: PORT, NDX_DEV_TOKEN: TOKEN },
    },
  ],
});
