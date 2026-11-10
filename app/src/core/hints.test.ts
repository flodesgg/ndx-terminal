import { describe, expect, it, vi } from "vitest";
import { hintLabels } from "./hints";

describe("hint mode labels (SPEC §4.8: 1–2 letters)", () => {
  it("one letter while they last, home row first", () => {
    expect(hintLabels(4)).toEqual(["A", "S", "D", "F"]);
  });

  it("two letters when there are more targets; no label is a prefix of another", () => {
    for (const n of [27, 60, 300]) {
      const ls = hintLabels(n);
      expect(ls).toHaveLength(n);
      expect(new Set(ls).size).toBe(n);
      for (const a of ls) {
        expect(a.length).toBeLessThanOrEqual(2);
        expect(
          ls.some((b) => b !== a && b.startsWith(a)),
          a,
        ).toBe(false);
      }
    }
  });
});

describe("hint mode keys", () => {
  it("typing a label activates its element, by physical key (Cyrillic layouts too)", async () => {
    const { startHints, hintKey, useHints } = await import("./hints");
    const rect = { left: 1, top: 1, right: 11, bottom: 11, width: 10, height: 10 } as DOMRect;
    const spy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(rect);
    document.body.innerHTML = "<button id=a>A</button><button id=b>B</button>";
    const clicked: string[] = [];
    document
      .querySelectorAll("button")
      .forEach((b) => b.addEventListener("click", () => clicked.push(b.id)));
    expect(startHints()).toBe(2);
    expect(hintKey({ code: "KeyS", key: "ы" })).toBe(true); // Russian – PC: S key
    expect(clicked).toEqual(["b"]);
    expect(useHints.getState().targets).toBeNull();
    startHints();
    hintKey({ code: "Escape", key: "Escape" });
    expect(useHints.getState().targets).toBeNull();
    expect(clicked).toEqual(["b"]);
    spy.mockRestore();
    document.body.innerHTML = "";
  });
});
