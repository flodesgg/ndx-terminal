/**
 * KEYS editor (SPEC §4.5: "all bindings live in one keymap file, editable via KEYS"). The user's
 * changes are overrides on top of the keymap file, stored in user.db (`/settings/keys`) and
 * checked by the same rules as the file itself: never reserved, never a chord the browser keeps
 * (browser mode), never Option+key where it types, never stealing typing, never a duplicate in an
 * overlapping scope, never shadowing a function's own hotkey.
 */
import { useSyncExternalStore } from "react";
import { api, isTauri } from "./api";
import {
  BROWSER_RESERVED,
  effectiveChord,
  isWellFormed,
  KEYMAP,
  PANEL_KEYMAP,
  parseChord,
  prettyChord,
  RESERVED,
  scopesOverlap,
  typesInTextFields,
  type KeyBinding,
} from "./keymap";

/** binding id (`action|default chord`) → the chord the user chose (both modes). */
export type KeyOverrides = Readonly<Record<string, string>>;

export const KEYS_SETTING = "keys";

export function bindingId(b: KeyBinding): string {
  return `${b.action}|${b.chord}`;
}

/** The command line's own keys and Esc (handled before the keymap) stay as they are. */
export function editableBindings(): KeyBinding[] {
  return KEYMAP.filter((b) => b.scope !== "command" && !b.phase && b.action !== "cancel");
}

function apply(overrides: KeyOverrides): KeyBinding[] {
  return KEYMAP.map((b) => {
    const c = overrides[bindingId(b)];
    if (!c) return b;
    const next: KeyBinding = { ...b, chord: c };
    delete next.browser; // one chord for both modes
    return next;
  });
}

let overrides: KeyOverrides = {};
let effective: readonly KeyBinding[] = KEYMAP;
const listeners = new Set<() => void>();

/** The keymap in effect: the file plus the user's overrides. */
export function effectiveKeymap(): readonly KeyBinding[] {
  return effective;
}

export function keyOverrides(): KeyOverrides {
  return overrides;
}

export function setKeyOverrides(o: KeyOverrides): void {
  overrides = { ...o };
  effective = Object.keys(overrides).length ? apply(overrides) : KEYMAP;
  for (const l of listeners) l();
}

/**
 * The chord shown for an action in hints and tooltips: its first global/content binding in the
 * effective keymap (KEYS overrides included), in this mode's form (review 1b #19).
 */
export function chordLabel(action: string, browser = !isTauri()): string {
  const b = effective.find((x) => x.action === action && x.scope !== "command" && !x.phase);
  return b ? prettyChord(effectiveChord(b, browser)) : "";
}

export function onKeymapChange(l: () => void): () => void {
  listeners.add(l);
  return () => void listeners.delete(l);
}

/** Re-render on KEYS edits: for components that show chords (hint bar, toolbar, MENU). */
export function useEffectiveKeymap(): readonly KeyBinding[] {
  return useSyncExternalStore(onKeymapChange, effectiveKeymap);
}

const MODIFIER_KEY = /^(Meta|Ctrl|Control|Alt|Shift)(Left|Right)?$/;

/**
 * Not in SPEC §4.5's never-bind list, but taking them would break typing or the system: the
 * text-editing chords every field uses (the native Edit menu owns them) and other macOS chords
 * (review 1b #15, #18). A KEYS user cannot pick them.
 */
export const TEXT_EDITING: readonly string[] = [
  "Meta+KeyC",
  "Meta+KeyV",
  "Meta+KeyX",
  "Meta+KeyA",
  "Meta+KeyZ",
  "Meta+Shift+KeyZ",
];
export const SYSTEM_CHORDS: readonly string[] = [
  "Meta+Shift+KeyQ", // log out
  "Ctrl+Alt+Space", // select the next input source
  "Meta+Alt+KeyH", // hide others
  "Meta+Alt+Escape", // force quit
  "Meta+Ctrl+KeyQ", // lock screen
  "Meta+Ctrl+Space", // emoji & symbols
  "Meta+Ctrl+KeyF", // full screen
];
const PANEL_CHORDS = new Set(
  Object.values(PANEL_KEYMAP).flatMap((keys) => keys.flatMap((k) => [...k.chords])),
);

/** Why `chord` cannot be used for binding `id` (with `current` overrides), or null if it can. */
export function checkChord(
  id: string,
  chord: string,
  current: KeyOverrides,
  browser: boolean,
): string | null {
  const b = editableBindings().find((x) => bindingId(x) === id);
  if (!b) return `${id} cannot be changed here`;
  const { mods, code } = parseChord(chord);
  const pretty = prettyChord(chord);
  if (!code || MODIFIER_KEY.test(code) || !isWellFormed(chord)) return `${pretty} is not a key`;
  if (RESERVED.includes(chord)) return `${pretty} is reserved by macOS (SPEC §4.5)`;
  if (TEXT_EDITING.includes(chord)) return `${pretty} is a text-editing key (copy, paste, undo…)`;
  if (SYSTEM_CHORDS.includes(chord)) return `${pretty} is used by macOS`;
  if (browser && BROWSER_RESERVED.includes(chord)) return `${pretty} is kept by the browser`;
  if (typesInTextFields(chord) && b.scope !== "content") {
    return `${pretty}: Option+key types a character in text fields`;
  }
  const bare = !mods.has("Meta") && !mods.has("Ctrl");
  if (b.scope === "global" && bare && !/^(F\d+|Escape)$/.test(code)) {
    return `${pretty} would fire while typing in the command line; add ⌘ or ⌃`;
  }
  if (b.scope === "content" && bare && !mods.has("Alt") && PANEL_CHORDS.has(chord)) {
    return `${pretty} is a function's own hotkey (see the list below)`;
  }
  const others = apply({ ...current, [id]: chord }).filter((x) => bindingId(x) !== id);
  const clash = others.find(
    (x) =>
      effectiveChord(x, browser) === chord &&
      scopesOverlap(x.scope, b.scope) &&
      x.action !== b.action,
  );
  if (clash) return `${pretty} is taken by ${clash.label}`;
  return null;
}

/**
 * Stored overrides, each re-checked (a keymap update may have taken its chord since). Each entry
 * is checked against all the others, not only the ones read before it, so a swap or chain of
 * chords survives; a dropped entry takes back its default chord, so repeat until nothing fails.
 */
export function parseKeyOverrides(raw: unknown, browser = !isTauri()): Record<string, string> {
  const o = raw && typeof raw === "object" ? (raw as { overrides?: unknown }).overrides : undefined;
  if (!o || typeof o !== "object") return {};
  let out: Record<string, string> = Object.fromEntries(
    Object.entries(o as Record<string, unknown>).filter(
      (e): e is [string, string] => typeof e[1] === "string",
    ),
  );
  for (;;) {
    const bad = Object.keys(out).filter((id) => checkChord(id, out[id]!, out, browser) !== null);
    if (!bad.length) return out;
    out = Object.fromEntries(Object.entries(out).filter(([id]) => !bad.includes(id)));
  }
}

export async function bootKeys(): Promise<void> {
  const raw = await api.get<unknown>(`/settings/${KEYS_SETTING}`).catch(() => null);
  setKeyOverrides(parseKeyOverrides(raw));
}

export async function saveKeyOverrides(o: KeyOverrides): Promise<void> {
  await api.put(`/settings/${KEYS_SETTING}`, { overrides: o });
  setKeyOverrides(o);
}
