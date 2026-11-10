/**
 * Global keyboard dispatch, driven by the single keymap (core/keymap.ts). Two modes:
 *  - COMMAND: the command line has focus; typing goes there (it handles its own keys).
 *  - CONTENT: focus is on the active window; single keys are that function's hotkeys.
 * In the Tauri app the native menu owns the chords it lists (its accelerators fire before the
 * web view sees the key); in browser mode this dispatcher handles them, with alternates for
 * chords the browser keeps for itself.
 */
import { useEffect, useRef } from "react";
import { isTauri } from "./api";
import { executeCommand } from "./executor";
import { hintKey, startHints, stopHints, useHints } from "./hints";
import { usePopup } from "./items";
import {
  chordOf,
  effectiveChord,
  keyCode,
  KEYMAP,
  panelAction,
  prettyChord,
  type Group,
  type KeyBinding,
  type PanelFn,
} from "./keymap";
import { effectiveKeymap, onKeymapChange } from "./keyedit";
import { visibleIds } from "./layout/session";
import { activePanel, useWorkspace } from "./layout/store";
import { menuParent } from "./menu";
import { quitApp } from "./quit";
import { menuFor } from "./recentnav";

export { keyCode };

/** A function's hotkey handler: gets the keymap action (PANEL_KEYMAP), true when handled. */
type PanelKeyHandler = (action: string) => boolean;
const panelHandlers = new Map<string, { fn: PanelFn; run: PanelKeyHandler }>();

/**
 * Register a function's hotkeys for its window; called only when that window is active and in
 * CONTENT mode. Keys come from the single keymap (`PANEL_KEYMAP[fn]`), never from the panel.
 */
export function usePanelKeys(id: string, fn: PanelFn, handler: PanelKeyHandler): void {
  const ref = useRef(handler);
  useEffect(() => {
    ref.current = handler;
  });
  useEffect(() => {
    const h = { fn, run: (a: string) => ref.current(a) };
    panelHandlers.set(id, h);
    return () => {
      if (panelHandlers.get(id) === h) panelHandlers.delete(id);
    };
  }, [id, fn]);
}

let commandInput: HTMLInputElement | null = null;
export function setCommandInput(el: HTMLInputElement | null): void {
  commandInput = el;
}

/** The command line registers how to insert a sector token (a chip) while typing (§4.4). */
let insertSector: ((token: string) => void) | null = null;
export function setSectorInserter(fn: ((token: string) => void) | null): void {
  insertSector = fn;
}

/** Any window's command line (one per window, SPEC §4.9). */
function isCommandInput(el: Element | null): boolean {
  return el !== null && (el === commandInput || el.hasAttribute("data-cmd-input"));
}

export function focusPanelMode(): void {
  if (isCommandInput(document.activeElement)) (document.activeElement as HTMLElement).blur();
  commandInput?.blur();
  const id = useWorkspace.getState().activeId;
  const el = document.querySelector<HTMLElement>(`[data-panel-id="${id}"]`);
  el?.focus({ preventScroll: true });
}

/** Editable inputs of a function window are amber fields (SPEC §4.2 `amber-field`, §4.8). */
export const AMBER_FIELDS =
  '.panel-body input:not([type="checkbox"]):not([type="radio"]):not([type="range"]), ' +
  ".panel-body select, [data-amber-field]";

function isAmber(el: Element | null): el is HTMLInputElement | HTMLSelectElement {
  return !!el && el.matches(AMBER_FIELDS);
}

/** Value of each amber field when it got focus (or was last applied with Enter): Esc reverts. */
const originals = new WeakMap<Element, string>();
if (typeof document !== "undefined") {
  document.addEventListener("focusin", (e) => {
    const t = e.target as Element | null;
    if (isAmber(t)) originals.set(t, t.value);
  });
}

function setFieldValue(el: HTMLInputElement | HTMLSelectElement, value: string): void {
  // Through the native setter, so React's onChange sees the change.
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement : HTMLInputElement;
  Object.getOwnPropertyDescriptor(proto.prototype, "value")?.set?.call(el, value);
  el.dispatchEvent(
    new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }),
  );
}

function activePanelEl(): HTMLElement | null {
  const id = useWorkspace.getState().activeId;
  return document.querySelector<HTMLElement>(`[data-panel-id="${id}"]`);
}

/** Focus stops inside the active window: its amber fields, then the content itself. */
function contentStops(panel: HTMLElement): HTMLElement[] {
  const fields = [...panel.querySelectorAll<HTMLElement>(AMBER_FIELDS)].filter(
    (f) => !(f as HTMLInputElement).disabled && !f.closest(".win-popup"),
  );
  return [...fields, panel];
}

/** Tab from the command line (§4.8): the first amber field, else the content. */
export function focusContent(): void {
  const panel = activePanelEl();
  if (!panel) return focusPanelMode();
  if (isCommandInput(document.activeElement)) (document.activeElement as HTMLElement).blur();
  contentStops(panel)[0]!.focus({ preventScroll: true });
}

function isEditable(el: Element | null): boolean {
  if (!el) return false;
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return true;
  if (el instanceof HTMLSelectElement) return true;
  return (el as HTMLElement).isContentEditable === true;
}

function cycleWindow(step: number): void {
  const ws = useWorkspace.getState();
  const ids = visibleIds(ws.session);
  if (!ids.length) return;
  const i = ids.indexOf(ws.activeId);
  ws.focus(ids[(i + step + ids.length) % ids.length]!);
}

/** What each keymap action does. Actions owned by the command line are not listed here. */
export const ACTIONS: Record<string, () => void> = {
  "focus-command": () => useWorkspace.getState().requestCommandFocus(),
  "next-window": () => cycleWindow(1),
  "prev-window": () => cycleWindow(-1),
  ...Object.fromEntries(
    [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => [
      `jump-window-${n}`,
      () => useWorkspace.getState().focusIndex(n - 1),
    ]),
  ),
  "close-tab": () => useWorkspace.getState().closeActive(),
  "new-tab": () => useWorkspace.getState().newTab(),
  "reopen-tab": () => useWorkspace.getState().reopenTab(),
  back: () => useWorkspace.getState().back(),
  forward: () => useWorkspace.getState().forward(),
  maximize: () => useWorkspace.getState().toggleMax(),
  "split-right": () => useWorkspace.getState().split("row"),
  "split-down": () => useWorkspace.getState().split("col"),
  "focus-left": () => useWorkspace.getState().focusDir("left"),
  "focus-right": () => useWorkspace.getState().focusDir("right"),
  "focus-up": () => useWorkspace.getState().focusDir("up"),
  "focus-down": () => useWorkspace.getState().focusDir("down"),
  "resize-left": () => useWorkspace.getState().resizeActive("row", -0.05),
  "resize-right": () => useWorkspace.getState().resizeActive("row", 0.05),
  "resize-up": () => useWorkspace.getState().resizeActive("col", -0.05),
  "resize-down": () => useWorkspace.getState().resizeActive("col", 0.05),
  "toggle-tape": () => useWorkspace.getState().toggleTape(),
  // F1 / ⌘/ (SPEC §4.4–4.5): HELP; pressed again while HELP is on screen = help search.
  help: () => {
    if (activePanel()?.fn === "HELP")
      useWorkspace.getState().open({ fn: "HELP", args: ["SEARCH"] });
    else void executeCommand("HELP");
  },
  "menu-up": () => {
    const v = activePanel();
    const up = v && menuParent(v);
    if (up) useWorkspace.getState().open(up);
  },
  "function-menu": () => useWorkspace.getState().open(menuFor(activePanel())),
  quit: () => void quitApp(), // the app menu's Quit (⌘Q): save the session, then quit
  "hint-mode": () => (useHints.getState().targets ? stopHints() : void startHints()),
  cheatsheet: () => {
    const ws = useWorkspace.getState();
    ws.setCheatsheet(!ws.cheatsheetOpen);
  },
  ...Object.fromEntries(
    KEYMAP.filter((b) => b.action.startsWith("sector-")).map((b) => {
      const token = b.action.slice("sector-".length);
      return [
        b.action,
        () => {
          // While typing: insert the sector as a chip; otherwise open its menu.
          if (insertSector && isCommandInput(document.activeElement)) insertSector(token);
          else void executeCommand(token);
        },
      ];
    }),
  ),
};

/** Bindings this dispatcher handles in the current mode (`menuOwned`: chords the menu fires). */
export function dispatchTable(
  browser: boolean,
  menuOwned: boolean,
): Map<string, KeyBinding & { run: () => void }> {
  const t = new Map<string, KeyBinding & { run: () => void }>();
  for (const b of effectiveKeymap()) {
    const run = ACTIONS[b.action];
    if (!run || b.phase || (menuOwned && b.menu)) continue;
    t.set(effectiveChord(b, browser), { ...b, run });
  }
  return t;
}

const PANEL_ACTIONS = new Set(["focus-left", "focus-right", "focus-up", "focus-down"]);
let table: ReturnType<typeof dispatchTable> | null = null;
// KEYS overrides change the chords: rebuild the table on the next key.
onKeymapChange(() => {
  table = null;
});

/** Window/focus actions also move DOM focus into the new panel (unless typing a command). */
function movesFocus(action: string): boolean {
  return PANEL_ACTIONS.has(action) || /^jump-window|window$/.test(action);
}

/**
 * Runs a keymap action the way the key dispatcher does. The native menu (Tauri) owns some
 * chords, so it calls this too: otherwise ⌘2 from the menu highlighted panel 2 while typing
 * still went into panel 1 (review 1a #37).
 */
export function runAction(action: string): void {
  const run = ACTIONS[action];
  if (!run) return;
  const inCommand = isCommandInput(document.activeElement);
  run();
  if (movesFocus(action) && !inCommand) focusPanelMode();
}

/** KEYS: the next chord pressed goes to `capture` (Esc cancels) instead of being dispatched. */
let capture: ((chord: string | null) => void) | null = null;
export function captureNextChord(cb: ((chord: string | null) => void) | null): void {
  capture = cb;
}

export function handleGlobalKey(e: KeyboardEvent): void {
  if (capture) {
    if (/^(Meta|Control|Alt|Shift)(Left|Right)?$/.test(e.code || e.key)) return; // a modifier alone
    const cb = capture;
    capture = null;
    e.preventDefault();
    e.stopPropagation();
    cb(e.key === "Escape" && !e.metaKey && !e.ctrlKey ? null : chordOf(e));
    return;
  }
  table ??= dispatchTable(!isTauri(), isTauri());
  const ws = useWorkspace.getState();
  const active = document.activeElement;
  const inCommand = isCommandInput(active);
  const editing = isEditable(active);

  // Hint mode takes every key while its labels are up (⌘J again, or any chord, leaves it).
  if (useHints.getState().targets) {
    if (e.metaKey || e.ctrlKey) stopHints();
    else hintKey(e);
    e.preventDefault();
    return;
  }

  // An open 95/96/97 menu handles its own keys (arrows, Enter, Esc).
  if (active?.closest(".win-popup")) return;

  if (e.key === "Escape") {
    if (ws.cheatsheetOpen) {
      ws.setCheatsheet(false);
      e.preventDefault();
      return;
    }
    if (inCommand) return; // the command line handles its own Esc (clear, then leave)
    if (usePopup.getState().popup) {
      usePopup.getState().close();
      focusPanelMode();
      e.preventDefault();
      return;
    }
    if (isAmber(active) && originals.has(active) && originals.get(active) !== active.value) {
      setFieldValue(active, originals.get(active)!); // §4.8: Esc reverts
      e.preventDefault();
      e.stopPropagation(); // the field's own Esc handler (N, BT) must not also leave it (#11)
      return;
    }
    ws.requestCommandFocus();
    e.preventDefault();
    return;
  }

  if (isAmber(active) && e.key === "Enter") originals.set(active, active.value); // applied

  // §4.8: Tab / Shift+Tab move between the active window's amber fields and its content.
  if (e.key === "Tab" && !inCommand && !e.metaKey && !e.ctrlKey && !e.altKey) {
    const panel = activePanelEl();
    const stops = panel ? contentStops(panel) : [];
    const i = active ? stops.indexOf(active as HTMLElement) : -1;
    if (i >= 0) {
      const n = stops.length;
      stops[(i + (e.shiftKey ? n - 1 : 1)) % n]!.focus({ preventScroll: true });
      e.preventDefault();
      return;
    }
  }

  const b = table.get(chordOf(e));
  // Content-scoped chords never fire inside text fields: on macOS ⌥+key types characters
  // (å, ∑, ¡) and ⌥+arrows move by word (SPEC §4.5, bug C1).
  if (b && (b.scope === "global" || (b.scope === "content" && !editing))) {
    b.run();
    if (movesFocus(b.action) && !inCommand) focusPanelMode();
    e.preventDefault();
    return;
  }

  if (editing || e.metaKey || e.ctrlKey) return;
  const panel = panelHandlers.get(ws.activeId);
  const action = panel && panelAction(panel.fn, chordOf(e));
  if (action && panel.run(action)) {
    e.preventDefault();
    return;
  }
  // §4.8: any other printable key jumps to the command line and starts typing there (so
  // N+Enter and a ticker work from the content). ⌥+key is left alone: on macOS it types symbols.
  // Space keeps its native activation on a focused control (button, link, tab, checkbox…).
  if (e.key === " " && active?.closest(ACTIVATES_ON_SPACE)) return;
  if (commandInput && !e.altKey && [...e.key].length === 1) {
    e.preventDefault();
    typeIntoCommand(commandInput, e.key);
  }
}

const ACTIVATES_ON_SPACE =
  'button, a[href], [role="button"], [role="tab"], [role="link"], [role="checkbox"], ' +
  'input[type="checkbox"], input[type="radio"], select, summary';

function typeIntoCommand(input: HTMLInputElement, ch: string): void {
  input.focus({ preventScroll: true });
  setFieldValue(input, input.value + ch);
  const end = input.value.length;
  input.setSelectionRange(end, end);
}

/** Cheat-sheet rows, generated from the keymap for the current mode. */
export function cheatsheetRows(
  browser = !isTauri(),
): { group: Group; keys: string; description: string }[] {
  const out: { group: Group; keys: string; description: string }[] = [];
  const seen = new Map<string, number>();
  for (const b of effectiveKeymap()) {
    if (b.phase) continue;
    const keys = prettyChord(effectiveChord(b, browser));
    const label = b.family ?? b.label;
    const k = `${b.group}|${label}`;
    const at = seen.get(k);
    if (at !== undefined) {
      const row = out[at]!;
      if (b.family) row.keys = `${row.keys.split(" … ")[0]} … ${keys}`;
      else if (!row.keys.split(" · ").includes(keys)) row.keys += ` · ${keys}`;
      continue;
    }
    seen.set(k, out.length);
    out.push({ group: b.group, keys, description: label });
  }
  return out;
}

const TIP_KEY = "ndx.tip.function-keys.v1";

/**
 * One-time tip (SPEC §4.4): on a Mac the F-keys are media keys by default and F11 is
 * "Show Desktop", so sector keys need fn, or a System Settings change.
 */
export function showFunctionKeyTipOnce(): void {
  try {
    if (localStorage.getItem(TIP_KEY)) return;
    localStorage.setItem(TIP_KEY, "shown");
  } catch {
    return; // no storage (private window): skip the tip rather than repeat it every launch
  }
  useWorkspace.getState().notify(FUNCTION_KEY_TIP);
}

/** Also shown in the cheat sheet, so it is never lost if the one-time notice is missed. */
export const FUNCTION_KEY_TIP =
  "Sector keys F2–F12: hold fn, or turn on System Settings › Keyboard › “Use F1, F2, etc. " +
  "keys as standard function keys”. F11 is Show Desktop by default: turn it off in " +
  "Keyboard Shortcuts › Mission Control, or type CURNCY.";
