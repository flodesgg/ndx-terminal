/**
 * Simple PORT (manual + CSV import), ALRT (price alert) and JRNL (trade journal) — my
 * plan cut of 2026-11-10. Browser mode, DEMO backend.
 */
import { expect, test, type Page } from "@playwright/test";
import { resetSession, resetSettings, run, shotPath } from "./util";

const active = (page: Page) => page.locator(".panel.active");
const API = () => `http://127.0.0.1:${process.env.NDX_E2E_PORT}`;

test.describe("tools: PORT, ALRT, JRNL", () => {
  test.beforeEach(async ({ request, page }) => {
    await resetSession(request);
    await resetSettings(request);
    // start from an empty trade log and journal (the E2E user.db persists across tests)
    const headers = { "x-ndx-token": process.env.NDX_E2E_TOKEN! };
    for (const t of await (await request.get(`${API()}/portfolio/trades`, { headers })).json())
      await request.delete(`${API()}/portfolio/trades/${t.id}`, { headers });
    for (const a of await (await request.get(`${API()}/alerts`, { headers })).json())
      await request.delete(`${API()}/alerts/${a.id}`, { headers });
    const j = await (await request.get(`${API()}/journal`, { headers })).json();
    for (const e of j.entries) await request.delete(`${API()}/journal/${e.id}`, { headers });
    await page.addInitScript(() => localStorage.setItem("ndx.tip.function-keys.v1", "shown"));
    await page.goto("/");
    await expect(page.getByTestId("demo-badge")).toBeVisible();
  });

  test("PORT: CSV import is all or nothing; positions from the trades", async ({ page }) => {
    await run(page, "PORT");
    const port = active(page);
    const bad = "date,security,side,qty,price\n2026-10-02,AAPL US EQUITY,HOLD,10,200\n";
    await port.getByTestId("port-import").setInputFiles({
      name: "bad.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(bad),
    });
    await expect(port.getByTestId("port-import-msg")).toContainText("Nothing imported");
    const good =
      "date,security,side,qty,price,fees\n" +
      "2026-10-02,AAPL US EQUITY,BUY,10,200,5\n" +
      "2026-10-05,MSFT US EQUITY,BUY,3,480,0\n";
    await port.getByTestId("port-import").setInputFiles({
      name: "trades.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(good),
    });
    await expect(port.getByTestId("port-import-msg")).toContainText("Imported 2 trades");
    await expect(port.locator("tbody tr")).toHaveCount(2);
    await expect(port).toContainText("AAPL US EQUITY");
    await expect(port).toContainText("200.50"); // fees in the average cost
    await page.screenshot({ path: shotPath("port-import") });
  });

  test("ALRT: a price alert is armed, fires on the DEMO quote", async ({ page }) => {
    await run(page, "AAPL US EQUITY ALRT >200 DEMO TEST");
    await run(page, "ALRT");
    const al = active(page);
    await expect(al.locator("tbody tr")).toHaveCount(1);
    await expect(al.locator("tbody tr").first()).toContainText("AAPL");
    // the backend checks every 10 s; DEMO AAPL is 231.40 > 200
    await expect(al.locator("tbody tr").first()).toContainText("FIRED", { timeout: 25_000 });
    await page.screenshot({ path: shotPath("alrt-fired") });
  });

  test("JRNL: add, close, stats by tag, delete", async ({ page }) => {
    await run(page, "JRNL");
    const j = active(page).getByTestId("jrnl");
    await j.getByTestId("jrnl-symbol").fill("NOVOB DC EQUITY");
    await j.getByTestId("jrnl-qty").fill("20");
    await j.getByTestId("jrnl-entry").fill("400");
    await j.getByTestId("jrnl-exit").fill("380");
    await j.getByTestId("jrnl-setup").fill("breakout");
    await j.getByTestId("jrnl-mistakes").fill("chased");
    await j.getByTestId("jrnl-thesis").fill("Guidance raise, momentum");
    await j.getByTestId("jrnl-thesis").press("Enter");
    await expect(j.getByTestId("jrnl-row")).toHaveCount(1);
    await expect(j.getByTestId("jrnl-row").first()).toContainText("−400.00");
    await j.getByTestId("jrnl-symbol").fill("AAPL");
    await j.getByTestId("jrnl-side").selectOption("SHORT");
    await j.getByTestId("jrnl-qty").fill("10");
    await j.getByTestId("jrnl-entry").fill("230");
    await j.getByTestId("jrnl-setup").fill("fade");
    await j.getByTestId("jrnl-save").click();
    await expect(j.getByTestId("jrnl-row")).toHaveCount(2);
    await expect(j.getByTestId("jrnl-summary")).toContainText("CLOSED 1 · OPEN 1");
    await expect(j.getByTestId("jrnl-tags")).toContainText("breakout");
    await j.getByTestId("jrnl-qty").fill("-1");
    await j.getByTestId("jrnl-save").click();
    await expect(j.getByTestId("jrnl-msg")).toContainText("symbol is required");
    await page.screenshot({ path: shotPath("jrnl") });
    await j.getByTestId("jrnl-row").first().click();
    await page.keyboard.press("Delete");
    await expect(j.getByTestId("jrnl-row")).toHaveCount(1);
  });
});
