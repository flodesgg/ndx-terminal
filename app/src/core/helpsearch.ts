/**
 * Help search (SPEC §4.4: F1 twice): every function's generated help page plus the help topics
 * (Data sources notices, keys). A hit needs every typed word somewhere in the page.
 */
import type { PanelSpec } from "./layout/tree";
import { NOTICES } from "./notices";
import { allFunctions, helpText } from "./registry";

export interface HelpHit {
  label: string;
  desc: string;
  target: PanelSpec;
}

interface Page {
  label: string;
  desc: string;
  text: string;
  target: PanelSpec;
}

/** Help topics besides the function pages; the HELP index numbers them 1, 2, 3. */
export const HELP_TOPICS: readonly { label: string; desc: string; target: PanelSpec }[] = [
  {
    label: "Data sources",
    desc: "Providers, attributions and required notices",
    target: { fn: "HELP", args: ["SOURCES"] },
  },
  {
    label: "Help search",
    desc: "Search every help page (F1 twice)",
    target: { fn: "HELP", args: ["SEARCH"] },
  },
  { label: "Keys", desc: "Every key binding; remap them (KEYS)", target: { fn: "KEYS", args: [] } },
];

function pages(): Page[] {
  const sources = NOTICES.map((n) => `${n.source} ${n.use} ${n.text}`).join(" ");
  return [
    ...allFunctions().map((f) => ({
      label: f.code,
      desc: f.name,
      text: helpText(f).join(" "),
      target: { fn: "HELP", args: [f.code] },
    })),
    { ...HELP_TOPICS[0]!, text: `data sources notices attribution ${sources}` },
    { ...HELP_TOPICS[2]!, text: "keys keymap shortcuts bindings remap cheat sheet hotkeys" },
  ];
}

export function helpSearch(query: string): HelpHit[] {
  const words = query.toUpperCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const hits = pages()
    .map((p) => ({ p, upper: p.text.toUpperCase() }))
    .filter(({ upper }) => words.every((w) => upper.includes(w)))
    .map(({ p }) => {
      const exact = p.label.toUpperCase() === words.join(" ");
      const inTitle = words.every((w) => `${p.label} ${p.desc}`.toUpperCase().includes(w));
      return { p, score: exact ? 2 : inTitle ? 1 : 0 };
    });
  hits.sort((a, b) => b.score - a.score || a.p.label.localeCompare(b.p.label));
  return hits.map(({ p }) => ({ label: p.label, desc: p.desc, target: p.target }));
}
