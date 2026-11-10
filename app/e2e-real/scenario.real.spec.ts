/**
 * §13 "Morning in Copenhagen" steps 4–5 with REAL data (SPEC §14 phase 2 exit), plus the
 * phase-2 market functions on real sources. Market states depend on the hour of the run, so
 * the checks follow the venue calendars instead of a fixed time: a row is dimmed exactly when
 * its venue is closed or on holiday. Every tag is recorded in real-*.json next to the PNGs.
 *
 * Budget: Copenhagen lines come from EODHD Free (20 calls a day per account, one per symbol).
 * `-g "step"` runs only the two scenario steps (about 3 calls); the C25 monitor asks for 25
 * symbols and is honest about the ones the day's budget does not cover.
 */
import { expect, test, type Page } from "@playwright/test";
import { cmd, run, shotPath, writeReport } from "../e2e/util";

/** `NDX_REAL_YFINANCE=DK make real-scenario`: the run with yfinance on (PDF YFINANCE ON|DK);
 * its evidence gets a `-yf-on`/`-yf-dk` suffix so it sits next to the run without yfinance. */
const YF = (process.env.NDX_REAL_YFINANCE ?? "OFF").toUpperCase();
if (!["ON", "DK", "OFF"].includes(YF)) throw new Error(`NDX_REAL_YFINANCE=${YF}: ON, DK or OFF`);
const ev = (name: string) => (YF === "OFF" ? name : `${name}-yf-${YF.toLowerCase()}`);

test.beforeAll(async ({ request }) => {
  const r = await request.put(`http://127.0.0.1:${process.env.NDX_E2E_PORT}/providers/opt-in`, {
    headers: { "x-ndx-token": process.env.NDX_E2E_TOKEN! },
    data: { yfinance: YF !== "OFF", yfinance_scope: YF === "DK" ? "dk_indices" : "all" },
  });
  if (!r.ok()) throw new Error(`PUT /providers/opt-in: ${r.status()}`);
});

const win = (page: Page, n: number) => page.locator(".panel").nth(n - 1);
const active = (page: Page) => page.locator(".panel.active");

interface RowFact {
  key: string | null;
  state: string | null;
  dimmed: boolean;
  tag: string | null;
  why: string | null;
  text: string;
}

/** Board rows (WEI, WFX, GLCO): the value's tag, or the reason it has none. */
async function rowFacts(page: Page, table: string): Promise<RowFact[]> {
  return page.locator(`.panel.active ${table} tbody tr[data-row-key]`).evaluateAll((trs) =>
    trs.map((tr) => ({
      key: tr.getAttribute("data-row-key"),
      state: tr.getAttribute("data-state"),
      dimmed: tr.classList.contains("closed"),
      tag: tr.querySelector(".lat")?.textContent?.trim() ?? null,
      why: tr.getAttribute("title") || null,
      text: (tr as HTMLElement).innerText.replace(/\s+/g, " ").trim(),
    })),
  );
}

/** Rows that have a value or a stated reason for not having one (no row left pending). */
async function resolved(page: Page, table: string): Promise<{ done: number; total: number }> {
  const facts = await rowFacts(page, table);
  return { done: facts.filter((r) => r.tag || r.why).length, total: facts.length };
}

/** Boards fetch only the rows on screen: scroll the first unresolved row into view, as a user
 * would, until every row has a value or a stated reason. */
async function settle(page: Page, table: string, timeout = 90_000): Promise<void> {
  await expect
    .poll(
      async () => {
        const r = await resolved(page, table);
        if (r.total > 0 && r.done < r.total)
          await page.locator(`.panel.active ${table} tbody tr[data-row-key]`).evaluateAll((trs) => {
            const open = trs.find((tr) => !tr.querySelector(".lat") && !tr.getAttribute("title"));
            open?.scrollIntoView({ block: "center" });
          });
        return r.total > 0 && r.done === r.total;
      },
      { timeout, intervals: [1000] },
    )
    .toBe(true);
}

test.describe("§13 steps 4–5 with real data", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("ndx.tip.function-keys.v1", "shown"));
    await page.goto("/");
    await expect(page.getByTestId("status-bar")).toBeVisible();
    await expect(page.getByTestId("demo-badge")).toHaveCount(0);
  });

  test("step 4: WEI — closed venues dimmed, tags as the sources state them, US futures", async ({
    page,
  }) => {
    await run(page, "WEI");
    await settle(page, "table.grid");
    // Every WEI venue has a calendar: wait for the states too, or the dimming check would pass
    // on rows that have none yet (real run 2026-11-10: quotes came first from yfinance).
    await expect
      .poll(async () => (await rowFacts(page, "table.grid")).every((r) => r.state), {
        timeout: 30_000,
      })
      .toBe(true);
    // % YTD comes from daily bars (one request per row): wait until none is still loading,
    // scrolling each into view as the board fetches on-screen rows only.
    const loadingYtd = page.locator('.panel.active [data-testid="ytd"][title="% YTD · loading"]');
    await expect
      .poll(
        async () => {
          const n = await loadingYtd.count();
          if (n) await loadingYtd.first().scrollIntoViewIfNeeded();
          return n;
        },
        { timeout: 90_000, intervals: [1000] },
      )
      .toBe(0);
    await page
      .locator(".panel.active table.grid tbody tr[data-row-key]")
      .first()
      .scrollIntoViewIfNeeded();
    const rows = await rowFacts(page, "table.grid");
    for (const r of rows) {
      const closed = r.state === "CLOSED" || r.state === "HOLIDAY";
      expect(r.dimmed, `${r.key} ${r.state}`).toBe(closed);
    }
    await expect(active(page).locator(".lat-DEMO")).toHaveCount(0);
    // Copenhagen's index carries a real value with its source tag (EODHD close or yfinance).
    expect(rows.find((r) => r.key === "^OMXC25")?.tag, "OMXC25").toBeTruthy();
    const usCash = rows.find((r) => r.key === "^GSPC");
    const futures = rows.filter((r) => r.key?.endsWith("=F"));
    if (usCash?.state !== "OPEN") expect(futures.length).toBe(3);
    writeReport(ev("real-scenario-4-wei"), { at: new Date().toISOString(), rows });
    await page.screenshot({ path: shotPath(ev("real-scenario-4-wei")) });
  });

  test("step 5: Russian layout → NOVOB DC EQUITY chart; red-linked windows follow", async ({
    page,
  }) => {
    await win(page, 4).getByTestId("command-line").locator("input").click();
    await run(page, "AAPL DES");
    await run(page, "LINK RED");
    await win(page, 3).getByTestId("command-line").locator("input").click();
    await run(page, "LINK RED");
    const input = cmd(page);
    await input.fill("ТЩМЩИ ВС УЙГШЕН ПЗ"); // Russian – PC: NOVOB DC EQUITY GP
    await input.press("Enter");
    await expect(win(page, 3).locator(".panel-ticker")).toHaveText("NOVOB DC EQUITY", {
      timeout: 30_000,
    });
    await expect(win(page, 3).locator(".panel-fn")).toHaveText("GP");
    await expect(win(page, 4).locator(".panel-ticker")).toHaveText("NOVOB DC EQUITY");
    await expect(win(page, 3).locator("canvas").first()).toBeVisible({ timeout: 60_000 });
    await expect(win(page, 3).locator(".lat").first()).toBeVisible({ timeout: 60_000 });
    await expect(page.locator(".lat-DEMO")).toHaveCount(0);
    await page.waitForTimeout(2000);
    const tags = await win(page, 3).locator(".lat").allInnerTexts();
    // DES may be a stated N.A. (no free profile source outside the US): wait until it says
    // something other than loading, then record it.
    await expect(win(page, 4).locator(".panel-body")).not.toContainText(/loading/i, {
      timeout: 60_000,
    });
    const des = (await win(page, 4).locator(".panel-body").innerText()).slice(0, 400);
    writeReport(ev("real-scenario-5-novo"), {
      at: new Date().toISOString(),
      gpTags: tags,
      desLine: des,
    });
    await page.screenshot({ path: shotPath(ev("real-scenario-5-novo")) });
  });
});

test.describe("phase-2 functions on real sources", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("ndx.tip.function-keys.v1", "shown"));
    await page.goto("/");
    await expect(page.getByTestId("status-bar")).toBeVisible();
    await expect(page.getByTestId("demo-badge")).toHaveCount(0);
  });

  test("MON: US CORE live, DENMARK C25 within the EODHD budget", async ({ page }) => {
    await run(page, "MON US CORE");
    const mon = active(page).getByTestId("mon");
    await expect(mon.locator('tr[data-symbol="AAPL US EQUITY"] .lat')).toBeVisible({
      timeout: 60_000,
    });
    await page.waitForTimeout(3000);
    const lines = (sel: string) =>
      mon.locator(sel).evaluateAll((trs) =>
        trs.map((tr) => ({
          symbol: tr.getAttribute("data-symbol"),
          tag: tr.querySelector(".lat")?.textContent?.trim() ?? null,
          dimmed: tr.classList.contains("closed"),
          text: (tr as HTMLElement).innerText.replace(/\s+/g, " ").trim(),
        })),
      );
    const usCore = await lines("tbody tr[data-symbol]");
    await page.screenshot({ path: shotPath(ev("real-mon-us-core")) });
    await active(page)
      .getByTestId("mon-tabs")
      .getByRole("button", { name: /^DENMARK C25 / })
      .click();
    await expect(mon.locator('tr[data-symbol="NOVOB DC EQUITY"]')).toBeVisible();
    await page.waitForTimeout(20_000);
    const c25 = await lines("tbody tr[data-symbol]");
    expect(c25).toHaveLength(25);
    await expect(active(page).locator(".lat-DEMO")).toHaveCount(0);
    writeReport(ev("real-mon"), { at: new Date().toISOString(), usCore, c25 });
    await page.screenshot({ path: shotPath(ev("real-mon-c25")) });
  });

  test("WFX, GLCO, CRYPTO, GP 5-minute and Q of a US stock", async ({ page }) => {
    const report: Record<string, unknown> = { at: new Date().toISOString() };

    await run(page, "WFX");
    await settle(page, "table.grid");
    report.wfx = await rowFacts(page, "table.grid");
    await page.screenshot({ path: shotPath(ev("real-wfx")) });

    await run(page, "GLCO");
    const spot = active(page).getByTestId("glco-spot");
    await expect(spot.locator('tr[data-series="DCOILWTICO"] .lat')).toBeVisible({
      timeout: 60_000,
    });
    await settle(page, "table.grid");
    await expect(spot.locator("tr[data-pending]")).toHaveCount(0, { timeout: 60_000 });
    report.glcoFutures = await rowFacts(page, "table.grid");
    report.glcoSpot = await spot
      .locator("tbody tr[data-series]")
      .evaluateAll((trs) => trs.map((tr) => (tr as HTMLElement).innerText.replace(/\s+/g, " ")));
    await page.screenshot({ path: shotPath(ev("real-glco")) });

    await run(page, "CRYPTO");
    await expect(active(page).locator("table.grid tbody tr").first()).toContainText("BTC", {
      timeout: 60_000,
    });
    await page.waitForTimeout(3000);
    report.crypto = await active(page)
      .locator("table.grid tbody tr")
      .evaluateAll((trs) =>
        trs.slice(0, 5).map((tr) => (tr as HTMLElement).innerText.replace(/\s+/g, " ")),
      );
    await page.screenshot({ path: shotPath(ev("real-crypto")) });

    // GP 5m of a US stock: extended hours shaded on New York bars (needs real bars).
    await run(page, "AAPL US EQUITY GP 5D 5");
    await expect(active(page).locator("canvas").first()).toBeVisible({ timeout: 60_000 });
    await expect(active(page).locator(".lat").first()).toBeVisible({ timeout: 60_000 });
    await page.waitForTimeout(3000);
    report.gpTags = await active(page).locator(".lat").allInnerTexts();
    await page.screenshot({ path: shotPath(ev("real-gp-aapl-5m")) });

    await run(page, "AAPL US EQUITY Q");
    await expect(active(page).locator(".lat").first()).toBeVisible({ timeout: 60_000 });
    await page.waitForTimeout(20_000); // time & sales: prints in 20 s, if the market trades
    report.q = await active(page).locator(".panel-body").innerText();
    // Company headlines: recorded, not asserted (twice they had not arrived after 20 s).
    const t0 = Date.now();
    const loaded = async () =>
      !(await active(page).locator(".panel-body").innerText()).includes("loading…");
    while (!(await loaded()) && Date.now() - t0 < 40_000) await page.waitForTimeout(1000);
    report.headlines = { loaded: await loaded(), extraWaitMs: Date.now() - t0 };
    await page.screenshot({ path: shotPath(ev("real-q-aapl")) });

    expect(await page.locator(".lat-DEMO").count()).toBe(0);
    writeReport(ev("real-functions"), report);
  });
});
