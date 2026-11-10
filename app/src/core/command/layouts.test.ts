import { describe, expect, it } from "vitest";
import { hasCyrillic, layoutFixed, RU_PC_TO_US, UK_TO_US } from "./layouts";

/*
 * Expected tables written out independently of layouts.ts, in physical-key order.
 * Source: raw UCKeyTranslate dump on macOS 27.2 (build 26B123), 2026-11-09,
 * Carbon TISCreateInputSourceList(includeAllInstalled=true) + kTISPropertyUnicodeKeyLayoutData,
 * keyboard type 91 (ANSI), no modifiers / Shift, for input sources
 *   com.apple.keylayout.US, com.apple.keylayout.RussianWin ("Russian – PC"),
 *   com.apple.keylayout.Ukrainian-PC ("Ukrainian" — the standard one; not
 *   com.apple.keylayout.Ukrainian, which macOS names "Ukrainian – Legacy").
 * Row format: "<KeyboardEvent.code>: <unshifted>/<shifted>".
 */

/** U.S. output per physical key: [unshifted, shifted]. */
const US: Record<string, [string, string]> = {
  Backquote: ["`", "~"],
  KeyQ: ["q", "Q"],
  KeyW: ["w", "W"],
  KeyE: ["e", "E"],
  KeyR: ["r", "R"],
  KeyT: ["t", "T"],
  KeyY: ["y", "Y"],
  KeyU: ["u", "U"],
  KeyI: ["i", "I"],
  KeyO: ["o", "O"],
  KeyP: ["p", "P"],
  BracketLeft: ["[", "{"],
  BracketRight: ["]", "}"],
  KeyA: ["a", "A"],
  KeyS: ["s", "S"],
  KeyD: ["d", "D"],
  KeyF: ["f", "F"],
  KeyG: ["g", "G"],
  KeyH: ["h", "H"],
  KeyJ: ["j", "J"],
  KeyK: ["k", "K"],
  KeyL: ["l", "L"],
  Semicolon: [";", ":"],
  Quote: ["'", '"'],
  KeyZ: ["z", "Z"],
  KeyX: ["x", "X"],
  KeyC: ["c", "C"],
  KeyV: ["v", "V"],
  KeyB: ["b", "B"],
  KeyN: ["n", "N"],
  KeyM: ["m", "M"],
  Comma: [",", "<"],
  Period: [".", ">"],
};

/** Russian – PC. Backquote Shift outputs Latin "Ë" (U+00CB) on ANSI, so no uppercase there. */
const RU_PC_ROWS = [
  "Backquote: ё/",
  "KeyQ: й/Й",
  "KeyW: ц/Ц",
  "KeyE: у/У",
  "KeyR: к/К",
  "KeyT: е/Е",
  "KeyY: н/Н",
  "KeyU: г/Г",
  "KeyI: ш/Ш",
  "KeyO: щ/Щ",
  "KeyP: з/З",
  "BracketLeft: х/Х",
  "BracketRight: ъ/Ъ",
  "KeyA: ф/Ф",
  "KeyS: ы/Ы",
  "KeyD: в/В",
  "KeyF: а/А",
  "KeyG: п/П",
  "KeyH: р/Р",
  "KeyJ: о/О",
  "KeyK: л/Л",
  "KeyL: д/Д",
  "Semicolon: ж/Ж",
  "Quote: э/Э",
  "KeyZ: я/Я",
  "KeyX: ч/Ч",
  "KeyC: с/С",
  "KeyV: м/М",
  "KeyB: и/И",
  "KeyN: т/Т",
  "KeyM: ь/Ь",
  "Comma: б/Б",
  "Period: ю/Ю",
];

/** Ukrainian (standard). Backslash gives "ʼ"/"₴" (not letters, intentionally unmapped). */
const UK_ROWS = [
  "Backquote: ґ/Ґ",
  "KeyQ: й/Й",
  "KeyW: ц/Ц",
  "KeyE: у/У",
  "KeyR: к/К",
  "KeyT: е/Е",
  "KeyY: н/Н",
  "KeyU: г/Г",
  "KeyI: ш/Ш",
  "KeyO: щ/Щ",
  "KeyP: з/З",
  "BracketLeft: х/Х",
  "BracketRight: ї/Ї",
  "KeyA: ф/Ф",
  "KeyS: і/І",
  "KeyD: в/В",
  "KeyF: а/А",
  "KeyG: п/П",
  "KeyH: р/Р",
  "KeyJ: о/О",
  "KeyK: л/Л",
  "KeyL: д/Д",
  "Semicolon: ж/Ж",
  "Quote: є/Є",
  "KeyZ: я/Я",
  "KeyX: ч/Ч",
  "KeyC: с/С",
  "KeyV: м/М",
  "KeyB: и/И",
  "KeyN: т/Т",
  "KeyM: ь/Ь",
  "Comma: б/Б",
  "Period: ю/Ю",
];

/** Expands rows into [cyrillicChar, expectedUsChar, label] cases. */
function cases(rows: string[]): [string, string, string][] {
  const out: [string, string, string][] = [];
  for (const row of rows) {
    const m = /^(\w+): (.?)\/(.?)$/u.exec(row);
    if (!m) throw new Error(`bad row: ${row}`);
    const [, code = "", lower = "", upper = ""] = m;
    const us = US[code];
    if (!us) throw new Error(`unknown key: ${code}`);
    if (lower) out.push([lower, us[0], `${code}`]);
    if (upper) out.push([upper, us[1], `Shift+${code}`]);
  }
  return out;
}

describe.each([
  ["Russian – PC", RU_PC_TO_US, RU_PC_ROWS],
  ["Ukrainian", UK_TO_US, UK_ROWS],
] as const)("%s → U.S. by physical key", (_name, table, rows) => {
  const all = cases([...rows]);

  it.each(all)("%s → %s (%s)", (cyr, us) => {
    expect(table[cyr]).toBe(us);
    expect(layoutFixed(cyr)).toBe(us);
  });

  it("has no entries beyond the expected rows", () => {
    expect(Object.keys(table).sort()).toEqual(all.map(([c]) => c).sort());
  });
});

describe("layout tables", () => {
  it("sizes: 33 Russian – PC letters (no Ё on ANSI) and 33 Ukrainian letters", () => {
    expect(Object.keys(RU_PC_TO_US)).toHaveLength(65);
    expect(Object.keys(UK_TO_US)).toHaveLength(66);
  });
  it("has no conflicts between the two layouts", () => {
    for (const [ch, us] of Object.entries(UK_TO_US)) {
      if (ch in RU_PC_TO_US) expect(RU_PC_TO_US[ch]).toBe(us);
    }
  });
});

describe("layoutFixed", () => {
  it("fixes Russian – PC input (SPEC §4.3 #21)", () => {
    expect(layoutFixed("ФФЗД ГЫ УЙГШЕН ВУЫ")).toBe("AAPL US EQUITY DES");
    expect(layoutFixed("ТЩМЩИ ВС УЙГШЕН ПЗ")).toBe("NOVOB DC EQUITY GP");
  });
  it("Caps Lock Б/Ю inside a symbol are , and . (review 1a #41)", () => {
    expect(layoutFixed("ИКЛЮИ ПЗ")).toBe("BRK.B GP");
    expect(layoutFixed("ТЩМЩ-ИЮСЩ")).toBe("NOVO-B.CO");
    expect(layoutFixed("ФФЗД ФДКЕ Ю200")).toBe("AAPL ALRT >200");
    expect(layoutFixed("%Б-3")).toBe("%<-3");
  });
  it("preserves U.S. case semantics", () => {
    expect(layoutFixed("фФ")).toBe("aA");
    expect(layoutFixed("ффзд")).toBe("aapl");
  });
  it("fixes Ukrainian-only letters І/Ї/Є/Ґ", () => {
    expect(layoutFixed("ІЇЄҐ")).toBe('S}"~');
    expect(layoutFixed("іїєґ")).toBe("s]'`");
    expect(layoutFixed("ГІВ ЦУШ")).toBe("USD WEI");
  });
  it("passes Latin, digits and punctuation through unchanged", () => {
    const s = "NOVO-B.CO GP 1D ^GSPC CL=F eurusd";
    expect(layoutFixed(s)).toBe(s);
  });
  it("leaves unmapped non-letters as typed", () => {
    expect(layoutFixed("Ё Ë ʼ ₴ №")).toBe("Ё Ë ʼ ₴ №");
    expect(layoutFixed("ф 1.")).toBe("a 1.");
  });
});

describe("hasCyrillic", () => {
  it("detects Cyrillic letters", () => {
    expect(hasCyrillic("ФФЗД")).toBe(true);
    expect(hasCyrillic("AAPL ї")).toBe(true);
    expect(hasCyrillic("Ё")).toBe(true);
  });
  it("is false for Latin text", () => {
    expect(hasCyrillic("AAPL US EQUITY DES")).toBe(false);
    expect(hasCyrillic("Ë")).toBe(false);
    expect(hasCyrillic("")).toBe(false);
  });
});
