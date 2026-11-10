/**
 * Windows, tabs, layouts and linking (SPEC §4.9, §14 1b step 1) in browser mode on a DEMO backend.
 * Browser mode uses the keymap's alternates for chords Chromium keeps (⌘[ → ⌃⇧[, ⌘W → ⌃⇧W, …).
 */
import { expect, test, type Page } from "@playwright/test";
import { cmd, resetSession, run, shotPath } from "./util";

const win = (page: Page, n: number) => page.locator(".panel").nth(n - 1);
const head = (page: Page) => page.locator(".panel.active .panel-head");

async function expectActive(page: Page, ticker: string | null, fn: string) {
  if (ticker) await expect(head(page).locator(".panel-ticker")).toHaveText(ticker);
  await expect(head(page).locator(".panel-fn")).toHaveText(fn);
}

test.describe("windows, tabs, layouts, linking (SPEC §4.9)", () => {
  test.beforeEach(async ({ request, page }) => {
    await resetSession(request);
    await page.goto("/");
    await expect(page.getByTestId("demo-badge")).toBeVisible();
  });

  test("classic 2×2: every window has its own command line and runs commands there", async ({
    page,
  }) => {
    await expect(page.getByTestId("workspace")).toHaveAttribute("data-mode", "classic");
    await expect(page.locator(".panel")).toHaveCount(4);
    await expect(page.locator(".panel").getByTestId("command-line")).toHaveCount(4);
    // Window 1 (W) is active at launch; type into window 4's own command line instead.
    const four = win(page, 4).getByTestId("command-line").locator("input");
    await four.click();
    await expect(win(page, 4)).toHaveClass(/active/);
    await four.fill("AAPL DES");
    await four.press("Enter");
    await expect(win(page, 4).locator(".panel-fn")).toHaveText("DES");
    await expect(win(page, 4).locator(".panel-ticker")).toHaveText("AAPL US EQUITY");
    await expect(win(page, 1).locator(".panel-fn")).toHaveText("W");
    // A second window gets its own command, independently.
    const two = win(page, 2).getByTestId("command-line").locator("input");
    await two.click();
    await two.fill("EURUSD CURNCY Q");
    await two.press("Enter");
    await expect(win(page, 2).locator(".panel-ticker")).toHaveText("EURUSD CURNCY");
    await expect(win(page, 4).locator(".panel-fn")).toHaveText("DES");
    await expect(win(page, 4).locator(".lat-DEMO").first()).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(400);
    await page.screenshot({ path: shotPath("classic-2x2") });
  });

  test("back / forward per tab, Backspace on an empty command line = BACK", async ({ page }) => {
    await run(page, "AAPL GP");
    await run(page, "AAPL DES");
    await expectActive(page, "AAPL US EQUITY", "DES");
    const input = cmd(page);
    await input.press("Backspace");
    await expectActive(page, "AAPL US EQUITY", "GP");
    await input.press("Control+Shift+BracketLeft"); // ⌘[ in the app
    await expectActive(page, null, "W");
    await input.press("Control+Shift+BracketRight"); // ⌘]
    await expectActive(page, "AAPL US EQUITY", "GP");
    await input.press("Control+Shift+BracketRight");
    await expectActive(page, "AAPL US EQUITY", "DES");
  });

  test("tabs: GO in a new tab, close it, reopen it (a stack)", async ({ page }) => {
    await run(page, "AAPL GP", { newTab: true });
    await run(page, "MSFT DES", { newTab: true });
    const tabs = page.locator(".panel.active").getByTestId("tab");
    await expect(tabs).toHaveCount(3);
    await expectActive(page, "MSFT US EQUITY", "DES");
    // Tabs keep their own history: back in tab 3 has nowhere to go; tab 2 is still GP.
    await tabs.nth(1).dispatchEvent("mousedown");
    await expectActive(page, "AAPL US EQUITY", "GP");
    await tabs.nth(2).dispatchEvent("mousedown");
    const input = cmd(page);
    await input.click();
    await input.press("Control+Shift+KeyW"); // ⌘W: close tab 3
    await expect(tabs).toHaveCount(2);
    await input.press("Control+Shift+KeyW"); // close tab 2
    await expect(tabs).toHaveCount(0); // one tab left: no tab strip
    await expectActive(page, null, "W");
    await input.press("Control+Shift+KeyU"); // ⌘⇧T: reopen the last closed (AAPL GP)
    await expectActive(page, "AAPL US EQUITY", "GP");
    await input.press("Control+Shift+KeyU"); // then MSFT DES
    await expectActive(page, "MSFT US EQUITY", "DES");
    await expect(tabs).toHaveCount(3);
  });

  test("workspace: 3 windows with tabs, LINK, POP, drag a ticker onto a window", async ({
    page,
  }) => {
    // Classic window 3 (GP SPY) joins RED, then POP sends it into the workspace as a component.
    await win(page, 3).getByTestId("command-line").locator("input").click();
    await run(page, "LINK RED");
    await expect(win(page, 3)).toHaveAttribute("data-link", "red");
    await run(page, "POP");
    await expect(page.getByTestId("workspace")).toHaveAttribute("data-mode", "workspace");
    const comp = page.locator(".panel.component");
    await expect(comp).toHaveCount(1);
    await expect(comp).toHaveAttribute("data-link", "red");
    await expect(comp.locator(".panel-ticker")).toHaveText("SPY US EQUITY");
    // A new free window (⌥\ outside text fields), linked RED: loading NVDA moves the component.
    await page.keyboard.press("Alt+Backslash");
    await expect(page.locator(".panel.free")).toHaveCount(2);
    await run(page, "LINK RED");
    await run(page, "NVDA DES");
    await expectActive(page, "NVDA US EQUITY", "DES");
    await expect(comp.locator(".panel-ticker")).toHaveText("NVDA US EQUITY");
    await expect(comp.locator(".panel-fn")).toHaveText("GP");
    // A third window with a watchlist and a second tab.
    await cmd(page).press("Escape");
    await page.keyboard.press("Alt+Backslash");
    await expect(page.locator(".panel.free")).toHaveCount(3);
    await run(page, "W");
    await run(page, "WEI", { newTab: true });
    await expect(page.locator(".panel.active").getByTestId("tab")).toHaveCount(2);
    await page.locator(".panel.active").getByTestId("tab").first().dispatchEvent("mousedown");
    await expectActive(page, null, "W");
    // 2 free windows; the POPped component does not count toward the 16 (review 1b #26).
    await expect(page.getByTestId("mode-tag")).toHaveText("WORKSPACE 2/16");
    // Drag a ticker from the watchlist grid onto the NVDA window: it loads there (and in RED).
    const row = page.locator(".panel.active tbody tr[draggable=true]").first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    const sym = (await row.locator("td").first().textContent())!.trim();
    const target = page.locator(".panel.free").nth(1);
    await row.dragTo(target.locator(".panel-body"));
    await expect(target.locator(".panel-ticker")).toHaveText(sym);
    await expect(comp.locator(".panel-ticker")).toHaveText(sym);
    await page.waitForTimeout(400);
    await page.screenshot({ path: shotPath("workspace") });
    // LINK alone lists the windows and their colours.
    await run(page, "LINK");
    await expect(page.getByTestId("link-table").locator("tbody tr")).toHaveCount(3);
  });

  test("LAYOUT SAVE <name> / LAYOUT <name> / LAYOUT (list)", async ({ page }) => {
    await run(page, "AAPL DES");
    await run(page, "LINK BLUE");
    await run(page, "LAYOUT SAVE MORNING");
    await run(page, "LAYOUT RESET");
    await expectActive(page, null, "W");
    await expect(page.locator(".panel").first()).toHaveAttribute("data-link", "none");
    await run(page, "LAYOUT MORNING");
    await expectActive(page, "AAPL US EQUITY", "DES");
    await expect(page.locator(".panel.active")).toHaveAttribute("data-link", "blue");
    await run(page, "LAYOUT");
    await expectActive(page, null, "LAYOUT");
    await expect(page.locator(".panel.active td", { hasText: "morning" })).toBeVisible();
  });

  test("OFF saves the session; a restart restores windows, tabs, links and history", async ({
    page,
  }) => {
    await run(page, "AAPL GP");
    await run(page, "AAPL DES");
    await run(page, "MSFT Q", { newTab: true });
    await run(page, "LINK GREEN");
    await run(page, "LAYOUT WORKSPACE");
    await expect(page.locator(".panel.free")).toHaveCount(1);
    await run(page, "OFF");
    await expect(page.locator(".panel.active .cmd-info")).toContainText("Session saved");
    await page.reload();
    await expect(page.getByTestId("workspace")).toHaveAttribute("data-mode", "workspace");
    await expect(page.locator(".panel.free")).toHaveCount(1);
    await run(page, "LAYOUT CLASSIC");
    const one = page.locator(".panel").first();
    await expect(one).toHaveAttribute("data-link", "green");
    await expect(one.getByTestId("tab")).toHaveCount(2);
    await expectActive(page, "MSFT US EQUITY", "Q");
    await one.getByTestId("tab").first().dispatchEvent("mousedown");
    await expectActive(page, "AAPL US EQUITY", "DES");
    await cmd(page).press("Backspace"); // history survived the restart
    await expectActive(page, "AAPL US EQUITY", "GP");
  });
});
