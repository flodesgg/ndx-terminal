/**
 * §13 acceptance scenario "Morning in Copenhagen", steps 1, 2, 3 and 5 (§14 exit criteria for 1b
 * and Phase 3), in browser mode on a DEMO backend.
 */
import { expect, test, type Page } from "@playwright/test";
import { cmd, resetSession, resetSettings, run, shotPath } from "./util";

const win = (page: Page, n: number) => page.locator(".panel").nth(n - 1);

test.describe("§13 Morning in Copenhagen (DEMO)", () => {
  test.beforeEach(async ({ request, page }) => {
    await resetSession(request);
    await resetSettings(request);
    await page.addInitScript(() => localStorage.setItem("ndx.tip.function-keys.v1", "shown"));
  });

  test("step 1: launch restores the last layout in < 3 s; status bar shows clocks, markets, providers", async ({
    page,
  }) => {
    await page.goto("/");
    await run(page, "AAPL DES");
    await run(page, "LINK RED");
    await win(page, 2).getByTestId("command-line").locator("input").click();
    await run(page, "NOVOB DC EQUITY GP");
    await run(page, "OFF"); // saves at once
    await expect(page.locator(".panel.active .cmd-info")).toContainText("Session saved");
    // Relaunch the UI (the DEMO backend keeps running): time to the restored layout.
    const t0 = Date.now();
    await page.goto("/");
    await expect(win(page, 2).locator(".panel-ticker")).toHaveText("NOVOB DC EQUITY");
    const ms = Date.now() - t0;
    expect(ms).toBeLessThan(3000);
    await expect(win(page, 1).locator(".panel-fn")).toHaveText("DES");
    await expect(win(page, 1)).toHaveAttribute("data-link", "red");
    const bar = page.getByTestId("status-bar");
    await expect(bar.getByTestId("clock")).toHaveCount(4);
    await expect(bar.getByTestId("markets").locator("[data-state]").first()).toBeVisible();
    await expect(bar.getByTestId("providers").locator('[data-provider="DEMO"]')).toBeVisible();
    await page.screenshot({ path: shotPath("scenario-1-restore") });
  });

  test("step 2: TOP → overnight headlines, de-duplicated and ranked, NEW markers", async ({
    page,
  }) => {
    await page.goto("/");
    await run(page, "TOP");
    const top = page.locator(".panel.active");
    const rows = top.getByTestId("news-row");
    await expect(rows).toHaveCount(13); // 15 DEMO items, two near-duplicates collapsed
    const heads = await rows.locator(".news-head").allInnerTexts();
    expect(new Set(heads).size).toBe(heads.length);
    await expect(rows.first()).toContainText("Novo Nordisk raises full-year sales outlook");
    await expect(rows.first().getByTestId("news-similar-count")).toHaveText(/\+1 similar/);
    await expect(top.getByTestId("news-new").first()).toHaveText("NEW");
    await expect(top.getByTestId("news-sort")).toContainText("RANK");
    await expect(top.locator(".lat").first()).toContainText("DEMO");
    await expect(top.getByTestId("news-reader")).toContainText("Open original");
    await page.screenshot({ path: shotPath("scenario-2-top") });
  });

  test("step 3: ECO → today's US/EZ/DK releases in Copenhagen time, actual/prior, next-release countdown", async ({
    page,
  }) => {
    await page.goto("/");
    await run(page, "ECO TODAY");
    const eco = page.locator(".panel.active").getByTestId("eco");
    const rows = eco.getByTestId("eco-row");
    // DEMO now = Mon 9 Nov 15:30 Copenhagen: DK CPI, ECB stats, EZ retail, US CPI ×3, UMich.
    await expect(rows).toHaveCount(7);
    await expect(rows.nth(0)).toContainText("08:00");
    await expect(rows.nth(0)).toContainText("DK");
    await expect(rows.nth(0)).toContainText("CPI YoY");
    await expect(rows.nth(0)).toContainText("2.1%"); // actual, from the StatBank series
    await expect(rows.nth(0)).toContainText("2.4%"); // prior
    const usCpi = rows.filter({ has: page.locator("td.eco-event", { hasText: /^CPI MoM$/ }) });
    await expect(usCpi).toContainText("14:30*"); // FRED gives the date; 08:30 ET standard time
    await expect(usCpi).toContainText("0.2%");
    await expect(usCpi.locator("td").nth(5)).toHaveText("N.A."); // survey: no official source
    const next = rows.filter({ hasText: "UMich consumer sentiment" });
    await expect(next).toHaveClass(/eco-next/);
    await expect(next).toContainText("16:00*");
    await expect(eco.getByTestId("eco-next")).toContainText("UMich consumer sentiment");
    await expect(eco.getByTestId("eco-countdown")).toHaveText(/in (29|30)m \d\ds/);
    await expect(eco.getByTestId("eco-day")).toHaveCount(1);
    await expect(eco.locator(".lat").first()).toContainText("DEMO");
    await page.screenshot({ path: shotPath("scenario-3-eco") });
  });

  test("step 5: Russian layout → chart of NOVOB DC EQUITY; red-linked windows switch to Novo", async ({
    page,
  }) => {
    await page.goto("/");
    // Window 3 (GP) and window 4 (DES AAPL) are linked RED.
    await win(page, 4).getByTestId("command-line").locator("input").click();
    await run(page, "AAPL DES");
    await run(page, "LINK RED");
    await win(page, 3).getByTestId("command-line").locator("input").click();
    await run(page, "LINK RED");
    // Typed with the Russian – PC layout active: ТЩМЩИ ВС УЙГШЕН ПЗ = NOVOB DC EQUITY GP.
    const input = cmd(page);
    await input.fill("ТЩМЩИ ВС УЙГШЕН ПЗ");
    await input.press("Enter");
    await expect(win(page, 3).locator(".panel-ticker")).toHaveText("NOVOB DC EQUITY", {
      timeout: 15_000,
    });
    await expect(win(page, 3).locator(".panel-fn")).toHaveText("GP");
    await expect(win(page, 4).locator(".panel-ticker")).toHaveText("NOVOB DC EQUITY");
    await expect(win(page, 4).locator(".panel-fn")).toHaveText("DES");
    // An unlinked window stays as it was.
    await expect(win(page, 1).locator(".panel-fn")).toHaveText("W");
    await expect(win(page, 3).locator("canvas").first()).toBeVisible();
    await page.waitForTimeout(500);
    await page.screenshot({ path: shotPath("scenario-5-linked-novo") });
  });
});
