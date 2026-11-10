/**
 * Window anatomy, status bar and focus model (SPEC §4.1, §4.8; §14 1b step 2) in browser mode on
 * a DEMO backend. Browser mode: hint mode is ⌃⇧J (⌘J is a browser chord).
 */
import { expect, test, type Page } from "@playwright/test";
import { cmd, resetSession, run, shotPath } from "./util";

const active = (page: Page) => page.locator(".panel.active");
const fn = (page: Page) => active(page).locator(".panel-head .panel-fn");

test.describe("anatomy, numbered items, hint mode, status bar (SPEC §4.1, §4.8)", () => {
  test.beforeEach(async ({ request, page }, info) => {
    await resetSession(request);
    // The one-time F-key tip would cover window 1's title bar; only its own test shows it.
    if (!info.title.includes("F-key tip")) {
      await page.addInitScript(() => localStorage.setItem("ndx.tip.function-keys.v1", "shown"));
    }
    await page.goto("/");
    await expect(page.getByTestId("demo-badge")).toBeVisible();
  });

  test("every window: title bar 95–97, toolbar 98–99 + link, hint bar from the keymap", async ({
    page,
  }) => {
    for (const p of await page.locator(".panel").all()) {
      await expect(p.getByTestId("title-bar").locator("[data-item]")).toHaveText([
        "95) Actions ▾",
        "96) Export ▾",
        "97) Settings",
      ]);
      await expect(p.getByTestId("win-toolbar").locator('[data-item="98"]')).toHaveText("98) Note");
      await expect(p.getByTestId("win-toolbar").locator('[data-item="99"]')).toHaveText("99) Help");
      await expect(p.getByTestId("win-toolbar").getByTestId("link-dot")).toBeVisible();
      await expect(p.getByTestId("hint-bar")).toContainText("N+Enter item");
    }
    // The DEMO badge covers no title bar, 95–97 item or link dot (review 1b #13).
    const badge = (await page.getByTestId("demo-badge").boundingBox())!;
    const overlaps = (b: { x: number; y: number; width: number; height: number }) =>
      b.x < badge.x + badge.width &&
      badge.x < b.x + b.width &&
      b.y < badge.y + badge.height &&
      badge.y < b.y + b.height;
    for (const el of await page
      .locator('[data-testid="title-bar"], [data-testid="link-dot"]')
      .all())
      expect(overlaps((await el.boundingBox())!)).toBe(false);
    // The W window's hint bar lists W's own keys (generated from PANEL_KEYMAP).
    await expect(page.locator(".panel").first().getByTestId("hint-bar")).toContainText(
      "Select row",
    );
  });

  test("DES: N + Enter runs numbered items; 98 Note, 99 Help", async ({ page }) => {
    await run(page, "AAPL DES");
    await expect(fn(page)).toHaveText("DES");
    await expect(active(page).getByTestId("win-toolbar")).toContainText("1) Quote");
    await expect(active(page).getByTestId("win-toolbar")).toContainText("3) Financials");
    await page.screenshot({ path: shotPath("anatomy-des") });
    await run(page, "1");
    await expect(fn(page)).toHaveText("Q");
    await expect(active(page).locator(".panel-ticker")).toHaveText("AAPL US EQUITY");
    await run(page, "2");
    await expect(fn(page)).toHaveText("DES");
    await run(page, "99");
    await expect(fn(page)).toHaveText("HELP");
    await expect(active(page).getByTestId("help-page")).toContainText("DES — ");
    await run(page, "MSFT DES");
    await run(page, "98");
    await expect(fn(page)).toHaveText("NOTE");
    await expect(active(page).locator(".panel-ticker")).toHaveText("MSFT US EQUITY");
    // A number the window does not show is an inline error, not a crash.
    await run(page, "42");
    await expect(active(page).locator(".cmd-error")).toHaveText("No item 42");
  });

  test("content focused: an unbound printable key jumps to the command line (§4.8)", async ({
    page,
  }) => {
    await run(page, "AAPL DES");
    await expect(fn(page)).toHaveText("DES");
    const input = active(page).locator("[data-cmd-input]");
    await page.keyboard.press("Tab");
    await expect(input).not.toBeFocused();
    await page.keyboard.press("1");
    await expect(input).toBeFocused();
    await expect(input).toHaveValue("1");
    await page.keyboard.press("Enter");
    await expect(fn(page)).toHaveText("Q");
    await page.keyboard.press("Tab");
    await expect(input).not.toBeFocused();
    await page.keyboard.type("MSFT DES");
    await expect(input).toHaveValue("MSFT DES");
    await page.keyboard.press("Enter");
    await expect(fn(page)).toHaveText("DES");
    await expect(active(page).locator(".panel-ticker")).toHaveText("MSFT US EQUITY");
  });

  test("GP: 95 Actions, 96 Export, 97 Settings (amber field: Esc reverts, Enter applies)", async ({
    page,
  }) => {
    await run(page, "AAPL GP");
    await expect(fn(page)).toHaveText("GP");
    await run(page, "95");
    const actions = active(page).getByTestId("popup-actions");
    await expect(actions).toContainText("1) 1D"); // ranges are GP's items 1–9 (SPEC §8)
    await expect(actions).toContainText("10) Description");
    await expect(actions).toContainText("New tab");
    await page.screenshot({ path: shotPath("anatomy-actions") });
    await page.keyboard.press("Escape");
    await expect(actions).toHaveCount(0);
    await run(page, "96");
    await expect(active(page).getByTestId("popup-export")).toContainText(
      "Copy visible tables as CSV",
    );
    await page.keyboard.press("Escape");
    await run(page, "97");
    const field = active(page).getByTestId("settings-field");
    await expect(field).toBeFocused();
    await expect(field).toHaveCSS("background-color", "rgb(255, 160, 40)");
    await expect(field).toHaveCSS("color", "rgb(0, 0, 0)");
    const before = await field.inputValue();
    await field.fill("1W");
    await field.press("Escape");
    await expect(field).toHaveValue(before);
    await field.fill("1W");
    await field.press("Enter");
    await expect(active(page).getByTestId("popup-settings")).toHaveCount(0);
    await expect(active(page).locator(".panel-title")).toContainText("Price chart W");
    // An invalid argument is refused with the allowed values, never applied.
    await run(page, "97");
    await active(page).getByTestId("settings-field").fill("NOPE");
    await active(page).getByTestId("settings-field").press("Enter");
    await expect(active(page).getByTestId("popup-settings")).toContainText("not valid");
  });

  test("hint mode (⌃⇧J in browser mode): typing a label activates the element", async ({
    page,
  }) => {
    await run(page, "AAPL DES");
    await cmd(page).click();
    await page.keyboard.press("Control+Shift+KeyJ");
    const layer = page.getByTestId("hint-layer");
    await expect(layer).toBeVisible();
    expect(await layer.locator(".hint-label").count()).toBeGreaterThan(20);
    await page.screenshot({ path: shotPath("hint-mode") });
    // The label drawn at the active window's "1) Quote" item.
    const label = await page.evaluate(() => {
      const el = document.querySelector('.panel.active [data-item="1"]')!;
      const r = el.getBoundingClientRect();
      const hit = [...document.querySelectorAll<HTMLElement>(".hint-label")].find(
        (h) => Math.abs(h.offsetLeft - r.left) < 1 && Math.abs(h.offsetTop - r.top) < 1,
      );
      return hit?.textContent ?? "";
    });
    expect(label).toMatch(/^[A-Z]{1,2}$/);
    for (const ch of label) await page.keyboard.press(`Key${ch}`);
    await expect(layer).toHaveCount(0);
    await expect(fn(page)).toHaveText("Q");
    // Esc leaves hint mode without activating anything.
    await page.keyboard.press("Control+Shift+KeyJ");
    await expect(layer).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(layer).toHaveCount(0);
    await expect(fn(page)).toHaveText("Q");
  });

  test("status bar: clocks, market states as text, provider health from the server", async ({
    page,
  }) => {
    const bar = page.getByTestId("status-bar");
    await expect(bar.getByTestId("clock")).toHaveCount(4);
    for (const c of await bar.getByTestId("clock").all()) {
      await expect(c).toHaveText(/^(NY|LDN|TYO|CPH)\d{2}:\d{2}$/);
    }
    const markets = bar.getByTestId("markets");
    for (const code of ["NYSE", "CPH", "STO", "OSL", "HEL", "PAR", "AMS", "SIX", "TSE"]) {
      await expect(markets.locator(".mkt-code", { hasText: new RegExp(`^${code}$`) })).toHaveCount(
        1,
      );
    }
    await expect(markets.locator("[data-state]").first()).toHaveText(
      /^(OPEN|HOLIDAY|CLOSED|N\.A\.)/,
    );
    // DEMO: the fixture source works; real providers are disabled with the server's reason.
    const prov = bar.getByTestId("providers");
    await expect(prov.locator('[data-provider="DEMO"]')).toBeVisible();
    // An opt-in source is off because of DEMO, whatever its PDF switch says (review 1b #10).
    await expect(prov.locator('[data-off="opt-in"]')).toHaveCount(0);
    await expect(prov.locator('[data-off="DEMO"]')).toContainText("BINANCE");
    await expect(prov.locator('[data-off="DEMO"]')).toContainText("YAHOO");
    await expect(prov.locator('[data-off="DEMO"]')).toHaveAttribute(
      "title",
      /DEMO mode: fixtures only, no network/,
    );
    await expect(prov).toContainText(/SERVER \d+ ms/);
    await bar.screenshot({ path: shotPath("status-bar") });
  });

  test("the one-time F-key tip is shown in full, not cut off", async ({ page }) => {
    const tip = page.locator(".panel.active").getByTestId("cmd-message");
    await expect(tip).toContainText("Mission Control");
    await expect(tip).toHaveClass(/cmd-note/);
    const cut = await tip.evaluate((el) => el.scrollWidth > el.clientWidth + 1);
    expect(cut).toBe(false);
  });
});
