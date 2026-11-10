/**
 * Phase 2 step 3 — market functions (SPEC §8, §14). Browser mode, DEMO backend. Calendars come
 * from exchange_calendars rules (not fixtures), so they are real in DEMO too.
 */
import { expect, test, type Page } from "@playwright/test";
import { resetSession, resetSettings, run, shotPath } from "./util";

const active = (page: Page) => page.locator(".panel.active");

test.describe("market functions (SPEC §8)", () => {
  test.beforeEach(async ({ request, page }) => {
    await resetSession(request);
    await resetSettings(request);
    await page.addInitScript(() => localStorage.setItem("ndx.tip.function-keys.v1", "shown"));
    await page.goto("/");
    await expect(page.getByTestId("demo-badge")).toBeVisible();
  });

  test("CDR: venue hours, state, holidays and clock changes", async ({ page }) => {
    await run(page, "CDR");
    const t = active(page).getByTestId("cdr");
    for (const h of ["VENUE", "STATE", "TODAY (LOCAL)", "NEXT CHANGE", "CLOCK CHANGE"]) {
      await expect(t.locator("thead")).toContainText(h);
    }
    const cph = t.locator('[data-venue="DC"]');
    await expect(cph).toContainText("Nasdaq Copenhagen");
    await expect(cph.getByTestId("venue-state")).toHaveText(/OPEN|CLOSED|HOLIDAY|BREAK/);
    await expect(t.locator('[data-venue="CME"]')).toContainText("CME Globex");
    await expect(active(page).locator(".lat").first()).toContainText("CACHE");
    await page.keyboard.press("ArrowDown");
    await expect(active(page).getByTestId("cdr-detail")).toContainText("next session");
    await page.screenshot({ path: shotPath("cdr") });
    await run(page, "CDR TOKYO");
    await expect(t.locator("tbody tr")).toHaveCount(1);
  });

  test("GP: numbered ranges, custom dates, chart types, studies menu, spec hotkeys", async ({
    page,
  }) => {
    await run(page, "AAPL US EQUITY GP");
    const gp = active(page);
    const bar = gp.getByTestId("gp-toolbar");
    await expect(bar).toContainText("MAX");
    // 7) = 1Y through the command line (N + Enter, SPEC §4.8).
    await run(page, "7");
    await expect(bar.getByRole("button", { name: "1Y", exact: true })).toHaveClass(/on/);
    // Chart focused: digit = range, T = chart type, I = studies menu, Enter toggles.
    await gp.getByTestId("gp-chart").click({ position: { x: 200, y: 120 } });
    await page.keyboard.press("2");
    await expect(bar.getByRole("button", { name: "5D", exact: true })).toHaveClass(/on/);
    await expect(bar.getByRole("button", { name: "30m", exact: true })).toHaveClass(/on/);
    await page.keyboard.press("t");
    await expect(bar.getByRole("button", { name: "OHLC", exact: true })).toHaveClass(/on/);
    await page.keyboard.press("i");
    const menu = gp.getByTestId("gp-studies");
    await expect(menu).toBeVisible();
    for (let k = 0; k < 6; k++) await page.keyboard.press("ArrowDown"); // ATR
    await page.keyboard.press("Enter");
    await expect(menu).toContainText("■ ATR");
    await page.keyboard.press("i");
    await expect(menu).toHaveCount(0);
    await expect(gp.locator(".panel-args, .panel-title").first()).toBeVisible();
    // Custom window: amber date field, Enter applies.
    const from = gp.getByTestId("gp-from");
    await from.fill("2026-01-05");
    await from.press("Enter");
    await expect(bar.getByRole("button", { name: "5D", exact: true })).not.toHaveClass(/on/);
    await expect(gp.getByTestId("gp-to")).toBeEnabled();
    await expect(gp.getByText(/^Loading|LOADING/)).toHaveCount(0, { timeout: 15_000 });
    await expect(gp.locator(".ds").first()).toContainText("DEMO");
    // DEMO has a few days of 30m bars: the chart says where history really starts.
    await expect(gp.getByTestId("gp-from-hint")).toContainText("is before the first 30m bar");
    await page.waitForTimeout(300);
    await page.screenshot({ path: shotPath("gp") });
  });

  test("GP compare: C adds overlays rebased at the window start, chips show % and source", async ({
    page,
  }) => {
    await run(page, "AAPL US EQUITY GP 1Y");
    const gp = active(page);
    await expect(gp.getByText(/^Loading|LOADING/)).toHaveCount(0, { timeout: 15_000 });
    await gp.getByTestId("gp-chart").click({ position: { x: 200, y: 120 } });
    await page.keyboard.press("c");
    const field = gp.getByTestId("gp-cmp-field");
    await expect(field).toBeFocused();
    await field.fill("msft");
    await field.press("Enter");
    await field.fill("SPX INDEX");
    await field.press("Enter");
    const chips = gp.getByTestId("gp-cmp-chip");
    await expect(chips).toHaveCount(2);
    await expect(chips.first()).toContainText(/MSFT\s*■?\s*[+−-]?\d+\.\d{2}%/, { timeout: 15_000 });
    await expect(chips.first()).toContainText("DEMO");
    await expect(gp.getByTestId("gp-compare")).toContainText("% since");
    await page.waitForTimeout(300);
    await page.screenshot({ path: shotPath("gp-compare") });
    // ✕ removes one.
    await chips.first().getByRole("button").click();
    await expect(chips).toHaveCount(1);
  });

  test("GP drawings: D menu, two-point tools, H, Backspace; persisted per security", async ({
    page,
    request,
  }) => {
    // This security's drawings start empty (user.db outlives a test).
    const r = await request.put(
      `http://127.0.0.1:${process.env.NDX_E2E_PORT}/settings/${encodeURIComponent("gp-drawings.MSFT US EQUITY")}`,
      { headers: { "x-ndx-token": process.env.NDX_E2E_TOKEN! }, data: { v: 1, items: [] } },
    );
    expect(r.ok()).toBe(true);
    await run(page, "MSFT US EQUITY GP 6M");
    const gp = active(page);
    await expect(gp.getByText(/^Loading|LOADING/)).toHaveCount(0, { timeout: 15_000 });
    const chart = gp.getByTestId("gp-chart");
    const btn = gp.getByTestId("gp-draw-btn");
    await chart.click({ position: { x: 200, y: 120 } });
    // D → menu, ↓ Enter = trend line, then two clicks.
    await page.keyboard.press("d");
    await expect(gp.getByTestId("gp-draw-menu")).toContainText("Fibonacci retracement");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    const hint = gp.getByTestId("gp-draw-hint");
    await expect(hint).toContainText("Trend line: click the first point");
    await chart.click({ position: { x: 120, y: 150 } });
    await expect(hint).toContainText("the second point");
    await chart.click({ position: { x: 330, y: 60 } });
    await expect(hint).toHaveCount(0);
    await expect(btn).toHaveText("DRAW 1");
    // Fibonacci (4th tool) from a high to a low.
    await page.keyboard.press("d");
    for (let k = 0; k < 3; k++) await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await chart.click({ position: { x: 150, y: 40 } });
    await chart.click({ position: { x: 380, y: 140 } });
    await expect(btn).toHaveText("DRAW 2");
    // H adds a horizontal line; Backspace removes the last drawing.
    await page.keyboard.press("h");
    await expect(btn).toHaveText("DRAW 3");
    await page.keyboard.press("Backspace");
    await expect(btn).toHaveText("DRAW 2");
    await page.mouse.move(300, 300);
    await page.waitForTimeout(300);
    await page.screenshot({ path: shotPath("gp-drawings") });
    // Stored with the security: a reload (and any GP of it) shows them again.
    await page.waitForTimeout(300);
    await page.reload();
    await run(page, "MSFT US EQUITY GP");
    await expect(active(page).getByTestId("gp-draw-btn")).toHaveText("DRAW 2");
  });

  test("GP events: E/D/S markers with their source; the legend names the event", async ({
    page,
  }) => {
    await run(page, "AAPL US EQUITY GP 1Y");
    const gp = active(page);
    await expect(gp.getByText(/^Loading|LOADING/)).toHaveCount(0, { timeout: 15_000 });
    for (const k of ["E", "D", "S"]) await expect(gp.getByTestId(`gp-ev-${k}`)).toHaveClass(/on/);
    await expect(gp.getByTestId("gp-ev-E")).toHaveAttribute("title", /DEMO fixtures/);
    // Sweep the cursor across the chart until the legend shows an earnings release.
    const box = (await gp.getByTestId("gp-chart").boundingBox())!;
    const legend = gp.getByTestId("gp-legend");
    let hit = -1;
    for (let x = box.x + 5; x < box.x + box.width - 70 && hit < 0; x += 2) {
      await page.mouse.move(x, box.y + 60);
      if ((await legend.textContent())?.includes("Earnings release")) hit = x;
    }
    expect(hit).toBeGreaterThan(0);
    await page.screenshot({ path: shotPath("gp-events") });
    // E off: no earnings at that bar any more.
    await gp.getByTestId("gp-ev-E").click();
    await expect(gp.getByTestId("gp-ev-E")).not.toHaveClass(/on/);
    await page.mouse.move(hit + 1, box.y + 70);
    await page.mouse.move(hit, box.y + 60);
    await expect(legend).not.toContainText("Earnings release");
  });

  test("GP template: S saves the view; a GP without arguments opens with it", async ({ page }) => {
    await run(page, "AAPL US EQUITY GP");
    const gp = active(page);
    await expect(gp.getByText(/^Loading|LOADING/)).toHaveCount(0, { timeout: 15_000 });
    await gp.getByTestId("gp-chart").click({ position: { x: 200, y: 120 } });
    await page.keyboard.press("4"); // 3M
    await page.keyboard.press("t"); // OHLC
    await page.keyboard.press("s");
    await expect(gp.getByTestId("gp-notice")).toContainText("Template saved: GP D 3M OHLC");
    // A GP already open without arguments (window 3, SPY) keeps its view.
    await expect(
      page.locator(".panel").nth(2).getByRole("button", { name: "CANDLE", exact: true }),
    ).toHaveClass(/on/);
    await run(page, "MSFT US EQUITY GP");
    const bar = active(page).getByTestId("gp-toolbar");
    await expect(bar.getByRole("button", { name: "3M", exact: true })).toHaveClass(/on/);
    await expect(bar.getByRole("button", { name: "OHLC", exact: true })).toHaveClass(/on/);
    // Arguments still win over the template.
    await run(page, "MSFT US EQUITY GP 1Y");
    await expect(bar.getByRole("button", { name: "1Y", exact: true })).toHaveClass(/on/);
    await expect(bar.getByRole("button", { name: "OHLC", exact: true })).not.toHaveClass(/on/);
  });

  test("GIP opens on the last session; HP: periodicity, window, summary, Enter → chart", async ({
    page,
  }) => {
    await run(page, "AAPL US EQUITY GIP");
    const w = active(page);
    await expect(w.locator(".panel-title")).toHaveText("Intraday chart 5m");
    await expect(
      w.getByTestId("gp-toolbar").getByRole("button", { name: "1D", exact: true }),
    ).toHaveClass(/on/);
    await expect(w.getByText(/^Loading|LOADING/)).toHaveCount(0, { timeout: 15_000 });
    await page.screenshot({ path: shotPath("gip") });

    await run(page, "AAPL US EQUITY HP");
    const hp = active(page).getByTestId("hp");
    await expect(hp.locator("thead")).toContainText("DATE");
    await expect(hp.locator("tbody tr").first()).toContainText(/\d{4}-\d{2}-\d{2}|\d/);
    expect(await hp.locator("tbody tr").count()).toBeGreaterThan(40); // ~3 months of sessions
    const sum = active(page).getByTestId("hp-summary");
    await expect(sum).toContainText(/HIGH\s+\d/);
    await expect(sum).toContainText(/AVG VOL\s+\d/);
    await expect(active(page).locator(".ds").first()).toContainText("DEMO");
    await page.screenshot({ path: shotPath("hp") });
    // 2) weekly through the command line.
    await run(page, "2");
    await expect(hp.locator("thead")).toContainText("WEEK OF");
    // Content focused: ↓ selects, Enter opens the same window as a chart.
    await hp.locator("tbody tr").first().click(); // focuses the content (Tab: amber fields first)
    await page.keyboard.press("ArrowDown");
    await expect(hp.locator("tbody tr").nth(1)).toHaveClass(/sel/);
    await page.keyboard.press("Enter");
    await expect(active(page).getByTestId("gp-toolbar")).toBeVisible();
    await expect(
      active(page).getByTestId("gp-toolbar").getByRole("button", { name: "W", exact: true }),
    ).toHaveClass(/on/);
  });

  test("Q: VWAP, volume vs 30-day average, 52W, sparkline, time & sales, headlines", async ({
    page,
  }) => {
    await run(page, "AAPL US EQUITY Q");
    const q = active(page);
    // DEMO quotes state no VWAP and DEMO 5m bars are synthetic, not the quote's session: the
    // computed VWAP falls outside the day's low–high, so Q shows N.A. and says why.
    await expect(q.getByTestId("q-vwap")).toContainText(
      /\d+\.\d{2} calc 5m|N\.A\. bars ≠ session/,
      {
        timeout: 15_000,
      },
    );
    await expect(q.getByTestId("q-volavg")).toContainText(/^\d+%/);
    await expect(q.getByTestId("q-spark").getByTestId("spark")).toBeVisible();
    await expect(q).toContainText(/52W\s*\d/);
    // DEMO has no trade feed: the tape says so instead of showing anything.
    await expect(q.getByTestId("tas-na")).toContainText("no real-time trade feed");
    await expect(q.getByTestId("q-news")).toBeVisible();
    await page.screenshot({ path: shotPath("q") });
  });

  test("WEI: % YTD, currency, sparkline, calendar state, US futures when closed", async ({
    page,
  }) => {
    await run(page, "WEI");
    const grid = active(page).locator("table.grid");
    for (const h of ["YTD%", "CCY", "INTRADAY", "TIME", "STATE"]) {
      await expect(grid.locator("thead")).toContainText(h);
    }
    for (const g of ["AMERICAS", "EMEA", "APAC"]) await expect(grid).toContainText(g);
    const omx = grid.locator('[data-row-key="^OMXC25"]');
    await expect(omx).toContainText("DKK");
    await expect(omx.getByTestId("ytd")).toHaveText(/^[+−-]?\d+\.\d{2}%$/, { timeout: 15_000 });
    await expect(omx.getByTestId("spark")).toBeVisible({ timeout: 15_000 });
    await expect(omx.locator(".lat")).toContainText("DEMO");
    // The state is the venue's calendar state; closed markets are dimmed.
    const state = await grid.locator('[data-row-key="^GSPC"]').getAttribute("data-state");
    expect(state).toMatch(/^(OPEN|CLOSED|HOLIDAY|BREAK)$/);
    for (const row of await grid.locator("tr[data-state=CLOSED], tr[data-state=HOLIDAY]").all()) {
      await expect(row).toHaveClass(/closed/);
    }
    // ES1/NQ1/YM1 exactly while the US cash market is not open.
    const futures = grid.locator('[data-row-key="ES=F"]');
    if (state === "OPEN") await expect(futures).toHaveCount(0);
    else await expect(futures).toContainText("ES1");
    await page.waitForTimeout(300);
    await page.screenshot({ path: shotPath("wei") });
    // Enter on the selected row opens its chart (Tab leaves the command line first, §4.8).
    await omx.dispatchEvent("mousedown");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Enter");
    await expect(page.locator(".panel.active .panel-fn")).toHaveText("GP");
  });

  test("MON: seed lists, add row, groups, reorder, FLDS columns, alert bell, full CSV", async ({
    page,
    request,
    context,
  }) => {
    const base = `http://127.0.0.1:${process.env.NDX_E2E_PORT}`;
    const headers = { "x-ndx-token": process.env.NDX_E2E_TOKEN! };
    const lists = (await (await request.get(`${base}/watchlists`, { headers })).json()) as {
      id: number;
      name: string;
    }[];
    for (const l of lists.filter((x) => x.name === "E2EMON"))
      await request.delete(`${base}/watchlists/${l.id}`, { headers });
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);

    await run(page, "MON");
    const tabs = active(page).getByTestId("mon-tabs");
    for (const name of ["US CORE", "DENMARK C25", "CRYPTO", "FX"]) {
      await expect(tabs.getByRole("button", { name: new RegExp(`^${name} `) })).toBeVisible();
    }
    const grid = active(page).getByTestId("mon");
    for (const h of [
      "TICKER",
      "NAME",
      "LAST",
      "CHG",
      "CHG%",
      "BID",
      "ASK",
      "VOLUME",
      "TIME",
      "TAG",
    ]) {
      await expect(grid.locator("thead")).toContainText(h);
    }
    const spy = grid.locator('tr[data-symbol="SPY US EQUITY"]');
    await expect(spy.locator(".lat-DEMO")).toBeVisible({ timeout: 15_000 });
    await tabs.getByRole("button", { name: /^DENMARK C25 25$/ }).click();
    const novo = grid.locator('tr[data-symbol="NOVOB DC EQUITY"]');
    await expect(novo.locator(".lat-DEMO")).toBeVisible({ timeout: 15_000 });
    // Closed or holiday venue → the row is dimmed, as the venue calendar says right now.
    const st = (await (
      await request.get(`${base}/calendar/state`, {
        headers,
        params: { symbols: "NOVOB DC EQUITY" },
      })
    ).json()) as { items: { state: string | null }[] };
    const closed = ["CLOSED", "HOLIDAY"].includes(st.items[0]!.state ?? "");
    await expect(novo).toHaveClass(closed ? /closed/ : /^(?!.*closed)/);
    await page.screenshot({ path: shotPath("mon-c25") });

    // A new list: the amber add row takes symbols and #groups (inserted after the selection).
    await run(page, "MON NEW E2EMON");
    await expect(tabs.getByRole("button", { name: /^E2EMON 0$/ })).toBeVisible();
    const addRow = active(page).getByTestId("mon-add");
    await addRow.fill("aapl msft");
    await addRow.press("Enter");
    await expect(grid.locator("tr[data-symbol]")).toHaveCount(2);
    await addRow.fill("#Mega caps");
    await addRow.press("Enter");
    await expect(active(page).getByTestId("mon-group")).toContainText("Mega caps 1");
    const order = () => grid.locator("tbody tr[data-symbol], tbody tr.grp").allInnerTexts();
    await expect
      .poll(async () => (await order()).map((t) => t.split(/\s/)[0]))
      .toEqual(["AAPL", "Mega", "MSFT"]);

    // Shift+↑ moves MSFT above the header (out of the group).
    await grid.locator('tr[data-symbol="MSFT US EQUITY"] td').first().click();
    await page.keyboard.press("Shift+ArrowUp");
    await expect
      .poll(async () => (await order()).map((t) => t.split(/\s/)[0]))
      .toEqual(["AAPL", "MSFT", "Mega"]);
    await expect(active(page).getByTestId("mon-group")).toContainText("Mega caps 0");

    // F: columns from FLDS, stored per list.
    await page.keyboard.press("f");
    await active(page).getByTestId("mon-cols").locator('[data-field="pe_ttm"]').click();
    await expect(grid.locator("thead")).toContainText("P/E");

    // B: an alert on the row; the bell turns amber.
    await grid.locator('tr[data-symbol="AAPL US EQUITY"] td').first().click();
    await page.keyboard.press("b");
    const field = active(page).getByTestId("mon-alert-field");
    await field.fill(">100000");
    await field.press("Enter");
    const bell = grid.locator('tr[data-symbol="AAPL US EQUITY"]').getByTestId("mon-bell");
    await expect(bell).toHaveAttribute("data-state", "armed");
    await page.screenshot({ path: shotPath("mon") });

    // CSV: the whole list, every row with its group and source.
    await active(page).getByTestId("mon-csv").click();
    await expect(page.getByText(/Copied 2 rows of E2EMON as CSV/)).toBeVisible();
    const csv = await page.evaluate(() => navigator.clipboard.readText());
    const lines = csv.split("\n");
    expect(lines[0]).toMatch(/^GROUP,TICKER,NAME,LAST,.*,P\/E,SOURCE$/);
    expect(lines[1]).toMatch(/^,AAPL US EQUITY,/);
    expect(lines).toHaveLength(3);

    const alerts = (await (await request.get(`${base}/alerts`, { headers })).json()) as {
      id: number;
      symbol: string;
    }[];
    for (const a of alerts.filter((x) => x.symbol === "AAPL US EQUITY"))
      await request.delete(`${base}/alerts/${a.id}`, { headers });
  });

  test("FXC matrix (FX alias), WFX monitor, GLCO futures + FRED spot, CRYPTO", async ({ page }) => {
    await run(page, "FXC");
    await expect(page.locator(".panel.active .panel-fn")).toHaveText("FXC");
    await expect(active(page).locator("thead")).toContainText("DKK");
    await page.keyboard.press("Enter"); // the selected cell's pair → GP
    await run(page, "WFX");
    const board = active(page).locator("table.grid");
    for (const g of ["MAJORS", "EUR CROSSES", "NORDICS", "CEE & UAH"]) {
      await expect(board).toContainText(g);
    }
    const eurdkk = board.locator('tr[data-row-key="EURDKK CURNCY"]');
    await expect(eurdkk.locator(".lat-DEMO")).toBeVisible({ timeout: 15_000 });
    await expect(board.locator('tr[data-row-key="EURUAH CURNCY"]')).toContainText("Hryvnia");
    // FXC held USDDKK under its own spelling: WFX still gets a value at once, not at the next poll.
    await expect(board.locator('tr[data-row-key="USDDKK CURNCY"] .lat-DEMO')).toBeVisible();
    await page.screenshot({ path: shotPath("wfx") });

    await run(page, "GLCO");
    const fut = active(page).locator("table.grid").first();
    for (const s of ["CL1 COMDTY", "CO1 COMDTY", "NG1 COMDTY", "GC1 COMDTY", "SI1 COMDTY"]) {
      await expect(fut.locator(`tr[data-row-key="${s}"]`)).toBeVisible();
    }
    const spot = active(page).getByTestId("glco-spot");
    await expect(spot.locator('tr[data-series="DCOILWTICO"] .lat-DEMO')).toBeVisible({
      timeout: 15_000,
    });
    await expect(spot.locator('tr[data-series="PCOPPUSDM"]')).toContainText(/\d{4}-\d{2}-\d{2}/);
    await page.screenshot({ path: shotPath("glco") });

    await run(page, "CRYPTO");
    const cr = active(page).locator("table.grid");
    await expect(cr.locator("tbody tr").first()).toContainText("BTC", { timeout: 15_000 });
    await expect(cr.locator("thead")).toContainText("MCAP (USD)");
    await page.screenshot({ path: shotPath("crypto") });
  });
});
