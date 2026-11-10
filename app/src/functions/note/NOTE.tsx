import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, errorMessage, type Schemas } from "@/core/api";
import { executeCommand } from "@/core/executor";
import { usePanelKeys } from "@/core/keys";
import { registerFunction, type PanelProps } from "@/core/registry";
import { ErrorBanner, Loading } from "@/components/DataStatus";
import { fmtTime, relTime } from "@/lib/format";
import { Markdown } from "@/lib/markdown";
import { openExternal } from "@/lib/open";
import { NAValue } from "@/components/V";

type Note = Schemas["Note"];

function Editor({ id, symbol }: { id: string; symbol: string }) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["note", symbol],
    queryFn: () => api.get<Note>(`/notes/${encodeURIComponent(symbol)}`),
  });
  const [text, setText] = useState<string | null>(null);
  const [preview, setPreview] = useState(false);
  const [status, setStatus] = useState<"saved" | "dirty" | "saving" | "error">("saved");
  const [err, setErr] = useState<string | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const body = text ?? q.data?.body ?? "";

  useEffect(() => {
    if (text == null || status !== "dirty") return;
    const t = setTimeout(() => {
      setStatus("saving");
      api
        .put<Note>(`/notes/${encodeURIComponent(symbol)}`, { body: text })
        .then((n) => {
          qc.setQueryData(["note", symbol], n);
          void qc.invalidateQueries({ queryKey: ["notes"] });
          setStatus("saved");
          setErr(null);
        })
        .catch((e: unknown) => {
          setStatus("error");
          setErr(errorMessage(e));
        });
    }, 700);
    return () => clearTimeout(t);
  }, [text, status, symbol, qc]);

  usePanelKeys(id, "NOTE", (a) => {
    if (a === "edit") {
      setPreview(false);
      setTimeout(() => area.current?.focus(), 0);
    } else if (a === "preview") setPreview((p) => !p);
    else return false;
    return true;
  });

  if (q.isLoading) return <Loading what={`${symbol} note`} />;
  return (
    <>
      {q.error ? <ErrorBanner error={q.error} /> : null}
      <div className="toolbar">
        <span className="amber">{symbol} NOTES</span>
        <button className={!preview ? "on" : ""} onClick={() => setPreview(false)}>
          EDIT
        </button>
        <button className={preview ? "on" : ""} onClick={() => setPreview(true)}>
          PREVIEW
        </button>
        <span className={status === "error" ? "down" : "dim"} style={{ marginLeft: "auto" }}>
          {status === "saved"
            ? q.data?.updated_at
              ? `saved ${fmtTime(q.data.updated_at, true)}`
              : "not saved yet"
            : status === "error"
              ? `SAVE FAILED: ${err}`
              : status === "saving"
                ? "saving…"
                : "unsaved changes"}
        </span>
      </div>
      {preview ? (
        <div className="sel-text" style={{ overflow: "auto", flex: 1, padding: "4px 10px" }}>
          {body.trim() ? (
            <Markdown text={body} onLink={(u) => void openExternal(u)} />
          ) : (
            <div className="empty">Empty note.</div>
          )}
        </div>
      ) : (
        <textarea
          ref={area}
          value={body}
          spellCheck={false}
          placeholder={`# ${symbol} thesis\n- why I'm interested\n- catalysts\n- risks\n- levels to watch`}
          onChange={(e) => {
            setText(e.target.value);
            setStatus("dirty");
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              (e.target as HTMLTextAreaElement).blur();
              document.querySelector<HTMLElement>(`[data-panel-id="${id}"]`)?.focus();
            }
          }}
          style={{
            flex: 1,
            resize: "none",
            border: "none",
            background: "var(--bg-panel)",
            color: "var(--text)",
            padding: "6px 10px",
            lineHeight: 1.5,
            userSelect: "text",
          }}
        />
      )}
      <div className="ds hint">
        E edit · Esc leave editor · P preview · autosaves · Markdown: # ** * ` - [link](https://…)
      </div>
    </>
  );
}

function NoteList({ id }: { id: string }) {
  const q = useQuery({ queryKey: ["notes"], queryFn: () => api.get<Note[]>("/notes") });
  const [sel, setSel] = useState(0);
  const rows = q.data ?? [];
  usePanelKeys(id, "NOTE", (a) => {
    if (a === "down") setSel((s) => Math.min(rows.length - 1, s + 1));
    else if (a === "up") setSel((s) => Math.max(0, s - 1));
    else if (a === "open" && rows[sel]) void executeCommand(`${rows[sel].symbol} NOTE`);
    else return false;
    return true;
  });
  if (q.isLoading) return <Loading what="notes" />;
  return (
    <>
      {q.error ? <ErrorBanner error={q.error} /> : null}
      <div style={{ overflow: "auto", flex: 1 }}>
        <table className="grid">
          <thead>
            <tr>
              <th className="l">SYMBOL</th>
              <th className="l">FIRST LINE</th>
              <th>UPDATED</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((n, i) => (
              <tr
                key={n.symbol}
                className={i === sel ? "sel" : ""}
                onMouseDown={() => setSel(i)}
                onDoubleClick={() => void executeCommand(`${n.symbol} NOTE`)}
              >
                <td className="l amber">{n.symbol}</td>
                <td className="l" style={{ color: "var(--text)" }}>
                  {n.body
                    .split("\n")
                    .find((l) => l.trim())
                    ?.replace(/^#+\s*/, "")
                    .slice(0, 100)}
                </td>
                <td className="dim">
                  {n.updated_at ? `${relTime(n.updated_at)} ago` : <NAValue />}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length ? <div className="empty">No notes yet. Open one with AAPL NOTE.</div> : null}
      </div>
    </>
  );
}

function NOTE({ id, panel }: PanelProps) {
  return panel.ticker ? <Editor id={id} symbol={panel.ticker} /> : <NoteList id={id} />;
}

export function registerNOTE(): void {
  registerFunction({
    code: "NOTE",
    name: "Notes",
    description: "Markdown research notes attached to a ticker (autosaved locally)",
    ticker: "optional",
    syntax: "NOTE · <TICKER> NOTE",
    examples: ["NOTE", "AAPL US EQUITY NOTE"],
    category: "Tools",
    sectors: ["EQUITY", "INDEX", "COMDTY", "CURNCY", "CLIENT"],
    menu: ["Notes"],
    args: [],
    actions: [],
    component: NOTE,
  });
}
