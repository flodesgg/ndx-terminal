import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { parseInContext } from "./executor";
import { DEFAULT_PDF, parsePdf, pdfArgs, usePdf, yfMode } from "./pdf";
import { buildIndex, EMPTY_INDEX, setSecIndex } from "./secindex";
import { token, setColorScheme } from "@/theme/tokens";

beforeAll(async () => {
  window.matchMedia ??= (() => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  })) as unknown as typeof window.matchMedia;
  const { registerAllFunctions } = await import("@/functions");
  registerAllFunctions();
});

afterEach(() => {
  usePdf.setState({ pdf: DEFAULT_PDF });
  setSecIndex(EMPTY_INDEX);
  setColorScheme("STANDARD");
});

describe("PDF personal defaults (SPEC §7, §4.3 rule 6, §6.2)", () => {
  it("defaults: default exchange DC (my choice), standard colours", () => {
    expect(DEFAULT_PDF).toEqual({ defaultExchange: "DC", colors: "STANDARD" });
  });

  it("stored values are validated; anything unknown falls back to the default", () => {
    expect(parsePdf({ defaultExchange: "GY", colors: "COLORBLIND" })).toEqual({
      defaultExchange: "GY",
      colors: "COLORBLIND",
    });
    expect(parsePdf({ defaultExchange: "NOPE", colors: "PINK" })).toEqual(DEFAULT_PDF);
    expect(parsePdf(null)).toEqual(DEFAULT_PDF);
    expect(parsePdf("x")).toEqual(DEFAULT_PDF);
  });

  it("the default exchange feeds parser rule 6 (a bare non-US ticker)", () => {
    setSecIndex(
      buildIndex({
        complete: ["US"],
        fiat: [],
        items: [
          ["XYZ GY EQUITY", "Xyz AG"],
          ["XYZ DC EQUITY", "Xyz A/S"],
        ],
      }),
    );
    expect(parseInContext("XYZ GP")).toMatchObject({ fn: "GP", security: "XYZ DC EQUITY" });
    usePdf.setState({ pdf: { ...DEFAULT_PDF, defaultExchange: "GY" } });
    expect(parseInContext("XYZ GP")).toMatchObject({ fn: "GP", security: "XYZ GY EQUITY" });
  });

  it("PDF COLORS: the colour-blind palette swaps the up/down tokens", () => {
    expect(token("up")).toBe(token("up"));
    const up = token("up");
    setColorScheme("COLORBLIND");
    expect(token("up")).toBe(token("cb-up"));
    expect(token("down")).toBe(token("cb-down"));
    setColorScheme("STANDARD");
    expect(token("up")).toBe(up);
  });

  it("PDF COLORS: the colour-blind palette marks the document so links are underlined (§4.2)", () => {
    setColorScheme("COLORBLIND");
    expect(document.documentElement.dataset.colors).toBe("COLORBLIND");
    setColorScheme("STANDARD");
    expect(document.documentElement.dataset.colors).toBe("STANDARD");
  });

  it("PDF args: a section (COLORS) or a setting with its value", () => {
    expect(pdfArgs([])).toEqual({ section: "ALL" });
    expect(pdfArgs(["COLORS"])).toEqual({ section: "COLORS" });
    expect(pdfArgs(["COLORS", "COLORBLIND"])).toEqual({ set: { colors: "COLORBLIND" } });
    expect(pdfArgs(["EXCH", "GY"])).toEqual({ set: { defaultExchange: "GY" } });
    expect(pdfArgs(["EXCH", "ZZ"])).toEqual({ error: expect.stringMatching(/ZZ/) });
    expect(pdfArgs(["YFINANCE", "ON"])).toEqual({
      optIn: { yfinance: true, yfinance_scope: "all" },
    });
    expect(pdfArgs(["YFINANCE", "dk"])).toEqual({
      optIn: { yfinance: true, yfinance_scope: "dk_indices" },
    });
    expect(pdfArgs(["YFINANCE", "OFF"])).toEqual({
      optIn: { yfinance: false, yfinance_scope: "all" },
    });
    expect(yfMode({ yfinance: true, yfinance_scope: "dk_indices" })).toBe("DK");
    expect(yfMode({ yfinance: false, yfinance_scope: "dk_indices" })).toBe("OFF");
    expect(yfMode(undefined)).toBe("OFF");
  });
});
