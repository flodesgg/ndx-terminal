/**
 * The §13 scenario steps with REAL data (SPEC §14 phase 2 exit: "scenario steps 4–5 with real
 * data"). Not part of `make check`: it spends provider budgets. `make real-scenario`.
 * The backend runs without DEMO and reads my keys from the repo .env (Keychain off),
 * like `make live-check`; nothing here reads or prints a key. Its data folder persists between
 * runs so bar stores and the EODHD daily counter carry over; its user.db is reset per run.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";

const main = !process.env.NDX_E2E_TOKEN; // workers load this file again with the env set
process.env.NDX_E2E_TOKEN ??= randomBytes(32).toString("hex");
process.env.NDX_E2E_TMP ??= join(tmpdir(), "ndx-real-scenario");
process.env.NDX_E2E_PORT ??= String(await freePort());
mkdirSync(process.env.NDX_E2E_TMP, { recursive: true });
// Every run starts from the default session (W, WEI, GP, N): a restored layout could open
// lists whose quotes spend the EODHD daily calls. Bars and counters are kept.
for (const f of main ? ["user.db", "user.db-wal", "user.db-shm"] : []) {
  rmSync(join(process.env.NDX_E2E_TMP, "data", f), { force: true });
}

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
  testDir: "e2e-real",
  timeout: 120_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
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
      url: `http://127.0.0.1:${PORT}/health`,
      reuseExistingServer: false,
      timeout: 90_000,
      stderr: "ignore",
      env: {
        NDX_PORT: PORT,
        NDX_TOKEN: TOKEN,
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
