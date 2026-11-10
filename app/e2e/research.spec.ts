/**
 * Phase 3 — research functions (SPEC §8, §14). Browser mode, DEMO backend.
 */
import { expect, test, type Page } from "@playwright/test";
import { resetSession, resetSettings, run, shotPath } from "./util";

const active = (page: Page) => page.locator(".panel.active");

test.describe("research functions (SPEC §8)", () => {
  test.beforeEach(async ({ request, page }) => {
    await resetSession(request);
    await resetSettings(request);
    await page.addInitScript(() => localStorage.setItem("ndx.tip.function-keys.v1", "shown"));
    await page.goto("/");
    await expect(page.getByTestId("demo-badge")).toBeVisible();
  });

  test("TOP: filters, my lists, sort, reader, keyword alert", async ({ page }) => {
    await run(page, "TOP DK");
    const top = active(page);
    const rows = top.getByTestId("news-row");
    await expect(rows).toHaveCount(3); // Novo, Maersk, the Danish central bank
    await expect(top.getByTestId("news-toolbar")).toContainText("REGION (r) Denmark");
    await page.keyboard.press("Escape"); // command line → content (keyboard only, §4.8)
    await page.keyboard.press("r"); // Denmark → Asia-Pacific
    await expect(top.getByTestId("news-toolbar")).toContainText("REGION (r) Asia-Pacific");
    await page.keyboard.press("r"); // → all
    await expect(rows).toHaveCount(13);
    await page.keyboard.press("t"); // topic: Earnings
    await expect(top.getByTestId("news-toolbar")).toContainText("TOPIC (t) Earnings");
    await expect(rows.first()).toContainText("Novo Nordisk");
    await page.keyboard.press("t"); // → M&A
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("Microsoft agrees deal");
    for (let i = 0; i < 4; i++) await page.keyboard.press("t"); // … → all
    await page.keyboard.press("w"); // only my watchlists' tickers (US CORE, DENMARK C25 seeds)
    await expect(top.getByTestId("news-mine")).toContainText("ON");
    const mine = await rows.locator(".news-head").allInnerTexts();
    expect(mine.length).toBeGreaterThan(2);
    for (const h of mine) expect(h).toContain("●");
    await page.keyboard.press("w");
    await page.keyboard.press("s"); // rank → time: newest first
    await expect(top.getByTestId("news-sort")).toContainText("TIME");
    await expect(rows.first()).toContainText("Novo Nordisk raises"); // 3 min ago (kept earliest)
    // Reader: the selected row's summary, or N.A. with the reason.
    await page.keyboard.press("ArrowDown");
    const reader = top.getByTestId("news-reader");
    await expect(reader).toContainText("Container rates");
    await expect(reader).toContainText("Open original");
    // Keyword alert: b focuses the amber field; Enter saves it.
    await page.keyboard.press("b");
    await page.keyboard.type("ECB");
    await page.keyboard.press("Enter");
    await expect(top.getByTestId("news-alert-rule")).toHaveText(/ECB/);
    await page.screenshot({ path: shotPath("top-filters") });
  });

  test("N menu → TOP with a filter; CN for the loaded security; chips open Q", async ({ page }) => {
    await run(page, "NOVOB DC EQUITY N");
    const menu = active(page).getByTestId("n-menu");
    await expect(menu).toContainText("1)Top news");
    await expect(menu).toContainText("Company news: NOVOB DC EQUITY");
    await page.screenshot({ path: shotPath("n-menu") });
    await run(page, "5"); // Denmark
    await expect(active(page).locator(".panel-fn")).toHaveText("TOP");
    await expect(active(page).getByTestId("news-row")).toHaveCount(3);
    await run(page, "NOVOB DC EQUITY CN");
    const cn = active(page);
    await expect(cn.locator(".panel-fn")).toHaveText("CN");
    const rows = cn.getByTestId("news-row");
    await expect(rows).toHaveCount(1); // one story, its near-duplicate collapsed into it
    await expect(rows.first()).toContainText("+1 similar");
    await expect(cn.getByTestId("news-sort")).toContainText("TIME");
    await expect(cn.getByTestId("news-similar")).toContainText("Sample Markets Daily");
    await page.screenshot({ path: shotPath("cn-novo") });
    await rows.first().locator(".news-chip").first().click();
    await expect(active(page).locator(".panel-fn")).toHaveText("Q");
    await expect(active(page).locator(".panel-ticker")).toHaveText("NOVOB DC EQUITY");
  });

  test("PDF NEWS: RSS feeds are added on the page, invalid URLs refused", async ({ page }) => {
    await run(page, "PDF NEWS");
    const pdf = active(page).getByTestId("pdf-news");
    await expect(pdf).toContainText("None by default");
    await page.keyboard.press("Escape"); // command line → content
    await page.keyboard.press("n");
    await page.keyboard.type("javascript:alert(1)");
    await page.keyboard.press("Enter");
    await expect(pdf).toContainText("not a valid http(s) URL");
    await expect(pdf.getByTestId("pdf-news-feed")).toHaveCount(0);
    await page.keyboard.press("n");
    await page.keyboard.type("https://example.com/feed.xml");
    await page.keyboard.press("Enter");
    await expect(pdf.getByTestId("pdf-news-feed")).toHaveText(/https:\/\/example\.com\/feed\.xml/);
    await page.screenshot({ path: shotPath("pdf-news") });
    await pdf.getByTestId("pdf-news-feed").getByRole("button").click();
    await expect(pdf.getByTestId("pdf-news-feed")).toHaveCount(0);
  });

  test("ECO: importance, country and date keys; countries without a source say so", async ({
    page,
  }) => {
    await run(page, "ECO");
    const eco = active(page).getByTestId("eco");
    const rows = eco.getByTestId("eco-row");
    const bar = eco.getByTestId("eco-toolbar");
    await expect(rows).toHaveCount(14); // yesterday + 6 days of the DEMO calendar
    await expect(eco.getByTestId("eco-day")).toHaveCount(5);
    await expect(bar).toContainText("RANGE (d) Yesterday + 6 days");
    await expect(eco.locator("th", { hasText: "SURVEY" })).toHaveAttribute("title", /consensus/);
    await page.keyboard.press("Escape"); // command line → content
    await page.keyboard.press("i");
    await expect(bar).toContainText("IMPORTANCE (i) ●● and up");
    await expect(rows).toHaveCount(11);
    await page.keyboard.press("i");
    await expect(rows).toHaveCount(7);
    await page.keyboard.press("i"); // → all
    await expect(rows).toHaveCount(14);
    await page.keyboard.press("c");
    await expect(bar).toContainText("COUNTRY (c) United States");
    await expect(rows).toHaveCount(7);
    await page.keyboard.press("c");
    await expect(rows).toHaveCount(5); // euro area
    await page.keyboard.press("c"); // Germany: no free official calendar wired
    await expect(eco.getByTestId("eco-nosource")).toContainText("Germany");
    await expect(rows).toHaveCount(0);
    await page.keyboard.press("d"); // → today
    await expect(bar).toContainText("RANGE (d) Today");
    await page.keyboard.press("n"); // nothing ahead: the key stays in ECO, not the command line
    await expect(active(page).getByTestId("command-line").locator("input")).toHaveValue("");
    await page.screenshot({ path: shotPath("eco-filters") });
    await run(page, "ECO UK");
    await expect(active(page).getByTestId("eco-nosource")).toContainText("United Kingdom");
    await expect(active(page).getByTestId("eco-nosource")).toContainText("N.A.");
    await run(page, "ECO US HIGH");
    const us = active(page).getByTestId("eco-row");
    await expect(us).toHaveCount(4); // CPI MoM, CPI YoY, FOMC, GDP
    await us.filter({ hasText: "FOMC" }).click();
    await expect(us.filter({ hasText: "FOMC" })).toHaveClass(/sel/);
    await expect(us.filter({ hasText: "FOMC" })).toContainText("20:00*"); // 14:00 ET
    await expect(us.filter({ hasText: "FOMC" })).toContainText("4.00%"); // prior: current target
    await page.screenshot({ path: shotPath("eco-us-high") });
  });

  test("ECST: Enter on an ECO line opens its series history; ranges; list keys", async ({
    page,
  }) => {
    await run(page, "ECO TODAY");
    const eco = active(page).getByTestId("eco");
    await expect(eco.getByTestId("eco-row")).toHaveCount(7);
    await page.keyboard.press("Escape"); // command line → content
    await page.keyboard.press("j"); // DK CPI → ECB stats (no series) → …
    await page.keyboard.press("k"); // back to DK CPI YoY
    await page.keyboard.press("Enter");
    const ecst = active(page).getByTestId("ecst");
    await expect(active(page).locator(".panel-fn")).toHaveText("ECST");
    await expect(ecst.getByTestId("ecst-title")).toHaveText("DK CPI YoY");
    await expect(ecst.getByTestId("ecst-last")).toHaveText(/\d\.\d%/);
    await expect(ecst.getByTestId("ecst-facts")).toContainText("2026-10");
    await expect(ecst.getByTestId("ecst-facts")).toContainText("LAST RELEASE 2026-11-09 08:00");
    await expect(ecst.getByTestId("ecst-chart").locator("canvas").first()).toBeVisible();
    await expect(ecst.getByTestId("ecst-row")).toHaveCount(12);
    await expect(ecst.locator(".lat").first()).toContainText("DEMO");
    await ecst.getByTestId("ecst-list").click(); // focus the new window's content
    await page.keyboard.press("1"); // 2Y
    await expect(ecst.getByTestId("ecst-ranges")).toContainText("24 observations");
    await page.screenshot({ path: shotPath("ecst-dk-cpi") });
    await page.keyboard.press("k"); // the list moves the detail
    await expect(ecst.getByTestId("ecst-title")).not.toHaveText("DK CPI YoY");
    await run(page, "ECST NOPE");
    await expect(active(page).getByTestId("ecst-unknown")).toContainText("NOPE");
  });

  test("DES renders for AAPL, NOVOB DC and SPY (SPEC §8 acceptance)", async ({ page }) => {
    for (const [cmdText, name] of [
      ["AAPL US EQUITY DES", "Apple"],
      ["NOVOB DC EQUITY DES", "Novo"],
      ["SPY US EQUITY DES", "SPDR"],
    ] as const) {
      await run(page, cmdText);
      const p = active(page);
      await expect(p.locator(".panel-fn")).toHaveText("DES");
      await expect(p.locator(".section-title").first()).toBeVisible();
      await expect(p).toContainText(name);
      await expect(p).toContainText("MARKET CAP");
      await expect(p.locator(".lat").first()).toContainText("DEMO");
    }
    await page.screenshot({ path: shotPath("des-spy") });
  });

  test("FA: latest period first, statements by key, N.A. without a source", async ({ page }) => {
    await run(page, "AAPL US EQUITY FA");
    const fa = active(page);
    await expect(fa.getByTestId("fa-line").first()).toContainText("Revenue");
    const heads = await fa.locator("thead th").allInnerTexts();
    expect(heads[1]).toBe("2025-12-31"); // newest fiscal year first
    expect(heads[heads.length - 2]).toBe("2021-12-31");
    await expect(fa.locator(".lat").first()).toContainText("DEMO");
    await page.keyboard.press("Escape");
    await page.keyboard.press("4"); // ratios
    await expect(fa.getByTestId("fa-line").first()).toContainText("margin");
    await page.screenshot({ path: shotPath("fa-aapl-ratios") });
    await run(page, "BTCUSD CURNCY FA");
    await expect(active(page).getByTestId("fa-na")).toContainText("N.A.");
  });
});
