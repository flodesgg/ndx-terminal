/**
 * System functions (SPEC §7, §14 1b step 3): HELP (+ Data sources, help search), SRCH, MENU,
 * PDF, KEYS, LOG and the toolbar's Menu / recent ▾ — browser mode on a DEMO backend.
 */
import { expect, test, type Page } from "@playwright/test";
import { cmd, resetSession, resetSettings, run, shotPath } from "./util";

const active = (page: Page) => page.locator(".panel.active");
const fn = (page: Page) => active(page).locator(".panel-head .panel-fn");
const ticker = (page: Page) => active(page).locator(".panel-head .panel-ticker");

test.describe("system functions (SPEC §7)", () => {
  test.beforeEach(async ({ request, page }) => {
    await resetSession(request);
    await resetSettings(request);
    await page.addInitScript(() => localStorage.setItem("ndx.tip.function-keys.v1", "shown"));
    await page.goto("/");
    await expect(page.getByTestId("demo-badge")).toBeVisible();
  });
  test.afterEach(async ({ request }) => resetSettings(request));

  test("HELP: numbered topics, Data sources notices, F1 twice = help search", async ({ page }) => {
    await run(page, "HELP");
    await expect(fn(page)).toHaveText("HELP");
    await expect(active(page).getByTestId("help-topics")).toContainText("1) Data sources");
    await run(page, "1");
    const sources = active(page).getByTestId("help-sources");
    await expect(sources).toContainText(
      "This product uses the FRED® API but is not endorsed or certified by the Federal Reserve Bank of St. Louis.",
    );
    await expect(sources.locator('[data-notice="Tiingo"]')).toContainText("RT·REF");
    await expect(sources.locator('[data-notice="Wikipedia"]')).toContainText("CC BY-SA 4.0");
    await expect(sources.locator('[data-notice="yfinance"]')).toContainText(
      "Unofficial source, enabled by you, personal use",
    );
    await expect(sources.locator('[data-notice="yfinance"]')).toContainText("OFF (default)");
    await page.screenshot({ path: shotPath("help-sources") });
    // F1 opens HELP; F1 again while HELP is on screen opens help search with the field focused.
    await run(page, "WEI");
    await cmd(page).press("F1");
    await expect(fn(page)).toHaveText("HELP");
    await page.keyboard.press("F1");
    const field = active(page).getByTestId("help-search-field");
    await expect(field).toBeFocused();
    await field.pressSequentially("endorsed");
    await expect(active(page).getByTestId("help-search")).toContainText("Data sources");
    await page.screenshot({ path: shotPath("help-search") });
    await field.press("Enter");
    await expect(active(page).getByTestId("help-sources")).toBeVisible();
  });

  test("SRCH: the autocomplete row “Search for '…'” and plain text open the search", async ({
    page,
  }) => {
    const input = cmd(page);
    await input.click();
    await input.pressSequentially("novo nordisk");
    const rows = page.getByTestId("suggest").locator(".suggest-row");
    await expect(rows.last()).toContainText("Search for 'novo nordisk'");
    await input.press("ArrowUp"); // the last row
    await input.press("Enter");
    await expect(fn(page)).toHaveText("SRCH");
    const srch = active(page).getByTestId("srch");
    await expect(srch.getByTestId("srch-securities")).toContainText("NOVOB DC EQUITY");
    await expect(srch.getByTestId("srch-news")).toBeVisible({ timeout: 15_000 });
    // DEMO news fixtures (Phase 3): the Novo headline is found.
    await expect(srch.getByTestId("srch-news")).toContainText("Novo Nordisk raises");
    await page.screenshot({ path: shotPath("srch") });
    await srch.getByTestId("srch-securities").getByText("NOVOB DC EQUITY").click();
    await expect(fn(page)).toHaveText("MENU");
    await expect(ticker(page)).toHaveText("NOVOB DC EQUITY");
    // Text that is no command searches (no more "SRCH not built yet").
    await run(page, "what moved spx today?");
    await expect(fn(page)).toHaveText("SRCH");
    await expect(active(page).getByTestId("srch-field")).toHaveValue("WHAT MOVED SPX TODAY?");
    await expect(active(page).locator(".cmd-error")).toHaveCount(0);
  });

  test("MENU: sector and security menus, N + Enter, ⌘↑ up a level, toolbar Menu", async ({
    page,
  }) => {
    await run(page, "CURNCY");
    await expect(fn(page)).toHaveText("MENU");
    const menu = active(page).getByTestId("sector-menu");
    await expect(menu).toContainText("CURNCY sector menu");
    await expect(menu.locator('[data-menu-row="FX"]')).toContainText(/\d+\)/);
    await run(page, "AAPL US EQUITY");
    await expect(menu).toContainText("Functions for AAPL US EQUITY");
    const des = menu.locator('[data-menu-row="DES"]');
    const n = (await des.locator(".item-n").textContent())!.replace(")", "");
    await page.screenshot({ path: shotPath("menu-security") });
    await run(page, n);
    await expect(fn(page)).toHaveText("DES");
    await expect(ticker(page)).toHaveText("AAPL US EQUITY");
    // ⌘↑: DES → AAPL's menu → the EQUITY sector menu → the main menu.
    await page.keyboard.press("Meta+ArrowUp");
    await expect(menu).toContainText("Functions for AAPL US EQUITY");
    await page.keyboard.press("Meta+ArrowUp");
    await expect(menu).toContainText("EQUITY sector menu");
    await page.keyboard.press("Meta+ArrowUp");
    await expect(menu).toContainText("Main menu");
    await expect(menu.locator('[data-menu-row="GOVT"]')).toContainText("1)");
    // Toolbar: Menu opens the window's security menu.
    await run(page, "MSFT GP");
    await active(page).getByTestId("tool-menu").click();
    await expect(fn(page)).toHaveText("MENU");
    await expect(ticker(page)).toHaveText("MSFT US EQUITY");
  });

  test("toolbar: recent securities ▾ and recent functions ▾", async ({ page }) => {
    await run(page, "AAPL GP");
    await run(page, "MSFT DES");
    await active(page).getByTestId("tool-recent-sec").click();
    const pop = active(page).locator(".win-popup");
    await expect(pop).toContainText("RECENT SECURITIES");
    await pop.getByText("AAPL US EQUITY").click();
    await expect(fn(page)).toHaveText("DES");
    await expect(ticker(page)).toHaveText("AAPL US EQUITY");
    await active(page).getByTestId("tool-recent-fn").click();
    await expect(pop).toContainText("RECENT FUNCTIONS");
    await page.screenshot({ path: shotPath("toolbar-recent") });
    await pop.getByRole("button", { name: /GP$/ }).click();
    await expect(fn(page)).toHaveText("GP");
    await expect(ticker(page)).toHaveText("AAPL US EQUITY");
  });

  test("PDF: default exchange DC, PDF COLORS, yfinance opt-in (off by default)", async ({
    page,
  }) => {
    await run(page, "PDF");
    const pdf = active(page).getByTestId("pdf");
    await expect(pdf.getByTestId("pdf-exchange").locator("select")).toHaveValue("DC");
    await expect(pdf.getByTestId("pdf-yfinance")).toContainText("OFF (default)");
    await expect(pdf.getByTestId("pdf-yfinance")).toContainText("PERSONAL USE");
    await page.screenshot({ path: shotPath("pdf") });
    await run(page, "PDF EXCH GY");
    await expect(pdf.getByTestId("pdf-exchange").locator("select")).toHaveValue("GY");
    // PDF COLORS: the colour-blind palette swaps the up/down CSS variables.
    const up = () =>
      page.evaluate(() => document.documentElement.style.getPropertyValue("--up").trim());
    expect(await up()).toBe("#00D26A");
    await run(page, "PDF COLORS COLORBLIND");
    await expect.poll(up).toBe("#56B4E9");
    await expect(active(page).getByTestId("pdf-colors").locator("select")).toHaveValue(
      "COLORBLIND",
    );
    // §4.2: in the colour-blind palette links are also underlined (up is blue like a link).
    const underline = () =>
      active(page)
        .getByTestId("help-sources")
        .locator("button.link")
        .first()
        .evaluate((el) => getComputedStyle(el).textDecorationLine);
    await run(page, "HELP SOURCES");
    await expect.poll(underline).toBe("underline");
    await run(page, "PDF COLORS STANDARD");
    await expect.poll(up).toBe("#00D26A");
    await run(page, "HELP SOURCES");
    await expect.poll(underline).toBe("none");
    // yfinance: the toggle, then HELP → Data sources shows it on.
    await run(page, "PDF");
    await pdf.getByTestId("pdf-yfinance-toggle").click();
    await expect(pdf.getByTestId("pdf-yfinance")).toContainText("ON");
    await run(page, "HELP SOURCES");
    await expect(
      active(page).getByTestId("help-sources").locator('[data-notice="yfinance"]'),
    ).toContainText("ON (enabled by you in PDF)");
    // DK: yfinance for Danish stocks and indices only (decision).
    await run(page, "PDF YFINANCE DK");
    await expect(pdf.getByTestId("pdf-yfinance")).toContainText("DK");
    await run(page, "HELP SOURCES");
    await expect(
      active(page).getByTestId("help-sources").locator('[data-notice="yfinance"]'),
    ).toContainText("Danish stocks and indices only");
    await run(page, "PDF");
    await pdf.getByTestId("pdf-yfinance-on").click();
    // Settings survive a reload (user.db).
    await page.reload();
    await run(page, "PDF");
    await expect(pdf.getByTestId("pdf-exchange").locator("select")).toHaveValue("GY");
    await expect(pdf.getByTestId("pdf-yfinance")).toContainText("ON");
  });

  test("KEYS: remap CURNCY off F11; reserved chords are refused; KEYS RESET", async ({ page }) => {
    await run(page, "KEYS");
    const keys = active(page).getByTestId("keys");
    const row = keys.locator('[data-key-row="sector-CURNCY|F11"]');
    await expect(row).toContainText("F11");
    await row.getByRole("button", { name: "F11" }).click();
    await expect(keys.getByTestId("keys-msg")).toContainText("Press the new keys");
    await page.keyboard.press("Control+Space");
    await expect(keys.getByTestId("keys-msg")).toContainText("reserved by macOS");
    await row.getByRole("button", { name: "F11" }).click();
    await page.keyboard.press("Control+Shift+KeyY");
    await expect(keys.getByTestId("keys-msg")).toContainText("CURNCY: ⌃⇧Y");
    await expect(row).toContainText("⌃⇧Y");
    await expect(row).toContainText("F11 (restore)");
    await page.screenshot({ path: shotPath("keys") });
    // The new chord works: while typing it inserts the CURNCY chip; F11 no longer does.
    const input = cmd(page);
    await input.click();
    await input.press("Control+Shift+KeyY");
    await expect(active(page).getByTestId("chip")).toHaveText("CURNCY");
    await input.press("Backspace");
    await input.press("F11");
    await expect(active(page).getByTestId("chip")).toHaveCount(0);
    await run(page, "KEYS RESET");
    await expect(row).toContainText("F11");
    await expect(row).not.toContainText("restore");
  });

  test("LOG: the structured log with level and text filters", async ({ page, request }) => {
    // A known line: the client log endpoint writes through the same JSON logger.
    const r = await request.post(`http://127.0.0.1:${process.env.NDX_E2E_PORT}/logs/client`, {
      headers: { "x-ndx-token": process.env.NDX_E2E_TOKEN! },
      data: { level: "warn", message: "e2e marker for the LOG viewer" },
    });
    expect(r.status()).toBe(204);
    await run(page, "LOG");
    await expect(fn(page)).toHaveText("LOG");
    const log = active(page).getByTestId("log");
    await expect(log.locator("tr[data-level]").first()).toBeVisible({ timeout: 15_000 });
    await active(page).getByTestId("log-filter").fill("e2e marker");
    const hit = log.locator("tr[data-level]");
    await expect(hit).toHaveCount(1);
    await expect(hit).toHaveAttribute("data-level", "WARNING");
    await expect(hit).toContainText("ndx.client");
    await page.screenshot({ path: shotPath("log") });
    await run(page, "LOG ERROR");
    await expect(active(page).locator(".ds")).toContainText("level ≥ ERROR");
    await expect(log.locator('tr[data-level="INFO"]')).toHaveCount(0);
  });
});
