import { describe, expect, it } from "vitest";
import { parseGpArgs } from "./args";
import { parseTemplate, templateArgs } from "./template";

describe("GP template (S)", () => {
  it("keeps the view, drops the window, overlays and lines of one security", () => {
    const st = parseGpArgs(["1H", "5D", "RSI", "LOG", "LINE", "CMP=MSFT", "HL=100", "EV=E"]);
    expect(templateArgs(st)).toEqual(["60", "5D", "LINE", "RSI", "LOG", "EV=E"]);
    const custom = parseGpArgs(["D", "FROM=2025-01-02", "TO=2025-06-30"]);
    expect(templateArgs(custom)).toEqual(["D"]);
  });

  it("a stored value is re-validated; anything else is no template", () => {
    expect(parseTemplate({ args: ["W", "MACD", "BOGUS"] })).toEqual(["W", "MACD"]);
    expect(parseTemplate({ args: [1, 2] })).toEqual([]);
    expect(parseTemplate(null)).toEqual([]);
  });
});
