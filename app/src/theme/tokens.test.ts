/// <reference types="node" />
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ALIASES, TOKENS, applyTokens, cssVariables, token, withAlpha } from "./tokens";

// Every non-test source file under src/, as text (Vite glob, no Node APIs needed).
const RAW = import.meta.glob<string>(["../**/*.{ts,tsx,css}", "!../**/*.test.{ts,tsx}"], {
  query: "?raw",
  import: "default",
  eager: true,
});
// Vitest stubs CSS modules (even `?raw`) to "": read stylesheets from disk so the guards below
// really scan them.
const SOURCES = Object.entries(RAW).map(([p, text]) => {
  const path = p.replace(/^\.\.\//, "").replace(/^\.\//, "theme/");
  return { path, text: path.endsWith(".css") ? readFileSync(`src/${path}`, "utf8") : text };
});

function grepLines(text: string, path: string, re: RegExp, skip?: (line: string) => boolean) {
  return text
    .split("\n")
    .map((line, i) => ({ line, i }))
    .filter(({ line }) => re.test(line) && !(skip?.(line) ?? false))
    .map(({ line, i }) => `${path}:${i + 1}: ${line.trim()}`);
}

describe("tokens (SPEC §4.2)", () => {
  it("carries the §4.2 starting values", () => {
    expect(TOKENS.bg).toBe("#000000");
    expect(TOKENS["bg-panel"]).toBe("#0A0A0A");
    expect(TOKENS["bg-row-alt"]).toBe("#101010");
    expect(TOKENS["grid-line"]).toBe("#222222");
    expect(TOKENS.amber).toBe("#FFA028");
    expect(TOKENS.value).toBe("#E8E8E8");
    expect(TOKENS.up).toBe("#00D26A");
    expect(TOKENS.down).toBe("#FF3B3B");
    expect(TOKENS.link).toBe("#4FC3F7");
    expect(TOKENS["title-bar-bg"]).toBe("#7A0F0F");
    expect(TOKENS.toolbar).toBe("#2A2A2A");
    expect(TOKENS.dim).toBe("#6B6B6B");
    expect(TOKENS["cb-up"]).toBe("#56B4E9");
    expect(TOKENS["cb-down"]).toBe("#D55E00");
  });

  it("exposes every token and alias as a CSS variable", () => {
    const vars = cssVariables();
    for (const k of Object.keys(TOKENS)) expect(vars[`--${k}`]).toBe(token(k as never));
    for (const [alias, target] of Object.entries(ALIASES)) {
      expect(vars[`--${alias}`]).toBe(`var(--${target})`);
      expect(TOKENS).toHaveProperty(target);
    }
    const el = document.createElement("div");
    applyTokens(el);
    expect(el.style.getPropertyValue("--amber")).toBe("#FFA028");
  });

  it("withAlpha derives canvas colours from tokens", () => {
    expect(withAlpha("up", 0.35)).toBe("rgba(0,210,106,0.350)");
    expect(() => withAlpha("overlay", 0.5)).toThrow();
  });

  it("every var(--x) used in the UI is defined", () => {
    const defined = new Set(Object.keys(cssVariables()).map((k) => k.slice(2)));
    const missing = SOURCES.flatMap(({ path, text }) =>
      [...text.matchAll(/var\(--([a-z0-9-]+)/g)]
        .map((m) => m[1]!)
        .filter((n) => !defined.has(n))
        .map((n) => `${path}: --${n}`),
    );
    expect(missing).toEqual([]);
  });

  it("focus outline uses the focus token and the tick flash lasts 300 ms (review 1a #29/#35)", () => {
    const css = SOURCES.find((x) => x.path === "styles.css")!.text;
    expect(css).toMatch(/\.panel\.active:focus \{\s*border-color: var\(--focus\)/);
    expect(css).toMatch(/flash-up \{\s*animation: flashUp 0\.3s/);
    expect(css).toMatch(/flash-down \{\s*animation: flashDown 0\.3s/);
  });

  it("scans the UI sources", () => {
    expect(SOURCES.length).toBeGreaterThan(50);
    expect(SOURCES.some((s) => s.path === "styles.css")).toBe(true);
  });

  it("no colour literal lives outside the tokens file", () => {
    const hits = SOURCES.filter(({ path }) => path !== "theme/tokens.ts").flatMap(
      ({ path, text }) => grepLines(text, path, /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/),
    );
    expect(hits).toEqual([]);
  });
});

describe("formatting only through shared formatters (SPEC §4.2)", () => {
  it("no ad-hoc number/date formatting outside lib/format.ts", () => {
    const allowed = new Set(["lib/format.ts", "theme/tokens.ts"]);
    const pattern =
      /\.toFixed\(|\.toLocaleString\(|\.toLocaleDateString\(|\.toLocaleTimeString\(|Intl\.(NumberFormat|DateTimeFormat)/;
    const hits = SOURCES.filter(({ path }) => !allowed.has(path)).flatMap(({ path, text }) =>
      grepLines(text, path, pattern, (line) => line.includes("format-ok:")),
    );
    expect(hits).toEqual([]);
  });

  it("no em-dash placeholders for missing values (N.A. instead)", () => {
    const hits = SOURCES.flatMap(({ path, text }) =>
      grepLines(text, path, /["'`>]—["'`<]|\?\? "—"|: "—"/),
    );
    expect(hits).toEqual([]);
  });
});
