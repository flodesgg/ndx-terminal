/**
 * Layout-fixed variant of command-line text (SPEC §4.6): Cyrillic letters are mapped
 * by PHYSICAL key to what the macOS U.S. layout produces on the same key with the same
 * shift state (e.g. "ф"→"a", "Ф"→"A", "і"→"s", "Ї"→"}").
 *
 * GENERATED TABLES — do not edit by hand. Source (2026-11-09):
 *   macOS 27.2 (build 26B123), Carbon TISCreateInputSourceList(includeAllInstalled=true),
 *   kTISPropertyUnicodeKeyLayoutData + UCKeyTranslate (no modifiers / Shift,
 *   kUCKeyTranslateNoDeadKeysBit) over the 47 ANSI printable keys, keyboard type 91 (ANSI).
 *   Input sources:
 *     U.S.          com.apple.keylayout.US
 *     Russian – PC  com.apple.keylayout.RussianWin
 *     Ukrainian     com.apple.keylayout.Ukrainian-PC   (localized name "Ukrainian" on
 *                   macOS 27; NOT com.apple.keylayout.Ukrainian = "Ukrainian – Legacy")
 *
 * Inclusion rule: an entry exists iff the Cyrillic layout outputs a Cyrillic letter
 * (U+0400–U+04FF) on a key/shift state where U.S. outputs something different.
 * Deliberately excluded:
 *   - Punctuation/digits ("." on Slash, "№" on Shift+3, …): mapping them would corrupt
 *     Latin input such as "NOVO-B.CO".
 *   - Ukrainian "ʼ" (U+02BC) and "₴" on the Backslash key: not on a letter key, and
 *     U.S. "\"/"|" are meaningless in commands.
 *   - Russian – PC "Ё" (U+0401): on ANSI keyboards Shift+Backquote outputs the LATIN
 *     "Ë" (U+00CB), not "Ё"; "Ё" exists only on the ISO-only section key (0x0A, U.S. "±").
 *     Lowercase "ё" (Backquote, unshifted) maps to "`".
 *   Letter keys are identical for every keyboard type except Russian – PC Backquote
 *   (ISO/JIS types put "]"/"[" there and "ё"/"Ё" on 0x0A).
 *
 * Conflicts between the two layouts (same char → different U.S. key): none. Shared
 * letters sit on the same keys; layoutFixed() still prefers Russian – PC on overlap.
 */

/** Russian – PC (com.apple.keylayout.RussianWin) → U.S., 65 entries. */
export const RU_PC_TO_US: Readonly<Record<string, string>> = Object.freeze({
  ё: "`",
  й: "q",
  Й: "Q",
  ц: "w",
  Ц: "W",
  у: "e",
  У: "E",
  к: "r",
  К: "R",
  е: "t",
  Е: "T",
  н: "y",
  Н: "Y",
  г: "u",
  Г: "U",
  ш: "i",
  Ш: "I",
  щ: "o",
  Щ: "O",
  з: "p",
  З: "P",
  х: "[",
  Х: "{",
  ъ: "]",
  Ъ: "}",
  ф: "a",
  Ф: "A",
  ы: "s",
  Ы: "S",
  в: "d",
  В: "D",
  а: "f",
  А: "F",
  п: "g",
  П: "G",
  р: "h",
  Р: "H",
  о: "j",
  О: "J",
  л: "k",
  Л: "K",
  д: "l",
  Д: "L",
  ж: ";",
  Ж: ":",
  э: "'",
  Э: '"',
  я: "z",
  Я: "Z",
  ч: "x",
  Ч: "X",
  с: "c",
  С: "C",
  м: "v",
  М: "V",
  и: "b",
  И: "B",
  т: "n",
  Т: "N",
  ь: "m",
  Ь: "M",
  б: ",",
  Б: "<",
  ю: ".",
  Ю: ">",
});

/** Ukrainian (com.apple.keylayout.Ukrainian-PC) → U.S., 66 entries. */
export const UK_TO_US: Readonly<Record<string, string>> = Object.freeze({
  ґ: "`",
  Ґ: "~",
  й: "q",
  Й: "Q",
  ц: "w",
  Ц: "W",
  у: "e",
  У: "E",
  к: "r",
  К: "R",
  е: "t",
  Е: "T",
  н: "y",
  Н: "Y",
  г: "u",
  Г: "U",
  ш: "i",
  Ш: "I",
  щ: "o",
  Щ: "O",
  з: "p",
  З: "P",
  х: "[",
  Х: "{",
  ї: "]",
  Ї: "}",
  ф: "a",
  Ф: "A",
  і: "s",
  І: "S",
  в: "d",
  В: "D",
  а: "f",
  А: "F",
  п: "g",
  П: "G",
  р: "h",
  Р: "H",
  о: "j",
  О: "J",
  л: "k",
  Л: "K",
  д: "l",
  Д: "L",
  ж: ";",
  Ж: ":",
  є: "'",
  Є: '"',
  я: "z",
  Я: "Z",
  ч: "x",
  Ч: "X",
  с: "c",
  С: "C",
  м: "v",
  М: "V",
  и: "b",
  И: "B",
  т: "n",
  Т: "N",
  ь: "m",
  Ь: "M",
  б: ",",
  Б: "<",
  ю: ".",
  Ю: ">",
});

const MERGED: Readonly<Record<string, string>> = Object.freeze({ ...UK_TO_US, ...RU_PC_TO_US });

/** Maps every Cyrillic letter by physical key to U.S.; all other chars are kept as typed. */
/**
 * Caps Lock on the Russian/Ukrainian layout types upper-case `Б`/`Ю` on the comma/period keys,
 * the same characters Shift gives. Between two letters/digits (`BRK.B`, `NOVO-B.CO`) they are the
 * unshifted `,`/`.`; elsewhere (`ALRT >200`) the shifted `<`/`>` (review 1a #41).
 */
const CAPS_PUNCT: Readonly<Record<string, string>> = { Б: ",", Ю: "." };
const ALNUM = /[A-Za-z0-9]/;

export function layoutFixed(text: string): string {
  const chars = [...text];
  let out = "";
  chars.forEach((ch, i) => {
    const caps = CAPS_PUNCT[ch];
    const next = MERGED[chars[i + 1] ?? ""] ?? chars[i + 1] ?? "";
    if (caps && ALNUM.test(out.slice(-1)) && ALNUM.test(next)) out += caps;
    else out += MERGED[ch] ?? ch;
  });
  return out;
}

const CYRILLIC_RE = /[\u0400-\u04FF]/;

/** True if the text contains any character from the Cyrillic block (U+0400–U+04FF). */
export function hasCyrillic(text: string): boolean {
  return CYRILLIC_RE.test(text);
}
