import { afterEach, describe, expect, it } from "vitest";
import { menuSpec } from "./appmenu";
import {
  bindingId,
  chordLabel,
  checkChord,
  editableBindings,
  effectiveKeymap,
  parseKeyOverrides,
  setKeyOverrides,
} from "./keyedit";
import { cheatsheetRows, dispatchTable } from "./keys";
import { KEYMAP } from "./keymap";

const CURNCY = "sector-CURNCY|F11";

afterEach(() => setKeyOverrides({}));

describe("KEYS: keymap editor (SPEC §4.5 “editable via KEYS”, §4.4 remap CURNCY)", () => {
  it("without overrides the effective keymap is the keymap file", () => {
    expect(effectiveKeymap()).toEqual(KEYMAP);
    expect(bindingId(KEYMAP.find((b) => b.action === "sector-CURNCY")!)).toBe(CURNCY);
  });

  it("the command line's own keys (Enter, Tab, ↑/↓) are not editable here", () => {
    const ids = editableBindings().map(bindingId);
    expect(ids).toContain(CURNCY);
    expect(ids).toContain("help|F1");
    expect(ids).not.toContain("go|Enter");
    expect(ids).not.toContain("accept|Tab");
  });

  it("accepts a free chord and rejects reserved, taken or typing-stealing ones", () => {
    expect(checkChord(CURNCY, "Ctrl+Shift+KeyY", {}, false)).toBeNull();
    expect(checkChord(CURNCY, "F13", {}, false)).toBeNull();
    expect(checkChord(CURNCY, "Meta+KeyQ", {}, false)).toMatch(/reserved/);
    expect(checkChord(CURNCY, "Ctrl+Space", {}, false)).toMatch(/reserved/);
    expect(checkChord(CURNCY, "Meta+KeyL", {}, false)).toMatch(/Focus command line/);
    expect(checkChord(CURNCY, "Alt+KeyX", {}, false)).toMatch(/types a character/);
    expect(checkChord(CURNCY, "KeyX", {}, false)).toMatch(/typing/);
    expect(checkChord(CURNCY, "Meta+Shift", {}, false)).toMatch(/not a key/);
    // Browser mode: a chord the browser keeps cannot be used there.
    expect(checkChord(CURNCY, "Meta+KeyT", {}, true)).toMatch(/browser/);
    // A content-only key must not take a function's own hotkey.
    expect(checkChord("toggle-tape|Alt+KeyT", "KeyJ", {}, false)).toMatch(/hotkey/);
  });

  it("text-editing and macOS system chords are refused too (review 1b #15, #18)", () => {
    for (const browser of [false, true]) {
      for (const chord of [
        "Meta+KeyC",
        "Meta+KeyV",
        "Meta+KeyX",
        "Meta+KeyA",
        "Meta+KeyZ",
        "Meta+Shift+KeyZ",
        "Meta+Shift+KeyQ", // log out
        "Ctrl+Alt+Space", // next input source (EN/RU)
        "Meta+Alt+KeyH", // hide others (the app menu's own item)
        "Meta+Alt+Escape", // force quit
        "Meta+Ctrl+KeyQ", // lock screen
        "Meta+Ctrl+Space", // emoji & symbols
      ]) {
        expect(checkChord("help|F1", chord, {}, browser), chord).toMatch(/macOS|text/);
      }
    }
    // Stored overrides with such a chord are dropped on load as well.
    expect(parseKeyOverrides({ overrides: { "help|F1": "Meta+KeyV" } }, false)).toEqual({});
  });

  it("chord labels for hints and tooltips follow the overrides and the mode (review 1b #19)", () => {
    expect(chordLabel("help", false)).toBe("F1");
    expect(chordLabel("back", false)).toBe("⌘[");
    expect(chordLabel("back", true)).toBe("⌃⇧[");
    setKeyOverrides({ "help|F1": "F14", "function-menu|Ctrl+Enter": "Ctrl+Shift+KeyM" });
    expect(chordLabel("help", false)).toBe("F14");
    expect(chordLabel("function-menu", true)).toBe("⌃⇧M");
  });

  it("a chord freed by another override can be reused; a taken override cannot", () => {
    const free = { "help|F1": "F14" };
    expect(checkChord(CURNCY, "F1", free, false)).toBeNull();
    expect(checkChord(CURNCY, "F14", free, false)).toMatch(/HELP/);
  });

  it("an override replaces the chord in the dispatcher, the cheat sheet and the native menu", () => {
    setKeyOverrides({ [CURNCY]: "Ctrl+Shift+KeyY" });
    for (const browser of [false, true]) {
      const t = dispatchTable(browser, false);
      expect(t.get("Ctrl+Shift+KeyY")?.action).toBe("sector-CURNCY");
      expect(t.get("F11")).toBeUndefined();
    }
    expect(cheatsheetRows(false).find((r) => r.description === "CURNCY")?.keys).toBe("⌃⇧Y");
    const go = menuSpec().find((m) => m.text === "Go")!;
    expect(go.items).toContainEqual(
      expect.objectContaining({ action: "sector-CURNCY", accelerator: "Ctrl+Shift+KeyY" }),
    );
  });

  it("stored overrides are re-checked on load: bad entries are dropped", () => {
    expect(
      parseKeyOverrides({
        overrides: {
          [CURNCY]: "Ctrl+Shift+KeyY",
          "help|F1": "Meta+KeyQ", // reserved
          "nope|F99": "F15", // no such binding
          "go|Enter": "F16", // not editable
        },
      }),
    ).toEqual({ [CURNCY]: "Ctrl+Shift+KeyY" });
    expect(parseKeyOverrides(null)).toEqual({});
    expect(parseKeyOverrides({ overrides: { [CURNCY]: 5 } })).toEqual({});
  });

  it("a valid chain or swap of chords survives a reload, whatever the stored order (review 1b #4)", () => {
    // In KEYS: HELP F1→F14, CURNCY F11→F1, HELP F14→F11. Each step is accepted.
    let o: Record<string, string> = {};
    for (const [id, chord] of [
      ["help|F1", "F14"],
      [CURNCY, "F1"],
      ["help|F1", "F11"],
    ] as const) {
      expect(checkChord(id, chord, o, false)).toBeNull();
      o = { ...o, [id]: chord };
    }
    for (const browser of [false, true]) {
      expect(parseKeyOverrides(JSON.parse(JSON.stringify({ overrides: o })), browser)).toEqual(o);
    }
    // Two entries that really clash are both dropped; the rest stays.
    expect(
      parseKeyOverrides({
        overrides: { "help|F1": "F15", [CURNCY]: "F15", "help|Meta+Slash": "F16" },
      }),
    ).toEqual({ "help|Meta+Slash": "F16" });
  });
});
