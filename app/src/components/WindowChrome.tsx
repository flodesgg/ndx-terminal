/**
 * Window anatomy (SPEC §4.1) around a function's content: title-bar items 95–97, the toolbar
 * (back/forward, the function's own numbered items, 98 Note, 99 Help, link dot), the hint bar
 * and the 95/96/97 menus. Numbers here are the same ones `N` + Enter runs (core/items.ts).
 */
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { formatCommand } from "@/core/command/parser";
import { runItem, usePopup, windowItems, windowView } from "@/core/items";
import { chordLabel, useEffectiveKeymap } from "@/core/keyedit";
import { panelCheatsheetRows } from "@/core/keymap";
import { focusPanelMode } from "@/core/keys";
import { LINK_COLORS, type LinkColor, type Win } from "@/core/layout/session";
import { useWorkspace } from "@/core/layout/store";
import { getFunction, validateArgs, type FunctionDef } from "@/core/registry";
import { exporterFor, tablesToCsv } from "@/lib/export";
import { recentFunctions, recentTickers } from "@/lib/recent";
import { menuFor, recentFunctionTarget, recentSecurityTarget } from "@/core/recentnav";
import type { PanelSpec } from "@/core/layout/tree";

function nextLink(l: LinkColor): LinkColor {
  return LINK_COLORS[(LINK_COLORS.indexOf(l) + 1) % LINK_COLORS.length]!;
}

function ItemButton({
  winId,
  n,
  label,
  menu,
}: {
  winId: string;
  n: number;
  label: string;
  menu?: boolean;
}) {
  return (
    <button
      type="button"
      className="item"
      data-item={n}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={() => runItem(winId, n)}
    >
      <span className="item-n">{n})</span> {label}
      {menu ? " ▾" : ""}
    </button>
  );
}

/** Title-bar items 95 Actions ▾, 96 Export ▾, 97 Settings. */
export function TitleItems({ winId }: { winId: string }) {
  return (
    <span className="title-items" data-testid="title-items">
      <ItemButton winId={winId} n={95} label="Actions" menu />
      <ItemButton winId={winId} n={96} label="Export" menu />
      <ItemButton winId={winId} n={97} label="Settings" />
    </span>
  );
}

/** Toolbar: ◀ ▶, the function's numbered items, 98 Note, 99 Help, link colour. */
export function WinToolbar({ win }: { win: Win }) {
  useEffectiveKeymap(); // tooltips show the current chords after a KEYS edit
  const setLink = useWorkspace((s) => s.setLink);
  // Re-render when the view changes (items depend on the security).
  useWorkspace((s) => s.session.windows[win.id]);
  const tab = win.tabs[win.activeTab]!;
  const own = windowItems(win.id).filter((i) => i.n < 95 && !i.content);
  const inWin = (f: () => void) => {
    useWorkspace.getState().focus(win.id);
    f();
  };
  const go = (dir: "back" | "forward") => {
    const ws = useWorkspace.getState();
    ws.focus(win.id);
    ws[dir]();
  };
  return (
    <div className="win-tools" data-testid="win-toolbar" onMouseDown={(e) => e.stopPropagation()}>
      <button
        type="button"
        title={`MENU: this security's functions, else the main menu (${chordLabel("function-menu")}; ${chordLabel("menu-up")} up one level)`}
        data-testid="tool-menu"
        onClick={() => inWin(() => useWorkspace.getState().open(menuFor(windowView(win.id))))}
      >
        Menu
      </button>
      <button
        type="button"
        title={`BACK (${chordLabel("back")})`}
        disabled={tab.at <= 0}
        onClick={() => go("back")}
      >
        ◀
      </button>
      <button
        type="button"
        title={`FORWARD (${chordLabel("forward")})`}
        disabled={tab.at >= tab.history.length - 1}
        onClick={() => go("forward")}
      >
        ▶
      </button>
      <button
        type="button"
        data-testid="tool-recent-sec"
        title="Recent securities"
        onClick={() => inWin(() => usePopup.getState().open(win.id, "recent-sec"))}
      >
        recent securities ▾
      </button>
      <button
        type="button"
        data-testid="tool-recent-fn"
        title="Recent functions"
        onClick={() => inWin(() => usePopup.getState().open(win.id, "recent-fn"))}
      >
        recent functions ▾
      </button>
      {own.length ? <span className="sep" /> : null}
      {own.map((i) => (
        <ItemButton key={i.n} winId={win.id} n={i.n} label={i.label} />
      ))}
      <span className="grow" />
      <ItemButton winId={win.id} n={98} label="Note" />
      <ItemButton winId={win.id} n={99} label="Help" />
      <span className="dim">link</span>
      <button
        type="button"
        className={`link-dot link-${win.link}`}
        data-testid="link-dot"
        title={`Link: ${win.link.toUpperCase()} (click to change, or LINK <colour>)`}
        onClick={() => setLink(nextLink(win.link), win.id)}
      />
    </div>
  );
}

/** Hint bar: how to move focus, plus the function's own hotkeys (from the keymap). */
export function HintBar({ fn }: { fn: string }) {
  useEffectiveKeymap(); // chords follow KEYS edits at once
  const own = panelCheatsheetRows(fn);
  const text = [
    "Tab → content",
    "Esc → command line",
    "N+Enter item",
    `${chordLabel("hint-mode")} hints`,
    `${chordLabel("help")} help`,
    ...own.map((r) => `${r.keys} ${r.description}`),
  ].join(" · ");
  return (
    <div className="win-hints" data-testid="hint-bar" title={text}>
      {text}
    </div>
  );
}

// ---------- 95 / 96 / 97 menus ----------

interface Entry {
  key: string;
  label: string;
  run: () => void;
}

function MenuList({ entries, title }: { entries: Entry[]; title: string }) {
  const [sel, setSel] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    box.current?.querySelector<HTMLElement>("button")?.focus();
  }, []);
  const onKey = (e: ReactKeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      usePopup.getState().close();
      focusPanelMode();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const n = entries.length;
      const next = (sel + (e.key === "ArrowDown" ? 1 : -1) + n) % n;
      setSel(next);
      box.current?.querySelectorAll<HTMLElement>("button")[next]?.focus();
      e.preventDefault();
    }
  };
  return (
    <div ref={box} onKeyDown={onKey}>
      <div className="section-title">{title}</div>
      {entries.map((e, i) => (
        <button
          key={e.key}
          type="button"
          className={`menu-row${i === sel ? " on" : ""}`}
          onFocus={() => setSel(i)}
          onClick={() => {
            usePopup.getState().close();
            e.run();
          }}
        >
          <span className="item-n">{e.key}</span> {e.label}
        </button>
      ))}
    </div>
  );
}

function actionEntries(winId: string): Entry[] {
  const ws = () => useWorkspace.getState();
  const inWin = (f: () => void) => () => {
    ws().focus(winId);
    f();
  };
  return [
    ...windowItems(winId)
      .filter((i) => i.n < 95 && !i.content)
      .map((i) => ({ key: `${i.n})`, label: i.label, run: () => runItem(winId, i.n) })),
    { key: "⌘T", label: "New tab", run: inWin(() => ws().newTab()) },
    { key: "⌘⇧⏎", label: "Maximize / restore", run: inWin(() => ws().toggleMax()) },
    { key: "POP", label: "Send to the workspace", run: inWin(() => ws().pop()) },
    { key: "⌘W", label: "Close tab", run: inWin(() => ws().closeActive()) },
  ];
}

function exportEntries(winId: string, fn: string): Entry[] {
  const notify = useWorkspace.getState().notify;
  const copy = (text: string, done: string) =>
    navigator.clipboard.writeText(text).then(
      () => notify(done),
      () => notify("Clipboard not available", "error"),
    );
  return [
    {
      key: "CSV",
      label: "Copy visible tables as CSV",
      run: () => {
        const own = exporterFor(winId);
        if (own) {
          void own().then(
            ({ csv, rows, note }) =>
              rows
                ? copy(csv, `Copied ${rows} rows of ${fn} as CSV${note ? ` (${note})` : ""}`)
                : notify(`Nothing to export: ${fn} has no rows`, "error"),
            (e: unknown) => notify(`Export failed: ${String(e)}`, "error"),
          );
          return;
        }
        const body = document.querySelector(`[data-panel-id="${winId}"] .panel-body`);
        const { csv, rows } = body ? tablesToCsv(body) : { csv: "", rows: 0 };
        if (!rows) notify(`Nothing to export: ${fn} shows no table here`, "error");
        else void copy(csv, `Copied ${rows} rows of ${fn} as CSV`);
      },
    },
    {
      key: "CMD",
      label: "Copy this window's command",
      run: () => {
        const v = windowView(winId);
        if (v) void copy(formatCommand(v), "Command copied");
      },
    },
  ];
}

function recentEntries(winId: string, kind: "recent-sec" | "recent-fn"): Entry[] {
  const v = windowView(winId);
  const open = (p: PanelSpec) => {
    const ws = useWorkspace.getState();
    ws.focus(winId);
    ws.open(p);
  };
  const list = kind === "recent-sec" ? recentTickers() : recentFunctions();
  return list.slice(0, 15).map((x, i) => ({
    key: `${i + 1}`,
    label: x,
    run: () =>
      open(kind === "recent-sec" ? recentSecurityTarget(v, x) : recentFunctionTarget(v, x)),
  }));
}

/** 97 Settings: the function's arguments as an amber field; Enter applies, Esc reverts. */
function Settings({ winId, def }: { winId: string; def: FunctionDef }) {
  const v = windowView(winId)!;
  const initial = v.args.join(" ");
  const [text, setText] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => field.current?.focus(), []);
  if (!def.args.length) {
    return (
      <div>
        <div className="section-title">97) SETTINGS — {def.code}</div>
        <div className="dim menu-note">{def.code} has no settings (it takes no arguments).</div>
      </div>
    );
  }
  const apply = () => {
    const args = text.toUpperCase().split(/\s+/).filter(Boolean);
    const bad = validateArgs(def, args);
    if (bad) {
      setError(bad);
      return;
    }
    useWorkspace.getState().updateLeaf(winId, { ...v, args });
    usePopup.getState().close();
    focusPanelMode();
  };
  return (
    <div>
      <div className="section-title">97) SETTINGS — {def.code}</div>
      <label className="menu-note">
        Arguments{" "}
        <input
          ref={field}
          className="amber-field"
          data-amber-field
          data-testid="settings-field"
          value={text}
          spellCheck={false}
          onChange={(e) => {
            setText(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              apply();
            } else if (e.key === "Escape") {
              e.preventDefault();
              if (text !== initial) setText(initial);
              else usePopup.getState().close();
            }
          }}
        />
      </label>
      {error ? <div className="down menu-note">{error}</div> : null}
      <div className="dim menu-note">
        {def.args.map((a) => (
          <div key={a.name}>
            {a.name}: {[...(a.values ?? []), ...(a.form ? [a.form] : [])].join(" ") || a.help}
          </div>
        ))}
        Enter applies · Esc reverts, then closes
      </div>
    </div>
  );
}

function RecentList({ winId, kind }: { winId: string; kind: "recent-sec" | "recent-fn" }) {
  const entries = recentEntries(winId, kind);
  const title = kind === "recent-sec" ? "RECENT SECURITIES" : "RECENT FUNCTIONS";
  if (!entries.length) {
    return (
      <div tabIndex={-1} ref={(el) => el?.focus()} onKeyDown={closeOnEsc}>
        <div className="section-title">{title}</div>
        <div className="dim menu-note">None yet.</div>
      </div>
    );
  }
  return <MenuList title={title} entries={entries} />;
}

function closeOnEsc(e: ReactKeyboardEvent) {
  if (e.key !== "Escape") return;
  e.preventDefault();
  usePopup.getState().close();
  focusPanelMode();
}

export function WinPopup({ winId }: { winId: string }) {
  const popup = usePopup((s) => (s.popup?.winId === winId ? s.popup : null));
  const v = useWorkspace((s) => s.session.windows[winId]) && windowView(winId);
  const def = v && getFunction(v.fn);
  if (!popup || !def || !v) return null;
  return (
    <div
      className="win-popup"
      data-testid={`popup-${popup.kind}`}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {popup.kind === "recent-sec" || popup.kind === "recent-fn" ? (
        <RecentList winId={winId} kind={popup.kind} />
      ) : popup.kind === "actions" ? (
        <MenuList title={`95) ACTIONS — ${def.code}`} entries={actionEntries(winId)} />
      ) : popup.kind === "export" ? (
        <MenuList title={`96) EXPORT — ${def.code}`} entries={exportEntries(winId, def.code)} />
      ) : (
        <Settings winId={winId} def={def} />
      )}
    </div>
  );
}
