/**
 * Hint mode (SPEC §4.8, ⌘J): a 1–2 letter label on every clickable element on screen; typing a
 * label activates it. Letters match physical keys (`KeyboardEvent.code`), so it works on the
 * Russian – PC and Ukrainian layouts too.
 */
import { create } from "zustand";
import { keyCode } from "./keymap";

const LETTERS = "ASDFGHJKLQWERTYUIOPZXCVBNM";

/** `n` labels, single letters while they last, otherwise prefix-free pairs (max 676). */
export function hintLabels(n: number): string[] {
  const L = LETTERS.length;
  if (n <= L) return [...LETTERS.slice(0, n)];
  const singles = Math.max(0, Math.floor((L * L - n) / (L - 1)));
  const out = [...LETTERS.slice(0, singles)];
  for (const p of LETTERS.slice(singles)) for (const q of LETTERS) out.push(p + q);
  return out.slice(0, n);
}

const CLICKABLE = 'button, a[href], input, select, textarea, [role="button"], .tab, [data-hint]';

export interface HintTarget {
  label: string;
  el: HTMLElement;
  x: number;
  y: number;
}

export const useHints = create<{ targets: HintTarget[] | null; typed: string }>(() => ({
  targets: null,
  typed: "",
}));

function visible(el: HTMLElement): DOMRect | null {
  if (el.closest(".hint-layer, [aria-hidden='true']")) return null;
  if ((el as HTMLButtonElement).disabled) return null;
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return null;
  if (r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) return null;
  return r;
}

export function startHints(root: ParentNode = document): number {
  const els = [...root.querySelectorAll<HTMLElement>(CLICKABLE)]
    .map((el) => ({ el, r: visible(el) }))
    .filter((t): t is { el: HTMLElement; r: DOMRect } => t.r !== null);
  const labels = hintLabels(Math.min(els.length, LETTERS.length ** 2));
  useHints.setState({
    targets: labels.map((label, i) => ({
      label,
      el: els[i]!.el,
      x: els[i]!.r.left,
      y: els[i]!.r.top,
    })),
    typed: "",
  });
  return labels.length;
}

export function stopHints(): void {
  useHints.setState({ targets: null, typed: "" });
}

function activate(el: HTMLElement): void {
  if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el.isContentEditable) {
    el.focus();
    return;
  }
  if (el instanceof HTMLTextAreaElement) {
    el.focus();
    return;
  }
  // Tabs and window heads react on mousedown; buttons on click.
  for (const type of ["mousedown", "mouseup"]) {
    el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 }));
  }
  el.click();
}

/** While hint mode is on it takes every key. Returns true when the key was consumed. */
export function hintKey(e: Pick<KeyboardEvent, "code" | "key">): boolean {
  const { targets, typed } = useHints.getState();
  if (!targets) return false;
  if (e.key === "Escape") {
    stopHints();
    return true;
  }
  if (e.key === "Backspace") {
    useHints.setState({ typed: typed.slice(0, -1) });
    return true;
  }
  const m = /^Key([A-Z])$/.exec(keyCode(e));
  if (!m) return true;
  const next = typed + m[1];
  const hit = targets.find((t) => t.label === next);
  if (hit) {
    stopHints();
    activate(hit.el);
  } else if (targets.some((t) => t.label.startsWith(next))) {
    useHints.setState({ typed: next });
  } else {
    stopHints();
  }
  return true;
}
