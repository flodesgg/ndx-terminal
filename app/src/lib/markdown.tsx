/**
 * Minimal Markdown → React renderer for notes. Produces React elements only (no innerHTML),
 * so note content can never inject markup. Supports: # headings, - / 1. lists, > quotes,
 * ``` code blocks, `code`, **bold**, *italic*, [links](https://…), horizontal rules.
 */
import type { ReactNode } from "react";

type InlineToken =
  | { t: "text"; v: string }
  | { t: "code"; v: string }
  | { t: "b"; v: string }
  | { t: "i"; v: string }
  | { t: "a"; v: string; href: string };

const INLINE = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*)|(\[[^\]]+\]\((https?:\/\/[^)\s]+)\))/g;

export function tokenizeInline(s: string): InlineToken[] {
  const out: InlineToken[] = [];
  let last = 0;
  for (const m of s.matchAll(INLINE)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push({ t: "text", v: s.slice(last, idx) });
    const [full] = m;
    if (m[1]) out.push({ t: "code", v: full.slice(1, -1) });
    else if (m[2]) out.push({ t: "b", v: full.slice(2, -2) });
    else if (m[3]) out.push({ t: "i", v: full.slice(1, -1) });
    else if (m[4]) out.push({ t: "a", v: full.slice(1, full.indexOf("]")), href: m[5]! });
    last = idx + full.length;
  }
  if (last < s.length) out.push({ t: "text", v: s.slice(last) });
  return out;
}

function inline(s: string, onLink: (href: string) => void): ReactNode[] {
  return tokenizeInline(s).map((tok, i) => {
    switch (tok.t) {
      case "code":
        return (
          <code key={i} className="cyan">
            {tok.v}
          </code>
        );
      case "b":
        return <b key={i}>{tok.v}</b>;
      case "i":
        return <i key={i}>{tok.v}</i>;
      case "a":
        return (
          <a key={i} onClick={() => onLink(tok.href)} title={tok.href}>
            {tok.v}
          </a>
        );
      default:
        return <span key={i}>{tok.v}</span>;
    }
  });
}

export function Markdown({ text, onLink }: { text: string; onLink: (href: string) => void }) {
  const lines = text.split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith("```")) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.startsWith("```")) body.push(lines[i++]!);
      i++;
      blocks.push(
        <pre
          key={blocks.length}
          className="log"
          style={{ background: "var(--bg-panel)", border: "1px solid var(--line)" }}
        >
          {body.join("\n")}
        </pre>,
      );
      continue;
    }
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
      const size = [16, 14, 13][h[1]!.length - 1];
      blocks.push(
        <div
          key={blocks.length}
          style={{ color: "var(--fg)", fontWeight: 700, fontSize: size, margin: "8px 0 4px" }}
        >
          {inline(h[2]!, onLink)}
        </div>,
      );
      i++;
      continue;
    }
    if (/^(-{3,}|\*{3,})$/.test(line.trim())) {
      blocks.push(
        <hr key={blocks.length} style={{ border: 0, borderTop: "1px solid var(--line-2)" }} />,
      );
      i++;
      continue;
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i]!)) {
        items.push(lines[i]!.replace(/^\s*([-*]|\d+\.)\s+/, ""));
        i++;
      }
      const Tag = ordered ? "ol" : "ul";
      blocks.push(
        <Tag key={blocks.length} style={{ margin: "2px 0", paddingLeft: 22 }}>
          {items.map((it, j) => (
            <li key={j}>{inline(it, onLink)}</li>
          ))}
        </Tag>,
      );
      continue;
    }
    if (line.startsWith(">")) {
      blocks.push(
        <div
          key={blocks.length}
          style={{
            borderLeft: "2px solid var(--fg-dim)",
            paddingLeft: 8,
            color: "var(--text-dim)",
          }}
        >
          {inline(line.replace(/^>\s?/, ""), onLink)}
        </div>,
      );
      i++;
      continue;
    }
    blocks.push(
      line.trim() ? (
        <p key={blocks.length} style={{ margin: "2px 0" }}>
          {inline(line, onLink)}
        </p>
      ) : (
        <div key={blocks.length} style={{ height: 6 }} />
      ),
    );
    i++;
  }
  return <div style={{ color: "var(--text)", lineHeight: 1.5 }}>{blocks}</div>;
}
