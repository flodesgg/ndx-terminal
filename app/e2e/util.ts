import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { APIRequestContext, Locator, Page } from "@playwright/test";

/**
 * E2E output (SPEC §11). By default it goes to app/e2e-out/<phase>/ (untracked), so `make check`
 * never rewrites tracked files; `make evidence` (NDX_EVIDENCE=1) writes the same files into
 * docs/screenshots/<phase>/ on purpose.
 */
export const PHASE = "3";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const SHOT_DIR =
  process.env.NDX_EVIDENCE === "1"
    ? join(ROOT, "docs", "screenshots", PHASE)
    : join(ROOT, "app", "e2e-out", PHASE);

export function shotPath(name: string): string {
  mkdirSync(SHOT_DIR, { recursive: true });
  return join(SHOT_DIR, `${name}.png`);
}

export function writeReport(name: string, data: unknown): void {
  mkdirSync(SHOT_DIR, { recursive: true });
  writeFileSync(join(SHOT_DIR, `${name}.json`), JSON.stringify(data, null, 2) + "\n");
}

/** The active window's command line (every window has its own, SPEC §4.9). */
export function cmd(page: Page): Locator {
  return page.locator(".panel.active").getByTestId("command-line").locator("input");
}

/** Type a command into the active window's command line and run it. */
export async function run(
  page: Page,
  text: string,
  opts: { newTab?: boolean } = {},
): Promise<void> {
  const input = cmd(page);
  await input.click();
  await input.fill(text);
  await input.press(opts.newTab ? "Shift+Enter" : "Enter");
}

/** Every test starts from the default session: forget the one stored in the E2E user.db. */
export async function resetSession(request: APIRequestContext): Promise<void> {
  const r = await request.delete(`http://127.0.0.1:${process.env.NDX_E2E_PORT}/session`, {
    headers: { "x-ndx-token": process.env.NDX_E2E_TOKEN! },
  });
  if (r.status() !== 204) throw new Error(`DELETE /session: ${r.status()}`);
}

/** Personal settings back to their defaults (PDF, KEYS, yfinance opt-in, news alerts and
 * feeds): the E2E user.db is shared. */
export async function resetSettings(request: APIRequestContext): Promise<void> {
  const base = `http://127.0.0.1:${process.env.NDX_E2E_PORT}`;
  const headers = { "x-ndx-token": process.env.NDX_E2E_TOKEN! };
  for (const [path, data] of [
    ["/settings/pdf", { defaultExchange: "DC", colors: "STANDARD" }],
    ["/settings/keys", { overrides: {} }],
    ["/settings/gp-template", { args: [] }],
    ["/providers/opt-in", { yfinance: false }],
    ["/news/alerts", { rules: [] }],
    ["/news/feeds", { feeds: [] }],
  ] as const) {
    const r = await request.put(`${base}${path}`, { headers, data });
    if (!r.ok()) throw new Error(`PUT ${path}: ${r.status()}`);
  }
}
