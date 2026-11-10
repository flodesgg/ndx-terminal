import { describe, expect, it } from "vitest";
import { menuSpec } from "./appmenu";
import { ACTIONS, cheatsheetRows, dispatchTable } from "./keys";
import {
  accelerator,
  BROWSER_RESERVED,
  chordOf,
  effectiveChord,
  isWellFormed,
  KEYMAP,
  PANEL_KEYMAP,
  panelCheatsheetRows,
  prettyChord,
  RESERVED,
  scopesOverlap,
  typesInTextFields,
} from "./keymap";
import { SECTOR_KEYS } from "./sectors";

const live = KEYMAP;

describe("keymap (SPEC §4.5): one file, no duplicates, no reserved chords", () => {
  it("every chord is well formed", () => {
    for (const b of live) {
      expect(isWellFormed(b.chord), b.chord).toBe(true);
      if (b.browser) expect(isWellFormed(b.browser), b.browser).toBe(true);
    }
  });

  for (const browser of [false, true]) {
    it(`no chord is bound twice in overlapping scopes (${browser ? "browser" : "app"} mode)`, () => {
      const dups: string[] = [];
      live.forEach((a, i) =>
        live.slice(i + 1).forEach((b) => {
          if (
            effectiveChord(a, browser) === effectiveChord(b, browser) &&
            scopesOverlap(a.scope, b.scope)
          ) {
            dups.push(`${effectiveChord(a, browser)}: ${a.action} / ${b.action}`);
          }
        }),
      );
      expect(dups).toEqual([]);
    });
  }

  it("never binds a reserved macOS chord, in either mode", () => {
    for (const b of live) {
      expect(RESERVED, b.action).not.toContain(b.chord);
      if (b.browser) expect(RESERVED, b.action).not.toContain(b.browser);
    }
  });

  it("never binds Option+key where it types characters (text fields)", () => {
    for (const b of live) {
      if (typesInTextFields(b.chord)) expect(b.scope, b.chord).toBe("content");
      if (b.browser && typesInTextFields(b.browser)) expect(b.scope).toBe("content");
    }
  });

  it("every chord the browser keeps has a browser-mode alternate that it does not keep", () => {
    for (const b of live) {
      if (BROWSER_RESERVED.includes(b.chord) && b.scope !== "content") {
        expect(b.browser, `${b.chord} (${b.action}) needs a browser alternate`).toBeDefined();
      }
      if (b.browser) expect(BROWSER_RESERVED).not.toContain(b.browser);
    }
  });

  it("covers the §4.5 table and the §4.4 sector keys", () => {
    const chords = new Map(live.map((b) => [b.chord, b.action]));
    expect(chords.get("Enter")).toBe("go");
    expect(chords.get("Shift+Enter")).toBe("go-new");
    expect(chords.get("Escape")).toBe("cancel");
    expect(chords.get("Meta+KeyL")).toBe("focus-command");
    expect(chords.get("Slash")).toBe("focus-command");
    expect(chords.get("Meta+BracketLeft")).toBe("back");
    expect(chords.get("Meta+BracketRight")).toBe("forward");
    expect(chords.get("Meta+ArrowUp")).toBe("menu-up");
    expect(chords.get("F1")).toBe("help");
    expect(chords.get("Meta+Slash")).toBe("help");
    expect(chords.get("Ctrl+Tab")).toBe("next-window");
    expect(chords.get("Ctrl+Shift+Tab")).toBe("prev-window");
    expect(chords.get("Meta+Digit9")).toBe("jump-window-9");
    expect(chords.get("Meta+KeyT")).toBe("new-tab");
    expect(chords.get("Meta+KeyW")).toBe("close-tab");
    expect(chords.get("Meta+Shift+KeyT")).toBe("reopen-tab");
    expect(chords.get("Meta+Shift+Enter")).toBe("maximize");
    expect(chords.get("Meta+KeyJ")).toBe("hint-mode");
    expect(chords.get("Meta+Shift+KeyK")).toBe("keyboard-overlay");
    expect(chords.get("Shift+Slash")).toBe("cheatsheet");
    expect(chords.get("Ctrl+Enter")).toBe("function-menu");
    for (const s of SECTOR_KEYS.filter((k) => k.token !== "HELP")) {
      expect(chords.get(s.key), s.token).toBe(`sector-${s.token}`);
    }
  });

  it("windows/tabs/history bindings are live (1b step 1, §4.5)", () => {
    for (const a of ["back", "forward", "new-tab", "close-tab", "reopen-tab"]) {
      const bs = KEYMAP.filter((b) => b.action === a);
      expect(bs.length, a).toBeGreaterThan(0);
      for (const b of bs) expect(b.phase, `${a} ${b.chord}`).toBeUndefined();
      expect(ACTIONS[a], a).toBeTypeOf("function");
    }
    expect(KEYMAP.find((b) => b.chord === "Backspace")?.action).toBe("back");
  });

  it("every binding not deferred to 1b has an action, except the command line's own keys", () => {
    const owned = new Set(["go", "go-new", "cancel", "history-prev", "history-next", "accept"]);
    for (const b of live.filter((x) => !x.phase && !owned.has(x.action))) {
      expect(ACTIONS[b.action], b.action).toBeTypeOf("function");
    }
  });

  it("matches physical keys, so Cyrillic layouts hit the same bindings (§4.6)", () => {
    // ⌘ + the physical L key types "д" on Russian – PC; the binding still fires.
    const e = {
      code: "KeyL",
      key: "д",
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
    };
    expect(chordOf(e)).toBe("Meta+KeyL");
    const app = dispatchTable(false, false);
    expect(app.get("Meta+KeyL")?.action).toBe("focus-command");
    expect(app.get("F8")?.action).toBe("sector-EQUITY");
    const browser = dispatchTable(true, false);
    expect(browser.get("Meta+KeyL")).toBeUndefined();
    expect(browser.get("Ctrl+Shift+KeyL")?.action).toBe("focus-command");
    // In the app the native menu fires its own chords; the dispatcher leaves them alone.
    expect(dispatchTable(false, true).get("Meta+KeyW")).toBeUndefined();
    expect(dispatchTable(false, true).get("Alt+Backslash")?.action).toBe("split-right");
  });

  it("formats chords for the cheat sheet and the native menu", () => {
    expect(prettyChord("Meta+Shift+KeyK")).toBe("⌘⇧K");
    expect(prettyChord("Ctrl+Shift+Tab")).toBe("⌃⇧Tab");
    expect(prettyChord("Shift+Slash")).toBe("?");
    expect(accelerator("Meta+Shift+Enter")).toBe("Cmd+Shift+Enter");
    expect(accelerator("Meta+BracketLeft")).toBe("Cmd+BracketLeft");
    const rows = cheatsheetRows(false);
    expect(rows.find((r) => r.description === "Jump to window N")?.keys).toBe("⌘1 … ⌘9");
    expect(rows.find((r) => r.description === "HELP")?.keys).toBe("F1 · ⌘/");
    expect(rows.find((r) => r.description === "BACK")?.keys).toBe("⌘[");
    expect(rows.find((r) => r.description === "Hint mode (jump to any clickable)")?.keys).toBe(
      "⌘J",
    );
    expect(
      cheatsheetRows(true).find((r) => r.description === "Hint mode (jump to any clickable)")?.keys,
    ).toBe("⌃⇧J");
  });
});

describe("panel hotkeys live in the keymap too (1a #36, SPEC §4.5)", () => {
  const panel = Object.entries(PANEL_KEYMAP).flatMap(([fn, keys]) =>
    keys.flatMap((k) => k.chords.map((chord) => ({ fn, action: k.action, chord }))),
  );

  it("covers every function that takes hotkeys", () => {
    for (const fn of [
      "W",
      "GP",
      "DES",
      "FA",
      "N",
      "FX",
      "WEI",
      "CDR",
      "EQS",
      "ECO",
      "CF",
      "INS",
      "PORT",
      "ALRT",
      "NOTE",
      "BT",
      "CORR",
      "CRYPTO",
      "HELP",
      "LOG",
    ]) {
      expect(PANEL_KEYMAP[fn as keyof typeof PANEL_KEYMAP]?.length, fn).toBeGreaterThan(0);
    }
  });

  it("chords are well formed, not reserved, never Option+letter, unique per function", () => {
    const dups: string[] = [];
    panel.forEach((a, i) => {
      expect(isWellFormed(a.chord), `${a.fn} ${a.chord}`).toBe(true);
      expect(RESERVED, `${a.fn} ${a.chord}`).not.toContain(a.chord);
      expect(typesInTextFields(a.chord), `${a.fn} ${a.chord}`).toBe(false);
      panel.slice(i + 1).forEach((b) => {
        if (a.fn === b.fn && a.chord === b.chord) dups.push(`${a.fn} ${a.chord}`);
      });
    });
    expect(dups).toEqual([]);
  });

  for (const browser of [false, true]) {
    it(`no panel chord shadows an app chord with content focus (${browser ? "browser" : "app"})`, () => {
      const taken = new Map(
        KEYMAP.filter((b) => b.scope !== "command").map((b) => [effectiveChord(b, browser), b]),
      );
      const clashes = panel
        .filter((p) => taken.has(p.chord))
        .map((p) => `${p.fn} ${p.chord} vs ${taken.get(p.chord)!.action}`);
      expect(clashes).toEqual([]);
    });
  }

  it("the cheat sheet rows come from the same entries", () => {
    const w = panelCheatsheetRows("W")
      .map((r) => `${r.keys} ${r.description}`)
      .join(" | ");
    for (const k of ["↑ ↓ K J", "Home G", "End ⇧G", "⇧J", "⇧K", "⌫", "[ ] ← →"]) {
      expect(w, k).toContain(k);
    }
    expect(panelCheatsheetRows("GP").find((r) => r.description.startsWith("Range"))?.keys).toBe(
      "1 … 9",
    );
  });
});

describe("native menu (Tauri)", () => {
  const spec = menuSpec();
  const items = spec.flatMap((m) => m.items);
  const custom = items.filter((e): e is Extract<typeof e, { id: string }> => "id" in e);

  it("⌘W closes the active tab, not the app (audit C2, §4.5)", () => {
    expect(items).not.toContainEqual({ item: "CloseWindow" });
    expect(custom.find((e) => e.accelerator === "Cmd+KeyW")?.action).toBe("close-tab");
  });

  it("system items keep their own chords; the app's items avoid reserved ones", () => {
    expect(items).toContainEqual({ item: "Hide" });
    expect(items).toContainEqual({ item: "Minimize" });
    // Quit is the one app item on a reserved chord: ⌘Q keeps its system meaning (it quits),
    // it only saves the session first (review 1b #23). Nothing else may take a reserved chord.
    const quit = custom.filter((e) => e.accelerator === accelerator("Meta+KeyQ"));
    expect(quit).toEqual([expect.objectContaining({ action: "quit" })]);
    for (const e of custom.filter((x) => x.action !== "quit")) {
      expect(RESERVED.map(accelerator)).not.toContain(e.accelerator);
      expect(ACTIONS[e.action], e.action).toBeTypeOf("function");
    }
    expect(new Set(custom.map((e) => e.accelerator)).size).toBe(custom.length);
  });

  it("lists the sector keys and has Edit for text fields", () => {
    expect(custom.filter((e) => e.text.startsWith("Sector ")).length).toBe(11);
    expect(spec.find((m) => m.text === "Edit")?.items).toContainEqual({ item: "Paste" });
  });
});
