/**
 * The one visual tokens file (SPEC §4.2). CSS reads these as `--<name>` custom properties
 * (applied to :root before the first render); canvas code (charts) reads them via `token()`.
 * Change a colour here and nowhere else.
 */

export const TOKENS = {
  // §4.2 starting values
  bg: "#000000",
  "bg-panel": "#0A0A0A",
  "bg-row-alt": "#101010",
  "grid-line": "#222222",
  amber: "#FFA028",
  "amber-field-bg": "#FFA028",
  "amber-field-fg": "#000000",
  value: "#E8E8E8",
  up: "#00D26A",
  down: "#FF3B3B",
  link: "#4FC3F7",
  "title-bar-bg": "#7A0F0F",
  "title-bar-fg": "#FFFFFF",
  toolbar: "#2A2A2A",
  dim: "#6B6B6B",
  focus: "#FFA028",
  "flash-up": "rgba(0, 210, 106, 0.35)",
  "flash-down": "rgba(255, 59, 59, 0.35)",
  "cb-up": "#56B4E9",
  "cb-down": "#D55E00",
  // Supporting values not in the §4.2 table (kept here so no colour lives elsewhere)
  "grid-line-strong": "#3A3A3A",
  "amber-dim": "#B07020",
  "amber-mute": "#7A6040",
  "value-dim": "#8C8C8C",
  warn: "#FACC15",
  "err-bg": "#3A0D0D",
  "err-fg": "#FECACA",
  "on-amber": "#000000",
  "sel-bg": "#2A1A05",
  "header-hl": "#1A1206",
  "bg-hover": "#121212",
  "bg-sunken": "#070707",
  "chart-grid": "#161616",
  track: "#1C1C1C",
  "range-fill": "#3A2A10",
  "tag-eod": "#A3A3A3",
  "tag-cache": "#6B7280",
  "dot-closed": "#444444",
  "dot-idle": "#777777",
  overlay: "rgba(0, 0, 0, 0.7)",
  "amber-wash": "rgba(255, 160, 40, 0.1)",
  "amber-strong": "rgba(255, 160, 40, 0.85)",
  // Chart series palette (indicator overlays)
  "series-1": "#FACC15",
  "series-2": "#F97316",
  "series-3": "#A855F7",
  "series-4": "#38BDF8",
  "series-5": "#E879F9",
  "series-6": "#64748B",
  "series-7": "#F472B6",
  // Window link colours (SPEC §4.9): the dot in each window head
  "link-red": "#E5484D",
  "link-green": "#30A46C",
  "link-blue": "#3E8EF7",
  "link-yellow": "#F5D90A",
} as const;

export type TokenName = keyof typeof TOKENS;

export const FONTS = {
  mono: '"JetBrains Mono", "IBM Plex Mono", ui-monospace, Menlo, monospace',
  title: '"IBM Plex Sans Condensed", "Arial Narrow", sans-serif',
  size: "12px",
  rowHeight: "19px",
} as const;

/** Legacy variable names used across styles.css, mapped onto the tokens above. */
export const ALIASES: Record<string, TokenName> = {
  "bg-1": "bg-panel",
  "bg-2": "bg-row-alt",
  "bg-3": "grid-line",
  line: "grid-line",
  "line-2": "grid-line-strong",
  fg: "amber",
  "fg-dim": "amber-dim",
  "fg-mute": "amber-mute",
  text: "value",
  "text-dim": "value-dim",
  accent: "link",
};

/**
 * `PDF COLORS` (SPEC §7, §4.2): the colour-blind palette swaps the up/down colours (and their
 * tick flashes) for the `cb-up` / `cb-down` tokens, and links are also underlined (an up value is
 * then blue like a link). Everything else stays.
 */
export const COLOR_SCHEMES = ["STANDARD", "COLORBLIND"] as const;
export type ColorScheme = (typeof COLOR_SCHEMES)[number];

const SWAPS: Record<ColorScheme, Partial<Record<TokenName, TokenName>>> = {
  STANDARD: {},
  COLORBLIND: { up: "cb-up", down: "cb-down" },
};
let scheme: ColorScheme = "STANDARD";

export function colorScheme(): ColorScheme {
  return scheme;
}

/** Switch the palette; CSS variables follow at once (open charts on their next draw). */
export function setColorScheme(s: ColorScheme): void {
  scheme = s;
  if (typeof document !== "undefined") applyTokens();
}

export function token(name: TokenName): string {
  return TOKENS[SWAPS[scheme][name] ?? name];
}

/** A hex token at the given alpha, for canvas fills (heatmaps, volume bars). */
export function withAlpha(name: TokenName, alpha: number): string {
  const hex = token(name);
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) throw new Error(`token ${name} is not a hex colour`);
  const [r, g, b] = [m[1], m[2], m[3]].map((x) => parseInt(x!, 16));
  return `rgba(${r},${g},${b},${Math.max(0, Math.min(1, alpha)).toFixed(3)})`;
}

/** All custom properties: tokens, aliases (as var() references) and fonts. */
export function cssVariables(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of Object.keys(TOKENS) as TokenName[]) out[`--${k}`] = token(k);
  if (scheme !== "STANDARD") {
    out["--flash-up"] = withAlpha("up", 0.35);
    out["--flash-down"] = withAlpha("down", 0.35);
  }
  for (const [alias, target] of Object.entries(ALIASES)) out[`--${alias}`] = `var(--${target})`;
  out["--font"] = FONTS.mono;
  out["--font-title"] = FONTS.title;
  out["--fs"] = FONTS.size;
  out["--row-h"] = FONTS.rowHeight;
  return out;
}

export function applyTokens(root: HTMLElement = document.documentElement): void {
  for (const [k, v] of Object.entries(cssVariables())) root.style.setProperty(k, v);
  root.dataset.colors = scheme; // styles.css: colour-blind mode also underlines links (§4.2)
}
