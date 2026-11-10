import { afterEach, describe, expect, it } from "vitest";
import {
  fmtCountdown,
  MINUS,
  directionMark,
  NA,
  fmtBig,
  fmtBigSigned,
  fmtChange,
  fmtDate,
  fmtHM,
  fmtNum,
  fmtPct,
  fmtPrice,
  fmtSigned,
  fmtTime,
  fmtVenueTime,
  chartNumberFormat,
  chartPriceFormat,
  chartSpreadFormat,
  chartTimeFormat,
  fmtYield,
  priceClassOf,
  priceDigits,
  relTime,
  setNumberFormat,
  signClass,
  toAscii,
  unwallClock,
} from "./format";

const m = (s: string) => s.replaceAll("-", MINUS); // write expectations with ASCII minus

describe("missing values (SPEC §1.2)", () => {
  it("render N.A., never 0 or blank", () => {
    for (const f of [fmtNum, fmtSigned, fmtPrice, fmtChange, fmtPct, fmtBig, fmtYield]) {
      expect(f(null)).toBe(NA);
      expect(f(undefined)).toBe(NA);
      expect(f(NaN)).toBe(NA);
      expect(f(Infinity)).toBe(NA);
    }
    expect(fmtTime(null)).toBe(NA);
    expect(fmtTime("garbage")).toBe(NA);
    expect(fmtDate(undefined)).toBe(NA);
    expect(fmtHM("")).toBe(NA);
    expect(relTime(null)).toBe(NA);
    expect(NA).toBe("N.A.");
  });
  it("zero is a value, not missing", () => {
    expect(fmtNum(0)).toBe("0.00");
    expect(fmtPrice(0)).toBe("0.00");
  });
});

describe("signs (SPEC §4.2)", () => {
  it("uses U+2212 for negatives and + for positive changes", () => {
    expect(fmtSigned(1.234)).toBe("+1.23");
    expect(fmtSigned(-0.45)).toBe(m("-0.45"));
    expect(fmtPct(1.234)).toBe("+1.23%");
    expect(fmtPct(-0.456)).toBe(m("-0.46%"));
    expect(fmtNum(-1234.5)).toBe(m("-1,234.50"));
    expect(fmtNum(-1)).not.toContain("-"); // never ASCII hyphen on screen
  });
  it("never shows a sign on values that round to zero", () => {
    expect(fmtSigned(-0.001)).toBe("0.00");
    expect(fmtSigned(0.004)).toBe("0.00");
    expect(fmtPct(-0.0001)).toBe("0.00%");
    expect(fmtNum(-0.0001)).toBe("0.00");
  });
  it("unsigned percent keeps the minus for negatives", () => {
    expect(fmtPct(2.5, 2, false)).toBe("2.50%");
    expect(fmtPct(-2.5, 2, false)).toBe(m("-2.50%"));
  });
  it("copy/export gets ASCII minus", () => {
    expect(toAscii(`${MINUS}1.23 ${MINUS}0.45%`)).toBe("-1.23 -0.45%");
  });
  it("signClass gives direction (colour is never the only cue: the sign is in the text)", () => {
    expect(signClass(1)).toBe("up");
    expect(signClass(-1)).toBe("down");
    expect(signClass(0)).toBe("");
    expect(signClass(null)).toBe("");
  });
});

describe("thousands and decimal separators", () => {
  afterEach(() => setNumberFormat({ group: ",", decimal: "." }));
  it("default , and .", () => {
    expect(fmtNum(1234567.891)).toBe("1,234,567.89");
    expect(fmtNum(999.999)).toBe("1,000.00");
    expect(fmtNum(12, 0)).toBe("12");
  });
  it("is configurable", () => {
    setNumberFormat({ group: ".", decimal: "," });
    expect(fmtNum(1234567.891)).toBe("1.234.567,89");
    expect(fmtPrice(-0.5)).toBe(m("-0,5000"));
  });
});

describe("precision by class (SPEC §4.2)", () => {
  it("equities, ETFs, indices: 2 dp, 4 dp below 1.00", () => {
    expect(fmtPrice(231.4, "AAPL")).toBe("231.40");
    expect(fmtPrice(6712.45, "^GSPC")).toBe("6,712.45");
    expect(fmtPrice(0.8123, "equity")).toBe("0.8123");
    expect(fmtPrice(671.2, "etf")).toBe("671.20");
    expect(fmtPrice(0.5)).toBe("0.5000"); // default = equity rules
  });
  it("FX: 4 dp, JPY pairs 2 dp", () => {
    expect(fmtPrice(1.16421, "EURUSD")).toBe("1.1642");
    expect(fmtPrice(6.41, "USDDKK")).toBe("6.4100");
    expect(fmtPrice(151.234, "USDJPY")).toBe("151.23");
    expect(fmtPrice(162.5, "EURJPY=X")).toBe("162.50");
    expect(fmtPrice(1.1, "fx")).toBe("1.1000");
  });
  it("crypto: 2 dp ≥ 1,000; 2–4 dp between 1 and 1,000; 6 significant digits below 1", () => {
    expect(fmtPrice(104250, "BTCUSDT")).toBe("104,250.00");
    expect(fmtPrice(3812.5, "ETHUSDT")).toBe("3,812.50");
    expect(fmtPrice(123.4, "SOLUSDT")).toBe("123.40");
    expect(fmtPrice(123.4567, "SOLUSDT")).toBe("123.4567");
    expect(fmtPrice(1.5, "crypto")).toBe("1.50");
    expect(fmtPrice(0.123456789, "DOGEUSDT")).toBe("0.123457");
    expect(fmtPrice(0.0001234567, "PEPEUSDT")).toBe("0.000123457");
  });
  it("yields 3 dp", () => {
    expect(fmtPrice(4.12345, "yield")).toBe("4.123");
    expect(fmtYield(4.12345)).toBe("4.123");
    expect(fmtYield(-0.25)).toBe(m("-0.250"));
  });
  it("futures by tick size, default 2 dp", () => {
    expect(fmtPrice(71.234, "CL=F")).toBe("71.23");
    expect(fmtPrice(4321.25, { cls: "future", tick: 0.25 })).toBe("4,321.25");
    expect(fmtPrice(1.08765, { cls: "future", tick: 0.00005 })).toBe("1.08765");
    expect(fmtPrice(110.5, { cls: "future", tick: 1 })).toBe("111");
    // From the contract table, by canonical ID or provider symbol.
    expect(fmtPrice(3.452, "NG1 COMDTY")).toBe("3.452");
    expect(fmtPrice(4.1235, "HG1 COMDTY")).toBe("4.1235");
    expect(fmtPrice(4.1235, "HG=F")).toBe("4.1235");
    expect(fmtPrice(5321.25, "ES1 INDEX")).toBe("5,321.25");
    expect(fmtPrice(42000, "YM1 INDEX")).toBe("42,000");
  });
  it("percentages 2 dp", () => {
    expect(fmtPct(12.3456)).toBe("+12.35%");
  });
  it("priceDigits is the single source", () => {
    expect(priceDigits(0.5, "index")).toBe(4);
    expect(priceDigits(2, "crypto")).toBe(4);
    expect(priceDigits(2000, "crypto")).toBe(2);
  });
  it("classifies symbols like the server", () => {
    expect(priceClassOf("^OMXC25").cls).toBe("index");
    expect(priceClassOf("EUR/USD")).toEqual({ cls: "fx", jpy: false });
    expect(priceClassOf("JPY=X").cls).toBe("equity"); // provider form, not canonical
    expect(priceClassOf("BTCUSDT").cls).toBe("crypto");
    expect(priceClassOf("NOVO-B.CO").cls).toBe("equity");
    expect(priceClassOf("CL=F").cls).toBe("future");
    expect(priceClassOf("USDUSD").cls).toBe("equity");
    // canonical IDs (SPEC §5)
    expect(priceClassOf("AAPL US EQUITY").cls).toBe("equity");
    expect(priceClassOf("SPX INDEX").cls).toBe("index");
    expect(priceClassOf("ES1 INDEX").cls).toBe("future");
    expect(priceClassOf("CL1 COMDTY").cls).toBe("future");
    expect(priceClassOf("US10Y GOVT").cls).toBe("yield");
    expect(priceClassOf("USDJPY CURNCY")).toEqual({ cls: "fx", jpy: true });
    expect(priceClassOf("BTCUSD CURNCY").cls).toBe("crypto");
    expect(fmtPrice(1.16421, "EURUSD CURNCY")).toBe("1.1642");
  });
});

describe("changes follow the price level, not the change size", () => {
  it("index change −0.87 stays 2 dp (was −0.87000)", () => {
    expect(fmtChange(-0.87, "^DJI", 461.5)).toBe(m("-0.87"));
    expect(fmtChange(-0.87, "^DJI")).toBe(m("-0.87"));
    expect(fmtChange(24.35, "^GSPC", 6712.45)).toBe("+24.35");
  });
  it("FX change keeps FX precision, crypto follows the price level", () => {
    expect(fmtChange(0.0024, "EURUSD", 1.1642)).toBe("+0.0024");
    expect(fmtChange(-0.15, "USDJPY", 151.2)).toBe(m("-0.15"));
    expect(fmtChange(1270, "BTCUSDT", 104250)).toBe("+1,270.00");
    expect(fmtChange(-0.000012, "PEPEUSDT", 0.0001234)).toBe(m("-0.000012000")); // same 9 dp as the price;
  });
  it("sub-dollar equity: 4 dp from the level", () => {
    expect(fmtChange(0.0123, "equity", 0.81)).toBe("+0.0123");
  });
});

describe("large numbers K/M/B/T with 2 dp", () => {
  it("formats", () => {
    expect(fmtBig(2.95e12)).toBe("2.95T");
    expect(fmtBig(12_345_678)).toBe("12.35M");
    expect(fmtBig(48_210_000)).toBe("48.21M");
    expect(fmtBig(1500)).toBe("1.50K");
    expect(fmtBig(-1.2e9)).toBe(m("-1.20B"));
    expect(fmtBig(950)).toBe("950");
    expect(fmtBig(0)).toBe("0");
  });
  it("promotes at unit boundaries after rounding", () => {
    expect(fmtBig(999_999)).toBe("1.00M");
    expect(fmtBig(999_994)).toBe("999.99K");
    expect(fmtBig(1.2e15)).toBe("1,200.00T");
  });
});

describe("dates and times (SPEC §4.2)", () => {
  const iso = "2026-11-09T14:30:05Z";
  it("dates are YYYY-MM-DD in the user zone (default Europe/Copenhagen)", () => {
    expect(fmtDate(iso)).toBe("2026-11-09");
    expect(fmtDate("2026-11-09T23:30:00Z")).toBe("2026-11-10"); // CET = UTC+1
    expect(fmtDate("2026-11-09T23:30:00Z", "America/New_York")).toBe("2026-11-09");
    expect(fmtDate("2024-03-31")).toBe("2024-03-31"); // date-only strings never shift
  });
  it("grids pass the exchange zone; default is the user zone", () => {
    expect(fmtTime(iso)).toBe("15:30:05");
    expect(fmtTime(iso, false, "America/New_York")).toBe("09:30:05");
    expect(fmtTime(iso, false, "Asia/Tokyo")).toBe("23:30:05");
    expect(fmtTime(iso, false, "UTC")).toBe("14:30:05");
    expect(fmtTime("2026-07-01T12:00:00Z")).toBe("14:00:00"); // CEST
  });
  it("withDate adds YYYY-MM-DD for other days", () => {
    const now = Date.parse("2026-11-09T14:31:00Z");
    expect(fmtTime(iso, true, "Europe/Copenhagen", now)).toBe("15:30:05");
    expect(fmtTime("2026-11-05T09:00:00Z", true, "Europe/Copenhagen", now)).toBe(
      "2026-11-05 10:00",
    );
  });
  it("24-hour HH:MM", () => {
    expect(fmtHM("2026-11-09T00:05:00Z", "UTC")).toBe("00:05");
    expect(fmtHM("2026-11-09T23:59:00Z", "UTC")).toBe("23:59");
  });
  it("relative age", () => {
    const now = Date.parse(iso);
    expect(relTime("2026-11-09T14:29:55Z", now)).toBe("10s");
    expect(relTime("2026-11-09T14:25:05Z", now)).toBe("5m");
    expect(relTime("2026-11-09T11:30:05Z", now)).toBe("3h");
    expect(relTime("2026-11-07T14:30:05Z", now)).toBe("2d");
  });
});

describe("fmtVenueTime: grids show exchange-local time (§4.2, review 1a #9/#13)", () => {
  const ts = "2026-11-09T14:30:05Z";
  const now = Date.parse("2026-11-09T14:31:00Z");
  it.each([
    ["AAPL US EQUITY", "09:30:05"],
    ["NOVOB DC EQUITY", "15:30:05"],
    ["SPX INDEX", "09:30:05"],
    ["^N225", "23:30:05"],
    ["UKX INDEX", "14:30:05"],
    ["IBOV INDEX", "11:30:05"],
    ["CL1 COMDTY", "09:30:05"],
    ["ES1 INDEX", "08:30:05"],
  ])("%s → %s", (symbol, want) => {
    expect(fmtVenueTime(ts, symbol, now)).toBe(want);
  });
  it("FX, crypto and unknown symbols use the user zone", () => {
    expect(fmtVenueTime(ts, "EURUSD CURNCY", now)).toBe("15:30:05");
    expect(fmtVenueTime(ts, "BTCUSDT", now)).toBe("15:30:05");
  });
  it("a quote from another day shows the date", () => {
    expect(fmtVenueTime("2026-11-06T20:59:00Z", "AAPL US EQUITY", now)).toBe("2026-11-06 15:59");
  });
  it("missing time is N.A.", () => {
    expect(fmtVenueTime(null, "AAPL US EQUITY", now)).toBe("N.A.");
  });
});

describe("chartTimeFormat: chart time axis and crosshair (re-verify #10)", () => {
  const real = Date.parse("2026-11-09T14:30:00Z") / 1000; // US cash open
  const nyWall = real - 5 * 3600; // what the server's wall_clock() sends for an NYSE bar
  it("a wall-clock bar goes back to the real instant, also across DST", () => {
    expect(unwallClock(nyWall, "America/New_York")).toBe(real);
    const july = Date.parse("2026-07-01T13:30:00Z") / 1000;
    expect(unwallClock(july - 4 * 3600, "America/New_York")).toBe(july);
    expect(unwallClock(real, "UTC")).toBe(real);
  });
  // Labels read chart times, i.e. what `toChart` gives the library.
  const tick = (f: ReturnType<typeof chartTimeFormat>, t: number, type = 3) =>
    f.tickMarkFormatter(f.toChart(t), type);
  it("intraday reads exchange-local for a listed security, named in the crosshair", () => {
    const f = chartTimeFormat("AAPL US EQUITY", true, "America/New_York");
    expect(f.zone).toBe("America/New_York");
    expect(tick(f, nyWall)).toBe("09:30");
    expect(f.timeFormatter(f.toChart(nyWall))).toBe("2026-11-09 09:30 EST");
    // DEMO sends real UTC: same label.
    expect(tick(chartTimeFormat("AAPL US EQUITY", true, "UTC"), real)).toBe("09:30");
    expect(tick(chartTimeFormat("^N225", true), real)).toBe("23:30");
  });
  it("FX and crypto read in the user zone, like the grids", () => {
    expect(tick(chartTimeFormat("BTCUSDT", true), real)).toBe("15:30");
    const fx = chartTimeFormat("EURUSD CURNCY", true, "Europe/London");
    expect(tick(fx, real)).toBe("15:30");
    expect(fx.timeFormatter(fx.toChart(real))).toMatch(/^2026-11-09 15:30 GMT\+1$/);
  });
  it("day ticks sit on the display zone's midnight and carry its date (re-verify N7)", () => {
    // DEMO AAPL 5m: real-UTC bars shown in New York. The library puts day ticks where the
    // chart time's UTC date changes, so that must be New York midnight, labelled 11-09.
    const f = chartTimeFormat("AAPL US EQUITY", true, "UTC");
    const nyMidnight = Date.parse("2026-11-09T05:00:00Z") / 1000;
    const utcMidnight = Date.parse("2026-11-09T00:00:00Z") / 1000;
    expect(f.toChart(nyMidnight) % 86400).toBe(0);
    expect(tick(f, nyMidnight, 2)).toBe("11-09");
    expect(f.toChart(utcMidnight) % 86400).not.toBe(0); // 19:00 NY is no day boundary
    expect(tick(f, utcMidnight)).toBe("19:00");
  });
  it("chart times stay strictly ascending across DST changes (re-verify DST)", () => {
    // Binance 24/7 bars (real UTC) shown in the user zone, Europe/Copenhagen in tests.
    const ascending = (xs: number[]) => xs.every((x, i) => i === 0 || x > xs[i - 1]!);
    for (const [from, label] of [
      ["2026-10-24T22:00:00Z", "fall-back"],
      ["2026-03-28T23:00:00Z", "spring-forward"],
    ] as const) {
      const f = chartTimeFormat("BTCUSDT", true, "UTC");
      const t0 = Date.parse(from) / 1000;
      const bars = Array.from({ length: 4 * 60 }, (_, i) => t0 + i * 60); // 1m bars, 4 h
      // GP maps the same bar times once per series: candles, volume, each line, MACD.
      const passes = [0, 1, 2, 3].map(() => bars.map(f.toChart));
      for (const p of passes) expect(ascending(p), label).toBe(true);
      expect(new Set(passes.map((p) => p.join())).size, label).toBe(1);
      // A live bar after the history and an update of the last bar.
      const next = bars[bars.length - 1]! + 60;
      expect(f.toChart(next)).toBeGreaterThan(passes[0]![passes[0]!.length - 1]!);
      expect(f.toChart(next)).toBe(f.toChart(next));
    }
    // The crosshair still names each bar's true wall time and offset in the repeated hour.
    const f = chartTimeFormat("BTCUSDT", true, "UTC");
    const first = Date.parse("2026-10-25T00:30:00Z") / 1000;
    const second = Date.parse("2026-10-25T01:30:00Z") / 1000;
    const c1 = f.toChart(first);
    const c2 = f.toChart(second);
    expect(c2).toBeGreaterThan(c1);
    expect(f.timeFormatter(c1)).toBe("2026-10-25 02:30 GMT+2");
    expect(f.timeFormatter(c2)).toBe("2026-10-25 02:30 GMT+1");
    expect(f.tickMarkFormatter(c2, 3)).toBe("02:30");
  });
  it("daily bars are dates that never shift a day; ticks name year, month, day", () => {
    const day = Date.parse("2026-11-09T00:00:00Z") / 1000;
    const f = chartTimeFormat("AAPL US EQUITY", false, "America/New_York");
    expect(f.timeFormatter(day)).toBe("2026-11-09");
    expect(f.tickMarkFormatter(day, 0)).toBe("2026");
    expect(f.tickMarkFormatter(day, 1)).toBe("2026-11");
    expect(f.tickMarkFormatter(day, 2)).toBe("11-09");
    expect(f.timeFormatter("2026-11-09")).toBe("N.A.");
  });
  it("oscillator panes use the shared number formatter, not the library's default", () => {
    const f = chartNumberFormat(2);
    expect(f.formatter(70)).toBe("70.00");
    expect(f.formatter(-1.5)).toBe(m("-1.50"));
    // MACD on FX: a 0.0004 histogram is not 0.00.
    expect(chartSpreadFormat("EURUSD CURNCY", 1.1642).formatter(0.0004)).toBe("0.0004");
  });
  it("MACD keeps one precision across its scale (re-verify N8)", () => {
    const eq = chartSpreadFormat("AAPL US EQUITY", 230);
    expect([1.5, 0.5, 0, -0.25].map(eq.formatter)).toEqual(["1.50", "0.50", "0.00", m("-0.25")]);
    const btc = chartSpreadFormat("BTCUSDT", 90000);
    expect([250, 0.5, -20].map(btc.formatter)).toEqual(["250.00", "0.50", m("-20.00")]);
  });
});

describe("chartPriceFormat: charts render through fmtPrice (review 1a #10)", () => {
  it("FX axis labels keep 4 dp", () => {
    const f = chartPriceFormat("EURUSD CURNCY", 1.1642);
    expect(f.formatter(1.1642)).toBe("1.1642");
    expect(f.minMove).toBeCloseTo(0.0001);
  });
  it("tiny crypto prices never read 0.00", () => {
    const f = chartPriceFormat("PEPEUSDT", 0.0000123);
    expect(f.formatter(0.0000123)).not.toBe("0.00");
    expect(f.minMove).toBeLessThan(0.000001);
  });
  it("negative spreads carry U+2212", () => {
    expect(chartPriceFormat("SPX INDEX", 6000).formatter(-1.5)).toBe("−1.50");
  });
});

describe("signClass never colours a value shown without a sign (review 1a #31)", () => {
  it.each([
    [-0.004, fmtPct(-0.004), ""],
    [0.003, fmtChange(0.003, "AAPL US EQUITY", 200), ""],
    [-0.5, fmtPct(-0.5), "down"],
    [0.5, fmtPct(0.5), "up"],
    [0.0004, fmtChange(0.0004, "EURUSD CURNCY", 1.16), "up"],
  ])("%s shown as %s → %j", (v, shown, cls) => {
    expect(signClass(v, shown)).toBe(cls);
  });
});

it("an FX leg named by pair keeps JPY at 2 dp (review 1a #34)", () => {
  expect(fmtPrice(151.234, "USDJPY")).toBe("151.23");
  expect(fmtPrice(0.9123, "USDCHF")).toBe("0.9123");
});

describe("P&L keeps its colour (re-verify R4)", () => {
  it.each([
    [1234, "+1.23K", "up"],
    [500, "+500", "up"],
    [-1234, "−1.23K", "down"],
    [0.2, "0", ""],
  ])("%s → %s %j", (v, text, cls) => {
    expect(fmtBigSigned(v)).toBe(text);
    expect(signClass(v, fmtBigSigned(v))).toBe(cls);
  });
});

describe("direction mark (FX matrix cells, #31: colour is never the only cue)", () => {
  it("▲ up, ▼ down, nothing when flat or unknown", () => {
    expect(directionMark(0.12)).toBe("▲");
    expect(directionMark(-0.01)).toBe("▼");
    expect(directionMark(0)).toBe("");
    expect(directionMark(null)).toBe("");
    expect(directionMark(Number.NaN)).toBe("");
  });
});

describe("fmtCountdown", () => {
  it("days+hours, hours+minutes, minutes+seconds, seconds; 0s once passed", () => {
    expect(fmtCountdown((2 * 86400 + 3 * 3600 + 59) * 1000)).toBe("2d 3h");
    expect(fmtCountdown((3600 + 5 * 60 + 9) * 1000)).toBe("1h 05m");
    expect(fmtCountdown((4 * 60 + 7) * 1000 + 999)).toBe("4m 07s");
    expect(fmtCountdown(42_000)).toBe("42s");
    expect(fmtCountdown(-5_000)).toBe("0s");
    expect(fmtCountdown(Number.NaN)).toBe("N.A.");
  });
});
