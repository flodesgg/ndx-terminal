/**
 * The keymap (SPEC §4.4–4.5): every key binding of the app lives in this one file. The cheat
 * sheet, the native macOS menu and the browser-mode alternates are generated from it, and a
 * unit test asserts no duplicate and no reserved chords.
 *
 * Chords name PHYSICAL keys (`KeyboardEvent.code`), so they work the same on the U.S.,
 * Russian – PC and Ukrainian layouts (§4.6): `Meta+KeyL` is ⌘L whatever the layout types.
 * Modifier order: Meta, Ctrl, Alt, Shift.
 */

export type Scope =
  /** Anywhere, including while typing in the command line. */
  | "global"
  /** Only while the command line has focus (handled by the command line itself). */
  | "command"
  /** Only while NOT typing in a text field (Option chords type characters there). */
  | "content";

export type Group = "Command line" | "Navigation" | "Windows" | "Sectors" | "Help";

export interface KeyBinding {
  action: string;
  chord: string;
  label: string;
  scope: Scope;
  group: Group;
  /** Native menu (Tauri) that owns this chord; its accelerator fires the action. */
  menu?: "View" | "Window" | "Go" | "Help";
  /** Browser mode: the chord to use instead, when the browser keeps `chord` for itself. */
  browser?: string;
  /** Declared now so the conflict test covers the whole §4.5 map; wired in that phase. */
  phase?: "1b";
  /** Shown once in the cheat sheet for a family of chords (e.g. ⌘1…9). */
  family?: string;
}

const SECTOR_F_KEYS: [string, string][] = [
  ["F2", "GOVT"],
  ["F3", "CORP"],
  ["F4", "MTGE"],
  ["F5", "M-MKT"],
  ["F6", "MUNI"],
  ["F7", "PFD"],
  ["F8", "EQUITY"],
  ["F9", "COMDTY"],
  ["F10", "INDEX"],
  ["F11", "CURNCY"],
  ["F12", "CLIENT"],
];

export const KEYMAP: readonly KeyBinding[] = [
  // ---- command line (§4.5, §4.7) ----
  { action: "go", chord: "Enter", label: "GO", scope: "command", group: "Command line" },
  {
    action: "go-new",
    chord: "Shift+Enter",
    label: "GO in a new tab",
    scope: "command",
    group: "Command line",
  },
  {
    action: "cancel",
    chord: "Escape",
    label: "CANCEL (clear, then back to content)",
    scope: "global",
    group: "Command line",
  },
  {
    action: "history-prev",
    chord: "ArrowUp",
    label: "Command history / previous suggestion",
    scope: "command",
    group: "Command line",
  },
  {
    action: "history-next",
    chord: "ArrowDown",
    label: "Command history / next suggestion",
    scope: "command",
    group: "Command line",
  },
  {
    action: "accept",
    chord: "Tab",
    label: "Accept the completion; with none open, focus content",
    scope: "command",
    group: "Command line",
  },
  {
    action: "focus-command",
    chord: "Meta+KeyL",
    label: "Focus command line",
    scope: "global",
    group: "Command line",
    menu: "View",
    browser: "Ctrl+Shift+KeyL",
  },
  {
    action: "focus-command",
    chord: "Slash",
    label: "Focus command line",
    scope: "content",
    group: "Command line",
  },
  {
    action: "back",
    chord: "Backspace",
    label: "BACK (on an empty command line)",
    scope: "command",
    group: "Navigation",
  },

  // ---- navigation ----
  {
    action: "back",
    chord: "Meta+BracketLeft",
    label: "BACK",
    scope: "global",
    group: "Navigation",
    menu: "Go",
    browser: "Ctrl+Shift+BracketLeft",
  },
  {
    action: "forward",
    chord: "Meta+BracketRight",
    label: "FORWARD",
    scope: "global",
    group: "Navigation",
    menu: "Go",
    browser: "Ctrl+Shift+BracketRight",
  },
  {
    action: "menu-up",
    chord: "Meta+ArrowUp",
    label: "MENU (up one level)",
    scope: "global",
    group: "Navigation",
    menu: "Go",
  },
  {
    action: "hint-mode",
    chord: "Meta+KeyJ",
    label: "Hint mode (jump to any clickable)",
    scope: "global",
    group: "Navigation",
    menu: "Go",
    browser: "Ctrl+Shift+KeyJ",
  },
  {
    action: "function-menu",
    chord: "Ctrl+Enter",
    label: "Function menu for the focused security",
    scope: "global",
    group: "Navigation",
  },

  // ---- windows ----
  {
    action: "next-window",
    chord: "Ctrl+Tab",
    label: "Next window",
    scope: "global",
    group: "Windows",
    menu: "Window",
    browser: "Ctrl+Shift+Period",
  },
  {
    action: "prev-window",
    chord: "Ctrl+Shift+Tab",
    label: "Previous window",
    scope: "global",
    group: "Windows",
    menu: "Window",
    browser: "Ctrl+Shift+Comma",
  },
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n): KeyBinding => ({
    action: `jump-window-${n}`,
    chord: `Meta+Digit${n}`,
    label: `Jump to window ${n}`,
    scope: "global",
    group: "Windows",
    menu: "Window",
    browser: `Ctrl+Shift+Digit${n}`,
    family: "Jump to window N",
  })),
  {
    action: "new-tab",
    chord: "Meta+KeyT",
    label: "New tab",
    scope: "global",
    group: "Windows",
    menu: "Window",
    browser: "Ctrl+Shift+KeyT",
  },
  {
    action: "close-tab",
    chord: "Meta+KeyW",
    label: "Close tab (the last tab closes the window)",
    scope: "global",
    group: "Windows",
    menu: "Window",
    browser: "Ctrl+Shift+KeyW",
  },
  {
    action: "reopen-tab",
    chord: "Meta+Shift+KeyT",
    label: "Reopen closed tab",
    scope: "global",
    group: "Windows",
    menu: "Window",
    browser: "Ctrl+Shift+KeyU",
  },
  {
    action: "maximize",
    chord: "Meta+Shift+Enter",
    label: "Maximize / restore window",
    scope: "global",
    group: "Windows",
    menu: "Window",
  },
  // Option chords: only outside text fields, where ⌥+key types characters (SPEC §4.5).
  {
    action: "split-right",
    chord: "Alt+Backslash",
    label: "Split window right",
    scope: "content",
    group: "Windows",
  },
  {
    action: "split-down",
    chord: "Alt+Minus",
    label: "Split window down",
    scope: "content",
    group: "Windows",
  },
  ...(["Left", "Up", "Right", "Down"] as const).flatMap((d): KeyBinding[] => [
    {
      action: `focus-${d.toLowerCase()}`,
      chord: `Alt+Arrow${d}`,
      label: "Move focus between windows",
      scope: "content",
      group: "Windows",
      family: "Move focus between windows",
    },
    {
      action: `resize-${d.toLowerCase()}`,
      chord: `Alt+Shift+Arrow${d}`,
      label: "Resize window",
      scope: "content",
      group: "Windows",
      family: "Resize window",
    },
  ]),
  {
    action: "toggle-tape",
    chord: "Alt+KeyT",
    label: "Toggle ticker tape",
    scope: "content",
    group: "Windows",
  },

  // ---- help ----
  {
    action: "help",
    chord: "F1",
    label: "HELP",
    scope: "global",
    group: "Help",
    menu: "Help",
  },
  {
    action: "help",
    chord: "Meta+Slash",
    label: "HELP",
    scope: "global",
    group: "Help",
    menu: "Help",
  },
  {
    action: "cheatsheet",
    chord: "Shift+Slash",
    label: "Shortcut cheat sheet (?)",
    scope: "content",
    group: "Help",
  },
  {
    action: "keyboard-overlay",
    chord: "Meta+Shift+KeyK",
    label: "Keyboard overlay",
    scope: "global",
    group: "Help",
    menu: "Help",
    phase: "1b",
  },

  // ---- sector keys (§4.4): a chip while typing, the sector menu otherwise ----
  ...SECTOR_F_KEYS.map(([key, token]): KeyBinding => ({
    action: `sector-${token}`,
    chord: key,
    label: token,
    scope: "global",
    group: "Sectors",
    menu: "Go",
  })),
];

/** Never bind (SPEC §4.5): system and input-source chords. */
export const RESERVED: readonly string[] = [
  "Meta+KeyQ",
  "Meta+KeyH",
  "Meta+KeyM",
  "Meta+Space",
  "Ctrl+Space",
  "Meta+Tab",
  "Meta+Backquote",
];

/** Chords a browser keeps for itself (pages cannot reliably take them over). */
export const BROWSER_RESERVED: readonly string[] = [
  "Meta+KeyT",
  "Meta+KeyW",
  "Meta+KeyN",
  "Meta+KeyL",
  "Meta+KeyR",
  "Meta+KeyJ", // browsers bind it (downloads / devtools families); hint mode uses ⌃⇧J there
  "Meta+Shift+KeyT",
  "Meta+Shift+KeyN",
  "Meta+BracketLeft",
  "Meta+BracketRight",
  "Ctrl+Tab",
  "Ctrl+Shift+Tab",
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `Meta+Digit${n}`),
];

// ---------- chords ----------

const MODS = ["Meta", "Ctrl", "Alt", "Shift"] as const;

/** Physical key code; falls back to `key` for synthetic events without a code. */
export function keyCode(e: Pick<KeyboardEvent, "code" | "key">): string {
  if (e.code) return e.code;
  const k = e.key;
  if (/^[a-z]$/i.test(k)) return `Key${k.toUpperCase()}`;
  if (/^[0-9]$/.test(k)) return `Digit${k}`;
  const map: Record<string, string> = {
    "\\": "Backslash",
    "-": "Minus",
    "/": "Slash",
    "?": "Slash",
    " ": "Space",
  };
  return map[k] ?? k;
}

export function chordOf(
  e: Pick<KeyboardEvent, "code" | "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
): string {
  const mods = [e.metaKey && "Meta", e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift"];
  return [...mods.filter(Boolean), keyCode(e)].join("+");
}

export function parseChord(chord: string): { mods: Set<string>; code: string } {
  const parts = chord.split("+");
  return { mods: new Set(parts.slice(0, -1)), code: parts[parts.length - 1]! };
}

/** True for a chord written in the canonical modifier order with a known modifier set. */
export function isWellFormed(chord: string): boolean {
  const parts = chord.split("+");
  const mods = parts.slice(0, -1);
  const order = mods.map((m) => MODS.indexOf(m as (typeof MODS)[number]));
  return (
    parts[parts.length - 1]!.length > 0 &&
    order.every((i, k) => i >= 0 && (k === 0 || i > order[k - 1]!))
  );
}

/** Option + a printable key: types a character inside text fields on macOS. */
export function typesInTextFields(chord: string): boolean {
  const { mods, code } = parseChord(chord);
  if (!mods.has("Alt") || mods.has("Meta") || mods.has("Ctrl")) return false;
  return !/^(Arrow|F\d|Enter|Escape|Tab|Backspace)/.test(code);
}

const SYMBOL: Record<string, string> = {
  Meta: "⌘",
  Ctrl: "⌃",
  Alt: "⌥",
  Shift: "⇧",
};
const KEY_LABEL: Record<string, string> = {
  Enter: "Enter",
  Escape: "Esc",
  Tab: "Tab",
  Backspace: "⌫",
  Slash: "/",
  Backslash: "\\",
  Minus: "-",
  Comma: ",",
  Period: ".",
  BracketLeft: "[",
  BracketRight: "]",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  Space: "Space",
  Equal: "=",
  Delete: "⌦",
  PageUp: "PgUp",
  PageDown: "PgDn",
};

/** `Meta+Shift+KeyK` → `⌘⇧K`; `Shift+Slash` → `?`. */
export function prettyChord(chord: string): string {
  if (chord === "Shift+Slash") return "?";
  if (chord === "Shift+Equal") return "+";
  const { mods, code } = parseChord(chord);
  const key = KEY_LABEL[code] ?? code.replace(/^Key|^Digit/, "");
  return `${MODS.filter((m) => mods.has(m))
    .map((m) => SYMBOL[m])
    .join("")}${key}`;
}

/**
 * Tauri (muda) accelerator for a chord: `Meta+Shift+Enter` → `Cmd+Shift+Enter`. muda parses
 * `KeyboardEvent.code` names (KeyL, Digit1, BracketLeft, ArrowUp, F8), so codes pass through.
 */
export function accelerator(chord: string): string {
  const { mods, code } = parseChord(chord);
  const names: Record<string, string> = { Meta: "Cmd", Ctrl: "Ctrl", Alt: "Alt", Shift: "Shift" };
  return [...MODS.filter((m) => mods.has(m)).map((m) => names[m]), code].join("+");
}

/** The chord in effect for a binding in this mode. */
export function effectiveChord(b: KeyBinding, browser: boolean): string {
  return browser && b.browser ? b.browser : b.chord;
}

export function scopesOverlap(a: Scope, b: Scope): boolean {
  return a === "global" || b === "global" || a === b;
}

// ---------- function (panel) hotkeys (§4.8: single-letter keys with content focused) ----------

/** One panel hotkey: the action a function's handler gets, and the physical keys for it. */
export interface PanelKey {
  action: string;
  chords: readonly string[];
  label: string;
  /** Shown once in the cheat sheet for a family of keys (e.g. timeframes 1 … 9). */
  family?: string;
}

const key = (action: string, chords: readonly string[], label: string): PanelKey => ({
  action,
  chords,
  label,
});
const select = (what: string): PanelKey[] => [
  key("up", ["ArrowUp", "KeyK"], `Select ${what}`),
  key("down", ["ArrowDown", "KeyJ"], `Select ${what}`),
];
const scroll: PanelKey[] = [key("up", ["ArrowUp"], "Scroll"), key("down", ["ArrowDown"], "Scroll")];
const pages: PanelKey[] = [
  key("page-up", ["PageUp"], "Page up / down"),
  key("page-down", ["PageDown"], "Page up / down"),
  key("top", ["KeyG"], "Top"),
  key("bottom", ["Shift+KeyG"], "Bottom"),
];
/** TOP and CN (SPEC §8 news). */
const NEWS_KEYS: PanelKey[] = [
  ...select("headline"),
  key("open", ["Enter"], "Open the original in your browser"),
  key("filter", ["KeyF"], "Text filter"),
  key("region", ["KeyR"], "Region filter: all → US → Europe → Denmark → Asia-Pacific"),
  key("asset", ["KeyA"], "Asset-class filter"),
  key("topic", ["KeyT"], "Topic filter"),
  key("mine", ["KeyW"], "Only tickers on my watchlists"),
  key("sort", ["KeyS"], "Rank / time order"),
  key("alert", ["KeyB"], "Add a keyword alert"),
  key("chart", ["KeyG"], "Chart of the first ticker"),
  key("company", ["KeyC"], "Company news of the first ticker"),
  key("refresh", ["Shift+KeyR"], "Refresh"),
];
const digits = (prefix: string, from: number, to: number, family: string): PanelKey[] =>
  Array.from({ length: to - from + 1 }, (_, i) => ({
    action: `${prefix}-${from + i}`,
    chords: [`Digit${from + i}`],
    label: family,
    family,
  }));
const cells = (vim: boolean): PanelKey[] =>
  (
    [
      ["up", "ArrowUp", "KeyK"],
      ["down", "ArrowDown", "KeyJ"],
      ["left", "ArrowLeft", "KeyH"],
      ["right", "ArrowRight", "KeyL"],
    ] as const
  ).map(([a, arrow, letter]) => key(a, vim ? [arrow, letter] : [arrow], "Move the selected cell"));

/**
 * Every function's own hotkeys. Handlers (`usePanelKeys`) receive the action, never the key, so
 * a key that is not listed here cannot reach a panel; the cheat sheet and the hint bar are
 * generated from the same entries.
 */
/** GP and GIP (the intraday chart) share one chart and its keys. */
/** MON and its alias W (SPEC §8). */
const MON_KEYS: PanelKey[] = [
  ...select("row"),
  key("first", ["Home", "KeyG"], "First row"),
  key("last", ["End", "Shift+KeyG"], "Last row"),
  key("prev-list", ["BracketLeft", "ArrowLeft"], "Previous / next list"),
  key("next-list", ["BracketRight", "ArrowRight"], "Previous / next list"),
  key("chart", ["Enter", "KeyC"], "Chart of the row"),
  key("des", ["KeyD"], "Description of the row"),
  key("quote", ["KeyQ"], "Quote of the row"),
  key("news", ["KeyN"], "News for the row"),
  key("sort", ["KeyS"], "Cycle sort column"),
  key("sort-dir", ["Shift+KeyS"], "Reverse sort"),
  key("unsort", ["KeyU"], "Unsorted (list order)"),
  key("move-down", ["Shift+ArrowDown", "Shift+KeyJ"], "Move row down (unsorted)"),
  key("move-up", ["Shift+ArrowUp", "Shift+KeyK"], "Move row up (unsorted)"),
  key("remove", ["Delete", "Backspace"], "Remove row (symbol or group)"),
  key("add", ["KeyA", "Insert"], "Add symbols or a #group (amber row)"),
  key("alert", ["KeyB"], "Alert on the row (bell)"),
  key("columns", ["KeyF"], "Choose columns (FLDS)"),
];

const FX_KEYS: PanelKey[] = [
  ...cells(true),
  key("chart", ["Enter"], "Chart of the selected pair"),
  key("quote", ["KeyQ"], "Quote of the selected pair"),
];

/** WEI-style boards: WEI, WFX, GLCO. */
const BOARD_KEYS: PanelKey[] = [
  ...select("row"),
  key("chart", ["Enter"], "Chart of the selected row"),
  key("quote", ["KeyQ"], "Quote of the selected row"),
];

const GP_KEYS: PanelKey[] = [
  ...digits("range", 1, 9, "Range 1D 5D 1M 3M 6M YTD 1Y 5Y MAX"),
  key("pan-left", ["ArrowLeft"], "Pan left / right"),
  key("pan-right", ["ArrowRight"], "Pan left / right"),
  key("zoom-in", ["Equal", "Shift+Equal"], "Zoom in"),
  key("zoom-out", ["Minus"], "Zoom out"),
  key("log", ["KeyL"], "Log scale"),
  key("indicators", ["KeyI"], "Studies menu"),
  key("menu-up", ["ArrowUp"], "Studies menu: select"),
  key("menu-down", ["ArrowDown"], "Studies menu: select"),
  key("menu-toggle", ["Enter", "Space"], "Studies menu: toggle"),
  key("reset", ["KeyR"], "Reset the view"),
  key("type", ["KeyT"], "Chart type candles / OHLC / line / area"),
  key("vol", ["KeyO"], "Volume"),
  key("draw", ["KeyD"], "Draw: horizontal, trend, rectangle, Fibonacci, text"),
  key("hline", ["KeyH"], "Horizontal line at cursor (or last)"),
  key("undo-draw", ["Backspace", "Delete"], "Remove the last drawing"),
  key("clear", ["KeyX"], "Clear drawings and lines"),
  key("fit", ["KeyF"], "Fit all"),
  key("save-template", ["KeyS"], "Save template: new GP windows open with this view"),
  key("compare", ["KeyC"], "Compare: add a security (up to 5, % from the window start)"),
];

export const PANEL_KEYMAP = {
  HELP: [...scroll, ...pages],
  KEYS: [
    ...select("binding"),
    key("change", ["Enter"], "Change the selected binding (then press the keys)"),
    key("reset", ["Backspace", "Delete"], "Restore its default"),
  ],
  PDF: [
    key("colors", ["KeyC"], "Cycle the colour palette"),
    key("yfinance", ["KeyY"], "Toggle yfinance (opt-in, personal use)"),
    key("news", ["KeyN"], "Add a news feed (RSS/Atom URL)"),
  ],
  MENU: [
    ...select("row"),
    key("open", ["Enter"], "Run the selected row"),
    key("parent", ["Backspace"], "Up one level"),
  ],
  LOG: [...scroll, ...pages],
  FLDS: [...scroll, ...pages],
  PROV: [...scroll, ...pages],
  W: MON_KEYS,
  MON: MON_KEYS,
  GP: GP_KEYS,
  GIP: GP_KEYS,
  HP: [...select("row"), ...pages, key("chart", ["Enter"], "Chart of the same window")],
  DES: [...scroll, key("web", ["KeyW"], "Open the company website in your browser")],
  FA: [
    ...digits("tab", 1, 4, "Income / balance / cash flow / ratios"),
    key("annual", ["KeyA"], "Annual"),
    key("quarterly", ["KeyQ"], "Quarterly"),
    key("export", ["KeyE"], "Export CSV to ~/Downloads"),
    ...scroll,
  ],
  N: [...select("row"), key("open", ["Enter"], "Open the selected row")],
  TOP: NEWS_KEYS,
  CN: NEWS_KEYS,
  FX: FX_KEYS,
  FXC: FX_KEYS,
  CDR: [...select("venue")],
  WEI: BOARD_KEYS,
  WFX: BOARD_KEYS,
  GLCO: BOARD_KEYS,
  EQS: [
    key("filter", ["KeyF"], "Focus the filter form (Tab between fields, Enter applies)"),
    ...select("row"),
    key("chart", ["Enter"], "Chart of the row"),
    key("des", ["KeyD"], "Description of the row"),
    key("add", ["KeyA"], "Add the row to the watchlist"),
    key("sort", ["KeyS"], "Cycle sort field"),
    key("sort-dir", ["Shift+KeyS"], "Reverse sort"),
  ],
  ECO: [
    ...select("release"),
    key("country", ["KeyC"], "Country: all → US → euro area → … → all"),
    key("importance", ["KeyI"], "Importance: all → ●● and up → ●●● only"),
    key("range", ["KeyD"], "Dates: week → today → next 2 weeks → past week"),
    key("next", ["KeyN"], "Select the next release"),
    key("open", ["Enter"], "History of the release's series (ECST, new window)"),
    key("refresh", ["Shift+KeyR"], "Refresh"),
  ],
  ECST: [
    ...select("series"),
    ...digits("range", 1, 4, "Range: 2Y, 5Y, 10Y, MAX"),
    key("refresh", ["Shift+KeyR"], "Refresh"),
  ],
  CF: [
    ...digits("filter", 0, 5, "Filter: all, 10-K, 10-Q, 8-K, Form 4, proxy"),
    ...select("filing"),
    key("open", ["Enter"], "Open the filing in your browser"),
  ],
  INS: [...select("row")],
  JRNL: [
    ...select("trade"),
    key("new", ["KeyN"], "New trade (focus the amber fields)"),
    key("edit", ["Enter"], "Edit the selected trade"),
    key("delete", ["Backspace", "Delete"], "Delete the selected trade"),
  ],
  PORT: [
    ...select("row"),
    key("trades", ["KeyT"], "Toggle positions / trade log"),
    key("chart", ["Enter"], "Chart of the position"),
    key("import", ["KeyI"], "Import trades from a CSV file"),
    key("delete", ["Backspace", "Delete"], "Delete the selected trade"),
    key("refresh", ["KeyR"], "Refresh"),
  ],
  ALRT: [
    ...select("alert"),
    key("delete", ["Backspace", "Delete"], "Delete the selected alert"),
    key("rearm", ["KeyR"], "Re-arm the selected alert"),
    key("test", ["KeyT"], "Send a test notification"),
  ],
  NOTE: [
    key("edit", ["KeyE", "KeyI"], "Edit (Esc leaves the editor)"),
    key("preview", ["KeyP"], "Toggle Markdown preview"),
    ...select("note"),
    key("open", ["Enter"], "Open the selected note"),
  ],
  BT: [
    ...select("script"),
    key("run", ["Enter"], "Run the selected script"),
    key("args", ["KeyA"], "Edit script arguments"),
  ],
  CORR: [...cells(false), key("chart", ["Enter"], "Chart of the row symbol")],
  CRYPTO: [
    ...select("coin"),
    key("chart", ["Enter"], "Chart of the Binance USDT pair"),
    key("des", ["KeyD"], "Description of the Binance USDT pair"),
    key("quote", ["KeyQ"], "Quote of the Binance USDT pair"),
  ],
} as const satisfies Record<string, readonly PanelKey[]>;

export type PanelFn = keyof typeof PANEL_KEYMAP;

export function panelKeys(fn: string): readonly PanelKey[] {
  return (PANEL_KEYMAP as Record<string, readonly PanelKey[]>)[fn] ?? [];
}

/** The action a function's keymap gives this chord, if any. */
export function panelAction(fn: string, chord: string): string | undefined {
  return panelKeys(fn).find((k) => k.chords.includes(chord))?.action;
}

/** Cheat-sheet rows for one function: entries with one label merge; families show first … last. */
export function panelCheatsheetRows(fn: string): { keys: string; description: string }[] {
  const groups = new Map<string, PanelKey[]>();
  for (const k of panelKeys(fn)) groups.set(k.label, [...(groups.get(k.label) ?? []), k]);
  return [...groups.entries()].map(([label, ks]) => {
    if (ks[0]!.family) {
      const first = prettyChord(ks[0]!.chords[0]!);
      const last = prettyChord(ks[ks.length - 1]!.chords[0]!);
      return { keys: `${first} … ${last}`, description: label };
    }
    const width = Math.max(...ks.map((k) => k.chords.length));
    const chords: string[] = [];
    for (let i = 0; i < width; i++) for (const k of ks) if (k.chords[i]) chords.push(k.chords[i]!);
    return { keys: chords.map(prettyChord).join(" "), description: label };
  });
}
