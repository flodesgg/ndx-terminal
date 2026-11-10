import { expect, test } from "@playwright/test";
import { cmd, resetSession, shotPath } from "./util";

test.describe("DEMO mode (browser mode, fixtures only)", () => {
  test.beforeEach(async ({ request }) => resetSession(request));

  test("boots with the DEMO badge, command line and status bar", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("demo-badge")).toBeVisible();
    await expect(page.getByTestId("demo-badge")).toHaveText("DEMO");
    await expect(page.getByTestId("command-line")).toHaveCount(4); // one per classic window
    await expect(page.getByTestId("status-bar")).toBeVisible();
    await page.screenshot({ path: shotPath("demo-boot"), fullPage: false });
  });

  test("a command renders fixture data tagged DEMO", async ({ page }) => {
    await page.goto("/");
    const input = cmd(page);
    await input.click();
    await input.fill("AAPL GP");
    await input.press("Enter");
    // The default layout already has a DEMO GP panel: check that AAPL GP itself opened.
    const head = page.locator(".panel.active .panel-head");
    await expect(head.locator(".panel-ticker")).toHaveText("AAPL US EQUITY");
    await expect(head.locator(".panel-fn")).toHaveText("GP");
    const active = page.locator(".panel.active");
    await expect(active.locator(".lat-DEMO").first()).toBeVisible({ timeout: 15_000 });
    await expect(active.locator("canvas").first()).toBeVisible();
    await expect(page.getByTestId("demo-badge")).toBeVisible();
    await page.waitForTimeout(500); // let the chart finish its first paint
    await page.screenshot({ path: shotPath("demo-gp-aapl") });
  });

  test("a canonical ID (SPEC §5) opens the same security", async ({ page }) => {
    await page.goto("/");
    const input = cmd(page);
    await input.click();
    await input.fill("NOVOB DC EQUITY DES");
    await input.press("Enter");
    await expect(page.locator(".panel.active .panel-head .panel-fn")).toHaveText("DES");
    await expect(page.getByText("Novo Nordisk B (DEMO)").first()).toBeVisible({ timeout: 15_000 });
    await expect(page.locator(".lat-DEMO").first()).toBeVisible();
    await page.screenshot({ path: shotPath("demo-des-canonical") });
    // Default watchlists are stored as canonical IDs.
    // (/__ndx/backend answers same-origin page requests only, so ask from inside the page.)
    const first = await page.evaluate(async () => {
      const info = (await (await fetch("/__ndx/backend")).json()) as {
        port: number;
        token: string;
      };
      const r = await fetch(`http://127.0.0.1:${info.port}/watchlists`, {
        headers: { "x-ndx-token": info.token },
      });
      const lists = (await r.json()) as { symbols: string[] }[];
      return lists[0]!.symbols[0];
    });
    expect(first).toBe("SPY US EQUITY");
  });

  test("Russian layout input runs its layout-fixed command (SPEC §4.6, scenario step 5)", async ({
    page,
  }) => {
    await page.goto("/");
    const input = cmd(page);
    await input.click();
    await input.fill("ТЩМЩИ ВС УЙГШЕН ПЗ"); // typed on Russian – PC: NOVOB DC EQUITY GP
    await input.press("Enter");
    const head = page.locator(".panel.active .panel-head");
    await expect(head.locator(".panel-ticker")).toHaveText("NOVOB DC EQUITY", { timeout: 15_000 });
    await expect(head.locator(".panel-fn")).toHaveText("GP");
    const active = page.locator(".panel.active");
    await expect(active.locator(".lat-DEMO").first()).toBeVisible({ timeout: 15_000 });
    await expect(active.locator("canvas").first()).toBeVisible();
    await page.waitForTimeout(500);
    await page.screenshot({ path: shotPath("demo-ru-layout-gp") });
  });

  test("autocomplete is local and a sector key adds a chip (SPEC §4.4, §4.7)", async ({ page }) => {
    await page.goto("/");
    const input = cmd(page);
    await input.click();
    await input.pressSequentially("novo");
    const suggest = page.getByTestId("suggest");
    await expect(suggest.getByText("NOVOB DC EQUITY").first()).toBeVisible();
    await page.screenshot({ path: shotPath("demo-autocomplete") });
    // §4.5 CANCEL: the first Esc clears the command line (and with it the suggestions).
    await input.press("Escape");
    await expect(input).toHaveValue("");
    await expect(suggest).toHaveCount(0);
    await expect(input).toBeFocused();
    await input.press("F11"); // CURNCY sector key
    await expect(page.locator(".panel.active").getByTestId("chip")).toHaveText("CURNCY");
    await input.pressSequentially("eurusd gp");
    await page.screenshot({ path: shotPath("demo-sector-chip") });
    await input.press("Enter");
    const head = page.locator(".panel.active .panel-head");
    await expect(head.locator(".panel-ticker")).toHaveText("EURUSD CURNCY", { timeout: 15_000 });
    await expect(head.locator(".panel-fn")).toHaveText("GP");
  });

  test("an unknown ticker offers a picker that keeps the function (§4.3 rule 6)", async ({
    page,
  }) => {
    await page.goto("/");
    const input = cmd(page);
    await input.click();
    await input.fill("aapll gp");
    await input.press("Enter");
    const suggest = page.getByTestId("suggest");
    await expect(suggest.getByText("AAPL US EQUITY").first()).toBeVisible();
    await input.press("ArrowDown");
    await input.press("Enter");
    const head = page.locator(".panel.active .panel-head");
    await expect(head.locator(".panel-ticker")).toHaveText("AAPL US EQUITY");
    await expect(head.locator(".panel-fn")).toHaveText("GP");
  });

  test("the launch token is not in the page URL or the JS bundle", async ({ page }) => {
    const scripts: string[] = [];
    page.on("response", async (r) => {
      if (r.url().endsWith(".js") || r.url().includes(".ts")) scripts.push(await r.text());
    });
    await page.goto("/");
    await expect(page.getByTestId("demo-badge")).toBeVisible();
    const token = process.env.NDX_E2E_TOKEN!;
    expect(page.url()).not.toContain(token);
    for (const s of scripts) expect(s).not.toContain(token);
  });
});
