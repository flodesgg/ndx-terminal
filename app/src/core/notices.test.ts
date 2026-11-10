import { describe, expect, it } from "vitest";
import { NOTICES, noticeFor } from "./notices";

describe("HELP → Data sources notices (SPEC §1.7, PROVIDERS.md §4)", () => {
  it("FRED: the exact not-endorsed notice from the API terms", () => {
    expect(noticeFor("FRED")?.text).toContain(
      "This product uses the FRED® API but is not endorsed or certified by the Federal Reserve Bank of St. Louis.",
    );
  });

  it("Tiingo: credited as the source of RT·REF values", () => {
    const n = noticeFor("Tiingo")!;
    expect(n.text).toContain("RT·REF");
    expect(n.text).toMatch(/Tiingo/);
  });

  it("Wikipedia: CC BY-SA 4.0, revision link, converted to CSV", () => {
    const n = noticeFor("Wikipedia")!;
    expect(n.text).toContain("CC BY-SA 4.0");
    expect(n.text).toMatch(/revision/);
    expect(n.text).toMatch(/converted to CSV/);
    expect(n.links.map((l) => l.url)).toContain("https://creativecommons.org/licenses/by-sa/4.0/");
  });

  it("yfinance: unofficial, enabled by you, personal use, Yahoo's no-redistribution note", () => {
    const n = noticeFor("yfinance")!;
    expect(n.text).toContain("Unofficial source, enabled by you, personal use");
    expect(n.text).toMatch(/must not be redistributed/);
    expect(n.optIn).toBe("yfinance");
  });

  it("every other §4 notice is listed, each with a link", () => {
    for (const name of [
      "CoinGecko",
      "GDELT",
      "BEA",
      "Federal Reserve",
      "ECB",
      "SEC EDGAR",
      "U.S. Treasury",
      "lightweight-charts",
    ]) {
      expect(noticeFor(name), name).toBeDefined();
    }
    expect(noticeFor("CoinGecko")!.text).toContain("Powered by CoinGecko");
    // BLS is not called (it refuses clients without contact details); its dates come via FRED.
    expect(noticeFor("BLS")).toBeUndefined();
    expect(noticeFor("Federal Reserve")!.text).toMatch(/from FRED/);
    for (const n of NOTICES) expect(n.links.length, n.source).toBeGreaterThan(0);
  });

  it("never names the reference terminal (SPEC §1.1)", () => {
    expect(JSON.stringify(NOTICES)).not.toMatch(/bloomberg/i);
  });
});
