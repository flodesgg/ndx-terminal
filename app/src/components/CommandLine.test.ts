import { describe, expect, it } from "vitest";
import { composeCommand, pickerRows } from "./CommandLine";

describe("command line chips (SPEC §4.4)", () => {
  it("a sector chip goes after the typed ticker, or stands alone as the sector menu", () => {
    expect(composeCommand([{ kind: "sector", text: "CURNCY" }], "eurusd gp")).toBe(
      "eurusd CURNCY gp",
    );
    // TICKER EXCH FUNCTION keeps working with a sector chip (§4.4 "typed tokens always work").
    expect(composeCommand([{ kind: "sector", text: "EQUITY" }], "aapl us des")).toBe(
      "aapl us EQUITY des",
    );
    expect(composeCommand([{ kind: "sector", text: "CURNCY" }], "")).toBe("CURNCY");
    // …also when the exchange was typed on a Cyrillic layout (review 1a #17).
    expect(composeCommand([{ kind: "sector", text: "EQUITY" }], "ффзд гы вуы")).toBe(
      "ффзд гы EQUITY вуы",
    );
  });

  it("security and function chips come first, typed args after", () => {
    expect(
      composeCommand(
        [
          { kind: "security", text: "NOVOB DC EQUITY" },
          { kind: "function", text: "GP" },
        ],
        "1y ",
      ),
    ).toBe("NOVOB DC EQUITY GP 1y");
    // Once a security is chosen, the sector chip that filtered it is redundant.
    expect(
      composeCommand(
        [
          { kind: "sector", text: "EQUITY" },
          { kind: "security", text: "AAPL US EQUITY" },
        ],
        "des",
      ),
    ).toBe("AAPL US EQUITY des");
  });

  it("typed text keeps its case: search and the Cyrillic layout fix need the original", () => {
    expect(composeCommand([], "  новости   нефть ")).toBe("новости нефть");
    expect(composeCommand([], "тщмщ-июсщ пз")).toBe("тщмщ-июсщ пз");
  });
});

describe("picker after an ambiguous or unknown security (§4.3 rule 6)", () => {
  it("each candidate keeps the rest of the command", () => {
    const rows = pickerRows("xyz gp 1y", ["XYZ GY EQUITY", "XYZ LN EQUITY"]);
    expect(rows.map((r) => r.insert)).toEqual(["XYZ GY EQUITY GP 1Y", "XYZ LN EQUITY GP 1Y"]);
    expect(rows.every((r) => r.kind === "SECURITY")).toBe(true);
    expect(pickerRows("ZZZZ US EQUITY DES", ["ZZZ US EQUITY"])[0]!.insert).toBe(
      "ZZZ US EQUITY DES",
    );
    expect(pickerRows("ZZZZ US DES", ["ZZZ US EQUITY"])[0]!.insert).toBe("ZZZ US EQUITY DES");
    expect(pickerRows("EURXXX CURNCY Q", ["EURUSD CURNCY"])[0]!.insert).toBe("EURUSD CURNCY Q");
  });
});
