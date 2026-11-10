/**
 * Phase 2 step 1 — the data-layer core (SPEC §6.3): PROV, FLDS and the offline path with the
 * network cut inside the test (§13 step 9, §14 exit criterion). Browser mode, DEMO backend;
 * the DEMO-only PUT /demo/network makes the fixture provider unreachable the way a dead
 * network does (connection errors), so the backend goes OFFLINE and serves STALE copies.
 */
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { resetSession, resetSettings, run, shotPath } from "./util";

const active = (page: Page) => page.locator(".panel.active");
const API = () => `http://127.0.0.1:${process.env.NDX_E2E_PORT}`;
const HEADERS = () => ({ "x-ndx-token": process.env.NDX_E2E_TOKEN! });

async function network(request: APIRequestContext, up: boolean): Promise<void> {
  const r = await request.put(`${API()}/demo/network`, { headers: HEADERS(), data: { up } });
  if (!r.ok()) throw new Error(`PUT /demo/network: ${r.status()}`);
}

test.describe("data layer (SPEC §6.3)", () => {
  test.beforeEach(async ({ request, page }) => {
    await network(request, true);
    await resetSession(request);
    await resetSettings(request);
    await page.addInitScript(() => localStorage.setItem("ndx.tip.function-keys.v1", "shown"));
    await page.goto("/");
    await expect(page.getByTestId("demo-badge")).toBeVisible();
  });
  test.afterEach(async ({ request }) => {
    await network(request, true);
    await resetSettings(request);
  });

  test("PROV: state, tag, latency p50/p95, error rate, last success, quota, breaker", async ({
    page,
  }) => {
    await run(page, "AAPL US EQUITY Q"); // at least one real request for the counters
    await expect(active(page).locator(".lat").first()).toHaveText("DEMO");
    await run(page, "PROV");
    const table = active(page).getByTestId("prov");
    for (const h of ["P50 MS", "P95 MS", "ERR %", "LAST OK", "QUOTA USED", "LEFT", "BREAKER"]) {
      await expect(table.locator("thead")).toContainText(h);
    }
    const demo = table.locator('[data-provider="demo"]');
    await expect(demo).toContainText("OK");
    await expect(demo).toContainText("DEMO");
    await expect(demo).toContainText("per s");
    await expect(demo).toContainText("CLOSED");
    // the real providers are listed as off in DEMO: no invented numbers for them
    await expect(table.locator('[data-provider="finnhub"]')).toContainText("N.A.");
    await page.screenshot({ path: shotPath("prov") });
  });

  test("FLDS: normalized fields with definitions and the sources seen", async ({ page }) => {
    await run(page, "AAPL US EQUITY Q");
    await expect(active(page).locator(".lat").first()).toHaveText("DEMO");
    await run(page, "FLDS");
    const t = active(page).getByTestId("flds");
    await expect(t.locator('[data-field="px_last"]')).toContainText("DEMO fixtures");
    await expect(t.locator('[data-field="pe_ttm"]')).toContainText("P/E (TTM)");
    await expect(t.locator('[data-field="vwap"]')).toContainText("N.A.");
    await page.screenshot({ path: shotPath("flds") });
    await run(page, "FLDS FUNDAMENTALS");
    await expect(t.locator('[data-field="px_last"]')).toHaveCount(0);
    await expect(t.locator('[data-field="mkt_cap"]')).toBeVisible();
  });

  test("network cut: OFFLINE + STALE from cache, no crash; network back: recovery", async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000);
    await run(page, "AAPL US EQUITY Q");
    const tag = active(page).locator(".lat").first();
    await expect(tag).toHaveText("DEMO");
    await network(request, false);
    await expect(page.getByTestId("offline")).toHaveText("OFFLINE", { timeout: 40_000 });
    await expect(tag).toHaveText("STALE", { timeout: 30_000 });
    await expect(page.getByTestId("offline")).toHaveAttribute("title", /reconnecting/);
    await page.screenshot({ path: shotPath("offline") });
    // still usable while offline: other functions open (no crash, no blank window)
    await run(page, "PROV");
    await expect(active(page).getByTestId("prov")).toBeVisible();

    await network(request, true);
    await expect(page.getByTestId("offline")).toHaveCount(0, { timeout: 30_000 });
    await run(page, "AAPL US EQUITY Q");
    await expect(active(page).locator(".lat").first()).toHaveText("DEMO", { timeout: 30_000 });
    await page.screenshot({ path: shotPath("offline-recovered") });
  });
});
