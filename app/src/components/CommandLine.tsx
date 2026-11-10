/**
 * The command line (SPEC §4.3, §4.7): typed text plus chips. A sector key or an accepted
 * completion turns into a coloured chip (sector, security, function); autocomplete is local and
 * synchronous (security index + registry), so it works offline and keeps up with typing.
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Schemas } from "@/core/api";
import { complete, type Completion } from "@/core/command/autocomplete";
import { hasCyrillic, layoutFixed } from "@/core/command/layouts";
import { normalizeInput } from "@/core/command/parser";
import { executeCommand, parseInContext } from "@/core/executor";
import { focusContent, focusPanelMode, setCommandInput, setSectorInserter } from "@/core/keys";
import { activePanel, useWorkspace } from "@/core/layout/store";
import { usePdf } from "@/core/pdf";
import { functionEntries, lookupInfo, notBuilt } from "@/core/registry";
import { isExchangeCode, onSecIndex, secIndex } from "@/core/secindex";
import { SECTORS } from "@/core/secmaster";
import { sectorToken, type SectorToken } from "@/core/sectors";

const SECURITY_SECTORS: ReadonlySet<string> = new Set(SECTORS);
import { recentTickers, rememberTicker } from "@/lib/recent";

/** Notices longer than this wrap in a box under the command line instead of being cut off. */
const LONG_NOTICE = 70;

export interface Chip {
  kind: "sector" | "security" | "function";
  text: string;
}

/**
 * Chips + typed text → the command to run. A sector chip goes after the typed ticker and its
 * exchange code, if one was typed (`[CURNCY] eurusd gp` → `eurusd CURNCY gp`, `[EQUITY] aapl us
 * des` → `aapl us EQUITY des`), or stands alone as the sector menu. Typed text keeps its case:
 * the parser normalizes it, and search and the Cyrillic layout fix need the original (§4.3, §4.6).
 */
export function composeCommand(chips: readonly Chip[], text: string): string {
  const typed = text.trim().split(/\s+/).filter(Boolean);
  const sector = chips.find((c) => c.kind === "sector");
  const rest = chips.filter((c) => c.kind !== "sector").map((c) => c.text);
  if (sector && !rest.length && typed.length) {
    // The exchange may be typed on a Cyrillic layout (`ффзд гы вуы` = aapl us des, #17).
    const exch = typed[1]?.toUpperCase() ?? "";
    const isExch = isExchangeCode(exch) || (hasCyrillic(exch) && isExchangeCode(layoutFixed(exch)));
    const at = typed.length > 1 && isExch ? 2 : 1;
    return [...typed.slice(0, at), sector.text, ...typed.slice(at)].join(" ");
  }
  return [...(sector && !rest.length ? [sector.text] : []), ...rest, ...typed].join(" ");
}

/** After accepting a completion: what parses as security / function becomes chips. */
export function chipify(command: string, sector?: SectorToken): { chips: Chip[]; text: string } {
  const p = parseInContext(command);
  if (p.kind === "security") return { chips: [{ kind: "security", text: p.security }], text: "" };
  if (p.kind === "function" && !p.fixed) {
    const chips: Chip[] = [];
    if (p.security && p.security !== activePanel()?.ticker) {
      chips.push({ kind: "security", text: p.security });
    }
    chips.push({ kind: "function", text: p.fn });
    return { chips, text: p.args.length ? `${p.args.join(" ")} ` : "" };
  }
  if (p.kind === "sector") return { chips: [{ kind: "sector", text: p.sector }], text: "" };
  return { chips: sector ? [{ kind: "sector", text: sector }] : [], text: `${command} ` };
}

/**
 * Candidates for an ambiguous or unknown security, as completion rows that keep the rest of the
 * command (`XYZ GP` → `XYZ GY EQUITY GP`, `XYZ LN EQUITY GP`).
 */
export function pickerRows(command: string, ids: readonly string[]): Completion[] {
  const t = normalizeInput(command);
  const isSector = (w: string | undefined) => !!w && SECURITY_SECTORS.has(w);
  const n = isSector(t[2]) ? 3 : isSector(t[1]) || (t[1] && isExchangeCode(t[1])) ? 2 : 1;
  const rest = t.slice(n);
  const ix = secIndex();
  return ids.map((id, i) => {
    const item = ix.byId.get(id);
    return {
      key: `pick:${id}`,
      kind: "SECURITY" as const,
      label: id,
      desc: item ? `${item.name || "N.A."}${item.exchange ? ` · ${item.exchange}` : ""}` : "",
      insert: [id, ...rest].join(" "),
      sector: item?.sector,
      score: 1000 - i,
    };
  });
}

/** One command line per window (SPEC §4.9 classic mode); it runs commands in its window. */
export function CommandLine({ winId }: { winId: string }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [chips, setChips] = useState<Chip[]>([]);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sel, setSel] = useState(-1);
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();
  const historyQ = useQuery({
    queryKey: ["history"],
    queryFn: () => api.get<Schemas["HistoryEntry"][]>("/history"),
    staleTime: Infinity,
    select: (h) => h.map((x) => x.command),
  });
  const history = historyQ.data ?? [];
  const setHistory = (fn: (h: string[]) => string[]) =>
    queryClient.setQueryData<Schemas["HistoryEntry"][]>(["history"], (old) =>
      fn((old ?? []).map((x) => x.command)).map((command) => ({ command, ts: null })),
    );
  const active = useWorkspace((s) => s.activeId === winId);
  const focusWindow = useWorkspace((s) => s.focus);
  /** After an ambiguous or unknown security: its candidates, as a picker (§4.3 rule 6). */
  const [picks, setPicks] = useState<Completion[] | null>(null);
  const [histIdx, setHistIdx] = useState(-1);
  // What was typed before ↑ started browsing history; ↓ past the newest entry restores it.
  const draft = useRef<{ text: string; chips: Chip[] } | null>(null);
  const focusTick = useWorkspace((s) => s.focusCommandTick);
  const message = useWorkspace((s) => s.message);
  const index = useSyncExternalStore(onSecIndex, secIndex);
  const layouts = useQuery({
    queryKey: ["layouts"],
    queryFn: () => api.get<Schemas["Layout"][]>("/layouts"),
    staleTime: 60_000,
  });
  const notes = useQuery({
    queryKey: ["notes"],
    queryFn: () => api.get<Schemas["Note"][]>("/notes"),
    staleTime: 60_000,
  });

  // The active window's command line is the one the keyboard dispatcher talks to.
  useEffect(() => {
    if (!active) return;
    setCommandInput(inputRef.current);
    // Sector keys while typing insert a sector chip that filters autocomplete (SPEC §4.4).
    setSectorInserter((token) => {
      const s = sectorToken(token);
      if (!s) return;
      setChips((c) => [...c.filter((x) => x.kind !== "sector"), { kind: "sector", text: s }]);
      setOpen(true);
    });
    return () => {
      setCommandInput(null);
      setSectorInserter(null);
    };
  }, [active]);

  // Becoming the active window moves typing here: on launch, and from another command line (⌘2).
  useEffect(() => {
    if (!active) return;
    const el = document.activeElement;
    if (el === document.body || (el !== inputRef.current && el?.hasAttribute("data-cmd-input"))) {
      inputRef.current?.focus();
    }
  }, [active]);

  // ⌘L / "/" / Esc from the content: focus and select.
  useEffect(() => {
    if (!active || focusTick === 0) return;
    inputRef.current?.focus();
    inputRef.current?.select();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusTick]);

  const sectorChip = chips.find((c) => c.kind === "sector")?.text as SectorToken | undefined;
  const otherChips = chips.filter((c) => c.kind !== "sector");
  const functions = useMemo(() => functionEntries(), []);
  const layoutNames = useMemo(() => (layouts.data ?? []).map((l) => l.name), [layouts.data]);
  const noteNames = useMemo(() => (notes.data ?? []).map((n) => n.symbol), [notes.data]);

  const suggestions = useMemo<Completion[]>(() => {
    if (!open) return [];
    if (picks) return picks;
    const prefix = otherChips.map((c) => c.text).join(" ");
    const query = prefix ? `${prefix} ${text}` : text;
    if (!query.trim() && !sectorChip) return [];
    return complete(query, {
      lookup: lookupInfo,
      notBuilt,
      loaded: activePanel()?.ticker,
      defaultExchange: usePdf.getState().pdf.defaultExchange,
      index,
      functions,
      recent: recentTickers(),
      layouts: layoutNames,
      notes: noteNames,
      sector: sectorChip,
    });
    // otherChips is derived from chips
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, picks, chips, text, index, functions, layoutNames, noteNames, sectorChip]);

  useEffect(() => {
    setSel(-1);
  }, [text, chips]);

  function clearAll() {
    setPicks(null);
    setChips([]);
    setText("");
    setError(null);
  }

  /** Tab / click: the completion replaces the token being typed and becomes chips. */
  function accept(s: Completion): string {
    const typed = normalizeInput(text);
    const before = /\s$/.test(text) ? typed : typed.slice(0, -1);
    const prefix = otherChips.map((c) => c.text);
    // A security, layout, note, search or layout-fixed command is complete in itself; a function,
    // sector or argument completes what is already there.
    const whole =
      s.kind === "FIXED" ||
      s.kind === "LAYOUT" ||
      s.kind === "NOTE" ||
      s.kind === "SECURITY" ||
      s.kind === "SEARCH";
    const command = whole ? s.insert : [...prefix, ...before, s.insert].join(" ");
    const next = chipify(command, s.kind === "SECURITY" ? undefined : sectorChip);
    setPicks(null);
    setChips(next.chips);
    setText(next.text);
    return composeCommand(next.chips, next.text);
  }

  async function run(command: string, newPanel: boolean) {
    const trimmed = command.trim();
    if (!trimmed) return;
    // Clear immediately: commands may await the backend and the user keeps typing.
    const kept = { chips, text };
    clearAll();
    setOpen(false);
    setHistIdx(-1);
    const parsed = parseInContext(trimmed);
    const res = await executeCommand(trimmed, { newPanel });
    if (!res.ok) {
      const more = res.suggestions?.length ? ` — ${res.suggestions.slice(0, 4).join(" · ")}` : "";
      setError(`${res.error ?? "error"}${res.hint ? ` · ${res.hint}` : ""}${more}`);
      // Give the failed command back for editing unless something new was typed meanwhile.
      setText((cur) => {
        if (cur !== "") return cur;
        setChips(kept.chips);
        if (res.suggestions?.length) {
          setPicks(pickerRows(trimmed, res.suggestions));
          setOpen(true);
        }
        return kept.text;
      });
      return;
    }
    if (parsed.kind === "function" && parsed.security) rememberTicker(parsed.security);
    if (parsed.kind === "security") rememberTicker(parsed.security);
    const shown = trimmed;
    setHistory((h) => [shown, ...h.filter((x) => x !== shown)]);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    const hasSuggest = suggestions.length > 0;
    if (e.key === "/" && !text && !chips.length) {
      // "/" is the focus key; don't type it into an empty command line.
      e.preventDefault();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) return; // function menu / maximize: not GO
      const command =
        hasSuggest && sel >= 0 ? accept(suggestions[sel]!) : composeCommand(chips, text);
      void run(command, e.shiftKey);
      return;
    }
    if (e.key === "Tab") {
      e.preventDefault();
      if (hasSuggest) accept(suggestions[Math.max(0, sel)]!);
      else focusContent();
      return;
    }
    if (e.key === "Backspace" && !text && chips.length) {
      e.preventDefault();
      setChips((c) => c.slice(0, -1));
      return;
    }
    if (e.key === "Backspace" && !text && !e.metaKey && !e.altKey && !e.ctrlKey) {
      // §4.5: Backspace on an empty command line = BACK in this window.
      e.preventDefault();
      useWorkspace.getState().back();
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (e.altKey || e.metaKey) return; // window bindings
      e.preventDefault();
      const down = e.key === "ArrowDown";
      if (hasSuggest && histIdx < 0) {
        setSel((i) => {
          const n = suggestions.length;
          return down ? (i + 1) % n : i <= 0 ? n - 1 : i - 1;
        });
        return;
      }
      // ↓ while not browsing history does nothing: it never erases the typed command (#19).
      if (down && histIdx < 0) return;
      const next = down ? histIdx - 1 : histIdx + 1;
      if (next < 0) {
        setHistIdx(-1);
        setChips(draft.current?.chips ?? []);
        setText(draft.current?.text ?? "");
        draft.current = null;
        return;
      }
      if (next >= history.length) return;
      if (histIdx < 0) draft.current = { text, chips };
      setHistIdx(next);
      setChips([]);
      setText(history[next]!);
      setOpen(false);
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      // §4.5 CANCEL: the 1st Esc clears the command line, the 2nd closes a popup / leaves.
      if (text || chips.length) clearAll();
      else if (hasSuggest) setOpen(false);
      else focusPanelMode();
    }
  }

  const showMsg = active && !error && message && Date.now() - message.at < 12_000;

  return (
    <div className={`cmd${active ? " on" : ""}`} data-testid="command-line">
      <span className="cmd-prompt">&gt;</span>
      {chips.map((c, i) => (
        <span key={`${c.kind}:${c.text}:${i}`} className={`chip chip-${c.kind}`} data-testid="chip">
          {c.text}
        </span>
      ))}
      <input
        ref={inputRef}
        data-cmd-input=""
        value={text}
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="characters"
        placeholder={
          chips.length
            ? ""
            : active
              ? "SECURITY FUNCTION  ·  e.g. AAPL US EQUITY GP · WEI · HELP   ( / to focus · ? for keys )"
              : ""
        }
        onChange={(e) => {
          setText(e.target.value);
          setPicks(null);
          setHistIdx(-1);
          setOpen(true);
          setError(null);
        }}
        onBlur={() => setOpen(false)}
        onFocus={() => {
          focusWindow(winId);
          setOpen(true);
        }}
        onKeyDown={onKeyDown}
      />
      {error ? (
        <span className="cmd-error" title={error}>
          {error}
        </span>
      ) : null}
      {showMsg ? (
        <span
          className={`${message.kind === "error" ? "cmd-error" : "cmd-info"}${message.text.length > LONG_NOTICE ? " cmd-note" : ""}`}
          data-testid="cmd-message"
          title={message.text}
        >
          {message.text}
        </span>
      ) : null}
      {suggestions.length > 0 ? (
        <div className="suggest" data-testid="suggest">
          {suggestions.map((s, i) => (
            <div
              key={s.key}
              className={`suggest-row${i === sel ? " sel" : ""}`}
              onMouseDown={(e) => {
                e.preventDefault();
                accept(s);
                inputRef.current?.focus();
              }}
            >
              <span className="code">{s.label}</span>
              <span className="desc">
                {s.desc}
                {s.primary ? <span className="tag-primary"> PRIMARY</span> : null}
              </span>
              <span className="kind">
                {s.sector ? <span className={`chip chip-sector-mini`}>{s.sector}</span> : null}
                {s.kind}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
