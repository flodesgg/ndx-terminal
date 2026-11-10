import { describe, expect, it } from "vitest";
import { tokenizeInline } from "./markdown";

describe("markdown inline tokens", () => {
  it("parses code, bold, italic and links", () => {
    expect(tokenizeInline("a `x` **b** *c* [d](https://e.com) f")).toEqual([
      { t: "text", v: "a " },
      { t: "code", v: "x" },
      { t: "text", v: " " },
      { t: "b", v: "b" },
      { t: "text", v: " " },
      { t: "i", v: "c" },
      { t: "text", v: " " },
      { t: "a", v: "d", href: "https://e.com" },
      { t: "text", v: " f" },
    ]);
  });
  it("never treats javascript: links as links", () => {
    const toks = tokenizeInline("[x](javascript:alert(1))");
    expect(toks.every((t) => t.t === "text")).toBe(true);
  });
  it("keeps plain text and stray markup", () => {
    expect(tokenizeInline("P/E < 20 * guess")).toEqual([{ t: "text", v: "P/E < 20 * guess" }]);
  });
});
