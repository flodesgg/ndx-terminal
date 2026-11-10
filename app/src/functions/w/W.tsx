/** MON (alias W) — monitors (SPEC §8): live lists as tabs, columns from FLDS, group headers. */
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { api, type Schemas } from "@/core/api";
import { hasCyrillic } from "@/core/command/layouts";
import { useApi, useApiMany } from "@/core/data";
import { executeCommand } from "@/core/executor";
import { usePanelKeys } from "@/core/keys";
import { visibleIds, winView } from "@/core/layout/session";
import { activePanel, useWorkspace } from "@/core/layout/store";
import { useQuoteStates, useQuoteSubscriptions, type QuoteState } from "@/core/live";
import { anyText, registerFunction, type FunctionDef, type PanelProps } from "@/core/registry";
import { ErrorBanner, LatencyTag, Loading } from "@/components/DataStatus";
import { Sgn, V } from "@/components/V";
import { tickerDragProps } from "@/lib/dragTicker";
import { registerExporter } from "@/lib/export";
import { bookIsEstimated, freshnessLabel } from "@/lib/freshness";
import { NA } from "@/lib/format";
import { isClosed } from "@/functions/wei/rows";
import { describeAlert, parseCondition } from "@/functions/alrt/ALRT";
import {
  DEFAULT_COLS,
  colLabel,
  colsKey,
  displayRows,
  fieldValue,
  MASTER_FIELDS,
  type MasterRecord,
  fmtField,
  headerName,
  insertRows,
  isHeader,
  MAX_COLS,
  monCsv,
  moveRow,
  parseAdd,
  parseCols,
  sortBy,
  type FieldInfo,
} from "./mon";
import {
  createList,
  deleteList,
  findList,
  setSymbols,
  useWatchlists,
  watchlistClient,
  type Watchlist,
} from "./watchlists";

type Alert = Schemas["Alert"];
type Profile = Schemas["Profile"];
type SessionState = Schemas["SessionStateItem"];

interface Sort {
  /** "ticker" or a FLDS id */
  col: string;
  desc: boolean;
}

function useFlashes(symbols: readonly string[], quotes: Map<string, QuoteState>) {
  const prev = useRef(new Map<string, number>());
  const flashes = useRef(new Map<string, { dir: "up" | "down"; n: number }>());
  for (const s of symbols) {
    const last = quotes.get(s)?.quote?.price;
    const p = prev.current.get(s);
    if (last != null && p != null && last !== p) {
      const f = flashes.current.get(s);
      flashes.current.set(s, { dir: last > p ? "up" : "down", n: (f?.n ?? 0) + 1 });
    }
    if (last != null) prev.current.set(s, last);
  }
  return flashes.current;
}

function Bell({ state }: { state: "none" | "armed" | "fired" }) {
  return (
    <svg width="9" height="10" viewBox="0 0 9 10" aria-hidden="true">
      <path
        d="M4.5 0.5a3 3 0 0 0-3 3v2.6L0.5 7.8h8L7.5 6.1V3.5a3 3 0 0 0-3-3zM3.3 8.6a1.2 1.2 0 0 0 2.4 0"
        fill={state === "none" ? "none" : "currentColor"}
        stroke="currentColor"
        strokeWidth="0.9"
      />
    </svg>
  );
}

const keyOf = (s: string) => s.toUpperCase();
/** Fixed widths: a narrow window scrolls sideways instead of squeezing a column to nothing. */
const colWidth = (f: FieldInfo) => (f.kind === "text" ? 150 : f.kind === "time" ? 66 : 84);

function MON({ id, panel, update, active }: PanelProps) {
  const qc = useQueryClient();
  const lists = useWatchlists();
  const name = panel.args[0];
  const list: Watchlist | undefined = useMemo(() => {
    const all = lists.data ?? [];
    return (name ? all.find((l) => l.name === name.toUpperCase()) : undefined) ?? all[0];
  }, [lists.data, name]);
  const rows = useMemo(() => list?.rows ?? [], [list]);
  const symbols = useMemo(() => rows.filter((r) => !isHeader(r)), [rows]);

  // ---- columns: FLDS ids, chosen per list and kept in user.db ----
  const fieldsQ = useApi<Schemas["FieldsResponse"]>("/fields", undefined, { staleMs: 600_000 });
  const fieldById = useMemo(
    () => new Map((fieldsQ.data?.fields ?? []).map((f) => [f.id, f])),
    [fieldsQ.data],
  );
  const cKey = list ? colsKey(list.id) : null;
  const colsQ = useQuery({
    queryKey: ["settings", cKey],
    queryFn: () => api.get<unknown>(`/settings/${encodeURIComponent(cKey!)}`),
    enabled: !!cKey,
    staleTime: Infinity,
  });
  const colIds = useMemo(
    () => parseCols(colsQ.data, fieldById.size ? new Set(fieldById.keys()) : null),
    [colsQ.data, fieldById],
  );
  const cols: FieldInfo[] = useMemo(
    () => colIds.map((c) => fieldById.get(c)).filter((f): f is FieldInfo => !!f),
    [colIds, fieldById],
  );
  const saveCols = async (next: string[]) => {
    if (!cKey) return;
    const v = { cols: next.slice(0, MAX_COLS) };
    qc.setQueryData(["settings", cKey], v);
    try {
      await api.put(`/settings/${encodeURIComponent(cKey)}`, v);
    } catch (e) {
      useWorkspace.getState().notify(`Columns not saved: ${String(e)}`, "error");
    }
  };

  // ---- live data ----
  const quotes = useQuoteStates(symbols);
  const flashes = useFlashes(symbols, quotes);

  const [sort, setSort] = useState<Sort | null>(null);
  // Profiles load for the rows on screen, which depend on the order: sorting reads the ones of
  // the previous render.
  const profRef = useRef(new Map<string, Profile>());
  const masterRef = useRef(new Map<string, MasterRecord>());
  const valueFor = (s: string, col: string): number | string | null => {
    if (col === "ticker") return s;
    const f = fieldById.get(col);
    if (!f) return null;
    const v = fieldValue(
      f,
      quotes.get(s)?.quote,
      profRef.current.get(keyOf(s)),
      masterRef.current.get(keyOf(s)),
    );
    return typeof v === "number" || typeof v === "string" ? v : null;
  };
  const shown = displayRows(rows, sort ? sortBy((s) => valueFor(s, sort.col), sort.desc) : null);

  const [selRow, setSelRow] = useState<string | null>(null);
  const selIdx = Math.max(
    0,
    shown.findIndex((r) => r.row === selRow),
  );
  const sel = shown[selIdx];
  const selSymbol = sel?.kind === "sym" ? sel.row : undefined;
  const setSel = (i: number) => {
    const r = shown[Math.max(0, Math.min(shown.length - 1, i))];
    if (r) setSelRow(r.row);
  };

  const scrollRef = useRef<HTMLDivElement>(null);
  const virt = useVirtualizer({
    count: shown.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 18,
    overscan: 10,
  });
  // Subscribe only to the rows the virtualizer renders (SPEC §6.3).
  const onScreen = virt
    .getVirtualItems()
    .map((v) => shown[v.index])
    .filter((r): r is NonNullable<typeof r> => r?.kind === "sym")
    .map((r) => r.row);
  useQuoteSubscriptions(onScreen, active ? "focus" : "watch");
  useEffect(() => {
    if (shown.length) virt.scrollToIndex(selIdx);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selIdx]);

  // Profile fields (fundamentals, sector…) only for rows on screen, only when such a column is
  // shown; the server keeps profiles for days, so scrolling back costs nothing.
  const needProfile = cols.some(
    (f) => f.domain !== "quotes" && !["name", "currency", "exchange"].includes(f.id),
  );
  const profQ = useApiMany<Schemas["ProfileResponse"]>(
    needProfile ? onScreen.map((s) => `/profile/${encodeURIComponent(s)}`) : [],
    undefined,
    { staleMs: 3_600_000 },
  );
  const profiles = new Map<string, Profile>();
  profQ.forEach((q, i) => {
    if (q.data) profiles.set(keyOf(onScreen[i]!), q.data.data);
  });
  profRef.current = profiles;
  // Name, currency, exchange: the local security master when neither quote nor profile says.
  const needMaster = cols.some((f) => MASTER_FIELDS.includes(f.id));
  // The endpoint takes 200 symbols a request; a list holds up to 300 (two requests).
  const masterA = useApi<Schemas["SecurityLookup"][]>(
    needMaster && symbols.length ? "/secmaster/securities" : null,
    { symbols: symbols.slice(0, 200).join(",") },
    { staleMs: 3_600_000 },
  );
  const masterB = useApi<Schemas["SecurityLookup"][]>(
    needMaster && symbols.length > 200 ? "/secmaster/securities" : null,
    { symbols: symbols.slice(200).join(",") },
    { staleMs: 3_600_000 },
  );
  const master = useMemo(
    () =>
      new Map<string, MasterRecord>(
        [...(masterA.data ?? []), ...(masterB.data ?? [])].flatMap((l) =>
          l.record ? [[keyOf(l.symbol), l.record]] : [],
        ),
      ),
    [masterA.data, masterB.data],
  );
  masterRef.current = master;

  // Closed and holiday markets are dimmed (as in WEI); unknown venues are not.
  const statesQ = useApi<Schemas["SessionStatesResponse"]>(
    symbols.length ? "/calendar/state" : null,
    { symbols: symbols.slice(0, 200).join(",") },
    { refetchMs: 60_000, staleMs: 30_000 },
  );
  const states = useMemo(
    () =>
      new Map<string, SessionState>((statesQ.data?.items ?? []).map((s) => [keyOf(s.symbol), s])),
    [statesQ.data],
  );

  // Per-row alert bell: armed (amber) / fired (red), from the same list ALRT shows.
  const alertsQ = useQuery({
    queryKey: ["alerts"],
    queryFn: () => api.get<Alert[]>("/alerts"),
    refetchInterval: 30_000,
  });
  const bells = useMemo(() => {
    const m = new Map<string, { armed: Alert[]; fired: Alert[] }>();
    for (const a of alertsQ.data ?? []) {
      const k = keyOf(a.symbol);
      const e = m.get(k) ?? { armed: [], fired: [] };
      (a.active ? e.armed : e.fired).push(a);
      m.set(k, e);
    }
    return m;
  }, [alertsQ.data]);

  // ---- editing ----
  const notify = useWorkspace((s) => s.notify);
  const addRef = useRef<HTMLInputElement>(null);
  const alertRef = useRef<HTMLInputElement>(null);
  const [alertFor, setAlertFor] = useState<string | null>(null);
  const [colsOpen, setColsOpen] = useState(false);
  const refocus = () =>
    scrollRef.current?.closest<HTMLElement>("[data-panel-id]")?.focus({ preventScroll: true });

  const write = (next: string[]) =>
    list
      ? setSymbols(list, next).catch((e: unknown) => {
          notify(`${list.name} not saved: ${String(e)}`, "error");
          return null;
        })
      : Promise.resolve(null);

  const add = async (text: string) => {
    if (!list) return;
    const { header, symbols: syms } = parseAdd(text);
    const after = sel?.row;
    if (header) {
      await write(insertRows(rows, [`#${header}`], after));
      setSelRow(`#${header}`);
      return;
    }
    if (!syms.length) return;
    const w = await write(insertRows(rows, syms, after));
    if (!w) return;
    const added = w.symbols.filter((s) => !symbols.includes(s));
    notify(added.length ? `Added ${added.join(" ")} to ${list.name}` : "Already in the list");
    if (added[0]) setSelRow(added[0]);
  };

  const armAlert = async (sym: string, text: string) => {
    const cond = parseCondition(text);
    if (!cond) {
      notify("Alert: >200 · <180 · %>5 · %<-3", "error");
      return false;
    }
    try {
      const a = await api.post<Alert>("/alerts", { symbol: sym, ...cond, note: "" });
      notify(`Alert #${a.id} armed: ${describeAlert(a)}`);
      await qc.invalidateQueries({ queryKey: ["alerts"] });
      return true;
    } catch (e) {
      notify(`Alert not armed: ${String(e)}`, "error");
      return false;
    }
  };

  // ---- full-list CSV (96 Export and the CSV button): every row, not only those rendered ----
  const exportCsv = async () => {
    const missing = symbols.filter((s) => !quotes.get(s)?.quote);
    const fetched = new Map<string, Schemas["QuoteItem"]>();
    for (let i = 0; i < missing.length; i += 200) {
      const r = await api.get<Schemas["QuotesResponse"]>("/quotes", {
        symbols: missing.slice(i, i + 200).join(","),
      });
      r.items.forEach((it) => fetched.set(keyOf(it.symbol), it));
    }
    let noProfile = 0;
    const head = [...cols.map(colLabel), "SOURCE"];
    const csv = monCsv(head, shown, (s) => {
      const live = quotes.get(s);
      const item = fetched.get(keyOf(s));
      const q = live?.quote ?? item?.data ?? null;
      const meta = live?.quote ? live.meta : (item?.meta ?? null);
      const prof = profiles.get(keyOf(s));
      if (needProfile && !prof) noProfile++;
      const ref = master.get(keyOf(s));
      const cells = cols.map((f) => fmtField(f, fieldValue(f, q, prof, ref), s, q?.price));
      const tag = meta
        ? `${meta.source} ${freshnessLabel(meta, Date.now())}`
        : (item?.error ?? live?.error ?? NA);
      return [...cells, tag];
    });
    return {
      csv,
      rows: symbols.length,
      note: noProfile
        ? `profile fields N.A. for ${noProfile} rows not yet scrolled into view`
        : undefined,
    };
  };
  const exportRef = useRef(exportCsv);
  exportRef.current = exportCsv;
  useEffect(() => registerExporter(id, () => exportRef.current()), [id]);
  const copyCsv = () =>
    void exportCsv().then(
      ({ csv, rows: n, note }) =>
        navigator.clipboard.writeText(csv).then(
          () =>
            notify(`Copied ${n} rows of ${list?.name ?? "MON"} as CSV${note ? ` (${note})` : ""}`),
          () => notify("Clipboard not available", "error"),
        ),
      (e: unknown) => notify(`Export failed: ${String(e)}`, "error"),
    );

  const allLists = lists.data ?? [];
  const switchList = (delta: number) => {
    if (!list || allLists.length < 2) return;
    const i = allLists.findIndex((l) => l.id === list.id);
    const next = allLists[(i + delta + allLists.length) % allLists.length]!;
    update({ ...panel, args: [next.name] });
    setSelRow(null);
    setSort(null);
  };
  const sortable = [
    "ticker",
    ...cols.filter((f) => f.kind !== "text" && f.kind !== "time").map((f) => f.id),
  ];

  usePanelKeys(id, panel.fn === "MON" ? "MON" : "W", (a) => {
    const n = shown.length;
    if (a === "down") setSel(selIdx + 1);
    else if (a === "up") setSel(selIdx - 1);
    else if (a === "first") setSel(0);
    else if (a === "last") setSel(n - 1);
    else if (a === "prev-list") switchList(-1);
    else if (a === "next-list") switchList(1);
    else if (a === "chart" && selSymbol) void executeCommand(`${selSymbol} GP`, { newPanel: true });
    else if (a === "des" && selSymbol) void executeCommand(`${selSymbol} DES`, { newPanel: true });
    else if (a === "quote" && selSymbol) void executeCommand(`${selSymbol} Q`, { newPanel: true });
    else if (a === "news" && selSymbol) void executeCommand(`${selSymbol} N`, { newPanel: true });
    else if (a === "sort") {
      const i = sort ? sortable.indexOf(sort.col) : -1;
      const col = sortable[(i + 1) % sortable.length]!;
      setSort({ col, desc: col !== "ticker" });
    } else if (a === "sort-dir") setSort((s) => (s ? { ...s, desc: !s.desc } : s));
    else if (a === "unsort") setSort(null);
    else if (a === "add") addRef.current?.focus();
    else if (a === "alert" && selSymbol) {
      setAlertFor(selSymbol);
      requestAnimationFrame(() => alertRef.current?.focus());
    } else if (a === "columns") setColsOpen((o) => !o);
    else if (a === "remove" && sel && list) {
      const next = rows.filter((r) => r !== sel.row);
      setSel(selIdx < next.length ? selIdx + 1 : selIdx - 1);
      void write(next).then(
        (w) =>
          w &&
          notify(
            sel.kind === "header"
              ? `Removed group ${headerName(sel.row)}`
              : `Removed ${sel.row} from ${list.name} (W ADD ${sel.row} to undo)`,
          ),
      );
    } else if ((a === "move-down" || a === "move-up") && sel && list) {
      if (sort) {
        notify("Unsorted order only (U), then move", "error");
        return true;
      }
      const next = moveRow(rows, sel.row, a === "move-down" ? 1 : -1);
      if (next) void write(next);
    } else return false;
    return true;
  });

  if (lists.isLoading) return <Loading what="watchlists" />;
  if (lists.error) return <ErrorBanner error={lists.error} />;

  const errors = symbols.filter((s) => quotes.get(s)?.error && !quotes.get(s)?.quote).length;
  const nCols = cols.length + 3; // ticker, fields, bell, tag
  const items = virt.getVirtualItems();
  const padTop = items[0]?.start ?? 0;
  const padBottom = items.length ? virt.getTotalSize() - items[items.length - 1]!.end : 0;
  const head = (col: string, label: string, left: boolean) => {
    const on = sort?.col === col;
    return (
      <th
        key={col}
        className={left ? "l" : ""}
        style={{ cursor: "pointer" }}
        onClick={() =>
          setSort((s) =>
            s?.col === col
              ? s.desc
                ? { col, desc: false }
                : null
              : { col, desc: col !== "ticker" },
          )
        }
      >
        {label}
        {on ? (sort!.desc ? " ▼" : " ▲") : ""}
      </th>
    );
  };

  return (
    <>
      <div className="toolbar" data-testid="mon-tabs">
        {allLists.map((l) => (
          <button
            key={l.id}
            className={l.id === list?.id ? "on" : ""}
            onClick={() => {
              update({ ...panel, args: [l.name] });
              setSelRow(null);
              setSort(null);
            }}
          >
            {l.name} <span className="dim">{l.symbols.length}</span>
          </button>
        ))}
        <span className="sep" />
        <button
          className={colsOpen ? "on" : ""}
          data-testid="mon-cols-btn"
          onClick={() => setColsOpen((o) => !o)}
        >
          COLS
        </button>
        <button
          data-testid="mon-csv"
          title="Copy the whole list as CSV (also 96 Export)"
          onClick={copyCsv}
        >
          CSV
        </button>
        <span className="hint" style={{ marginLeft: "auto" }}>
          A add · #NAME group · ⇧↑↓ move · B alert · F columns · [ ] lists
        </span>
      </div>
      {colsOpen ? (
        <div
          className="toolbar"
          data-testid="mon-cols"
          style={{ flexWrap: "wrap", height: "auto" }}
        >
          <span className="dim">COLUMNS (FLDS)</span>
          {(fieldsQ.data?.fields ?? []).map((f) => {
            const on = colIds.includes(f.id);
            return (
              <button
                key={f.id}
                className={on ? "on" : ""}
                title={`${f.id} — ${f.definition}`}
                data-field={f.id}
                onClick={() =>
                  void saveCols(on ? colIds.filter((c) => c !== f.id) : [...colIds, f.id])
                }
              >
                {colLabel(f)}
              </button>
            );
          })}
          <button onClick={() => void saveCols([...DEFAULT_COLS])}>DEFAULT</button>
          {fieldsQ.error ? <span className="down">Field list unavailable</span> : null}
        </div>
      ) : null}
      {alertFor ? (
        <div className="toolbar" data-testid="mon-alert">
          <span className="amber">ALERT {alertFor}</span>
          <input
            ref={alertRef}
            data-testid="mon-alert-field"
            placeholder=">200 · <180 · %>5 · %<-3, Enter"
            style={{ width: 200 }}
            onKeyDown={(e) => {
              const el = e.currentTarget;
              if (e.key === "Enter") {
                e.preventDefault();
                void armAlert(alertFor, el.value).then((ok) => {
                  if (ok) {
                    setAlertFor(null);
                    refocus();
                  }
                });
              } else if (e.key === "Escape") {
                e.preventDefault();
                setAlertFor(null);
                refocus();
              }
              e.stopPropagation();
            }}
          />
          {(bells.get(keyOf(alertFor))?.armed ?? []).map((a) => (
            <span key={a.id} className="dim">
              #{a.id} {describeAlert(a)}
            </span>
          ))}
        </div>
      ) : null}
      {errors ? (
        <div className="ds-err">
          <b>{errors} SYMBOL(S) WITHOUT DATA</b> — see the row tooltip for the error
        </div>
      ) : null}
      {cols.length === 0 && fieldsQ.isLoading ? <Loading what="field list" /> : null}
      <div ref={scrollRef} style={{ overflow: "auto", flex: 1 }}>
        <table
          className="grid"
          data-testid="mon"
          style={{
            tableLayout: "fixed",
            width: "100%",
            minWidth: 132 + 22 + 92 + cols.reduce((n, f) => n + colWidth(f), 0),
          }}
        >
          <colgroup>
            <col style={{ width: 132 }} />
            {cols.map((f) => (
              <col key={f.id} style={{ width: colWidth(f) }} />
            ))}
            <col style={{ width: 22 }} />
            <col style={{ width: 92 }} />
          </colgroup>
          <thead>
            <tr>
              {head("ticker", "TICKER", true)}
              {cols.map((f) => head(f.id, colLabel(f), f.kind === "text"))}
              <th title="Alerts: amber armed, red fired">
                <Bell state="none" />
              </th>
              <th className="l">TAG</th>
            </tr>
          </thead>
          <tbody>
            {padTop > 0 ? <tr style={{ height: padTop }} /> : null}
            {items.map((vi) => {
              const r = shown[vi.index]!;
              const selected = vi.index === selIdx;
              if (r.kind === "header") {
                const n = rows.slice(rows.indexOf(r.row) + 1).findIndex(isHeader);
                const count = n < 0 ? rows.length - rows.indexOf(r.row) - 1 : n;
                return (
                  <tr
                    key={r.row}
                    className={`grp${selected ? " sel" : ""}`}
                    data-testid="mon-group"
                    onMouseDown={() => setSelRow(r.row)}
                  >
                    <td className="l amber" colSpan={nCols}>
                      {r.name} <span className="dim">{count}</span>
                    </td>
                  </tr>
                );
              }
              const s = r.row;
              const st = quotes.get(s);
              const q = st?.quote ?? null;
              const f = flashes.get(s);
              const prof = profiles.get(keyOf(s));
              const closed = isClosed(states.get(keyOf(s))?.state);
              const bell = bells.get(keyOf(s));
              const bellState = bell?.fired.length
                ? "fired"
                : bell?.armed.length
                  ? "armed"
                  : "none";
              return (
                <tr
                  key={s}
                  data-symbol={s}
                  className={[selected ? "sel" : "", closed ? "closed" : ""].join(" ").trim()}
                  title={st?.error ?? st?.meta?.note ?? ""}
                  onMouseDown={() => setSelRow(s)}
                  onDoubleClick={() => void executeCommand(`${s} GP`, { newPanel: true })}
                  {...tickerDragProps(s)}
                >
                  <td className="l amber">{s}</td>
                  {cols.map((c) => {
                    const v = fieldValue(c, q, prof, master.get(keyOf(s)));
                    const text = fmtField(c, v, s, q?.price);
                    if (c.id === "name" && st?.error && !q && v === null)
                      return (
                        <td
                          key={c.id}
                          className="l down"
                          style={{ overflow: "hidden", textOverflow: "ellipsis" }}
                        >
                          {st.error}
                        </td>
                      );
                    if (c.kind === "text")
                      return (
                        <td
                          key={c.id}
                          className="l dim"
                          style={{ overflow: "hidden", textOverflow: "ellipsis" }}
                        >
                          <V>{text}</V>
                        </td>
                      );
                    if (c.kind === "change" || c.kind === "pct")
                      return (
                        <Sgn key={c.id} as="td" v={typeof v === "number" ? v : null}>
                          {text}
                        </Sgn>
                      );
                    const flash = c.id === "px_last" && f;
                    const est =
                      (c.id === "px_bid" || c.id === "px_ask") &&
                      v != null &&
                      bookIsEstimated(st?.meta);
                    return (
                      <td
                        key={flash ? `${c.id}-${f.n}` : c.id}
                        className={[flash ? `flash-${f.dir}` : "", c.kind === "time" ? "dim" : ""]
                          .join(" ")
                          .trim()}
                      >
                        <V>{text}</V>
                        {est ? <span className="dim"> est.</span> : null}
                      </td>
                    );
                  })}
                  <td
                    data-testid="mon-bell"
                    data-state={bellState}
                    className={
                      bellState === "fired" ? "down" : bellState === "armed" ? "amber" : "dim"
                    }
                    style={{ cursor: "pointer", textAlign: "center" }}
                    title={
                      bell
                        ? [...bell.armed, ...bell.fired]
                            .map((a) => `#${a.id} ${describeAlert(a)}${a.active ? "" : " (fired)"}`)
                            .join("\n")
                        : "Set an alert (B)"
                    }
                    onClick={(e) => {
                      e.stopPropagation();
                      setSelRow(s);
                      setAlertFor(s);
                      requestAnimationFrame(() => alertRef.current?.focus());
                    }}
                  >
                    {bellState === "none" && !selected ? null : <Bell state={bellState} />}
                  </td>
                  <td className="l">{st?.meta ? <LatencyTag meta={st.meta} /> : null}</td>
                </tr>
              );
            })}
            {padBottom > 0 ? <tr style={{ height: padBottom }} /> : null}
          </tbody>
        </table>
        {rows.length === 0 ? (
          <div className="empty">
            Empty list. Type symbols in the amber row below, or #NAME for a group.
          </div>
        ) : null}
        <div className="mon-add">
          <input
            ref={addRef}
            data-testid="mon-add"
            placeholder="+ add symbols (AAPL MSFT) or #GROUP, Enter"
            onKeyDown={(e) => {
              const el = e.currentTarget;
              if (e.key === "Enter") {
                e.preventDefault();
                const text = el.value;
                el.value = "";
                void add(text);
              } else if (e.key === "Escape") {
                e.preventDefault();
                el.value = "";
                refocus();
              }
              e.stopPropagation();
            }}
          />
        </div>
      </div>
    </>
  );
}

/** List targeted by W/MON ADD/DEL/COLS: the active monitor's list, else the first one shown. */
function targetListName(): string | undefined {
  const { session } = useWorkspace.getState();
  const isMon = (fn: string) => fn === "W" || fn === "MON";
  const active = activePanel();
  if (active && isMon(active.fn)) return active.args[0];
  for (const id of visibleIds(session)) {
    const v = winView(session.windows[id]!);
    if (isMon(v.fn)) return v.args[0];
  }
  return undefined;
}

async function wAction(code: string, args: string[]): Promise<boolean> {
  const [sub, ...rest] = args;
  const ws = useWorkspace.getState();
  switch (sub) {
    case "ADD": {
      if (!rest.length) throw new Error(`Usage: ${code} ADD <SYMBOL> [SYMBOL...]`);
      const list = await findList(targetListName());
      const added = rest.filter((s) => !list.rows.includes(s));
      const w = await setSymbols(list, [...list.rows, ...added]);
      const fresh = w.symbols.filter((s) => !list.symbols.includes(s));
      ws.notify(`Added ${fresh.join(" ") || "nothing new"} to ${list.name}`);
      return true;
    }
    case "DEL": {
      const list = await findList(targetListName());
      await setSymbols(
        list,
        list.rows.filter((s) => !rest.includes(s)),
      );
      ws.notify(`Removed ${rest.join(" ")} from ${list.name}`);
      return true;
    }
    case "NEW": {
      const name = rest[0];
      if (!name) throw new Error(`Usage: ${code} NEW <NAME>`);
      const w = await createList(name);
      ws.open({ fn: code, args: [w.name] });
      return true;
    }
    case "DROP": {
      if (!rest[0]) throw new Error(`Usage: ${code} DROP <NAME>`);
      const list = await findList(rest[0]);
      await deleteList(list);
      ws.notify(`Deleted watchlist ${list.name}`);
      return true;
    }
    case "COLS": {
      const list = await findList(targetListName());
      const want = rest.map((s) => s.toLowerCase());
      if (!want.length)
        throw new Error(`Usage: ${code} COLS <field...> | DEFAULT (field names: FLDS)`);
      let cols = [...DEFAULT_COLS];
      if (!(want.length === 1 && want[0] === "default")) {
        const known = await api.get<Schemas["FieldsResponse"]>("/fields");
        const ids = new Set(known.fields.map((f) => f.id));
        const bad = want.filter((w) => !ids.has(w));
        if (bad.length) throw new Error(`Unknown field ${bad.join(", ")}: see FLDS`);
        cols = want.slice(0, MAX_COLS);
      }
      await api.put(`/settings/${encodeURIComponent(colsKey(list.id))}`, { cols });
      await watchlistClient()?.invalidateQueries({ queryKey: ["settings", colsKey(list.id)] });
      ws.notify(`${list.name} columns: ${cols.join(" ")}`);
      return true;
    }
    default:
      return false; // "MON" or "MON <NAME>" opens the panel
  }
}

function monDef(code: "MON" | "W"): FunctionDef {
  return {
    code,
    name: code === "MON" ? "Monitors" : "Watchlists (MON)",
    description:
      code === "MON"
        ? "Live lists as tabs with columns from FLDS, group headers, sort, tick flash, " +
          "closed markets dimmed, per-row alert bell and CSV export"
        : "Alias of MON: live lists with columns from FLDS, groups, alerts and CSV export",
    ticker: "none",
    syntax:
      `${code} [NAME] · ${code} ADD <SYM..|#GROUP> · ${code} DEL <SYM..> · ${code} NEW <NAME> · ` +
      `${code} DROP <NAME> · ${code} COLS <field..> | DEFAULT`,
    examples: [
      code,
      `${code} FX`,
      `${code} ADD NVDA AMD`,
      `${code} COLS px_last chg_pct_1d pe_ttm`,
    ],
    category: "Market",
    sectors: ["CLIENT", "EQUITY"],
    menu: ["Watchlists"],
    args: [
      anyText(
        "list",
        "NAME · ADD <SYM..> · DEL <SYM..> · NEW <NAME> · DROP <NAME> · COLS <field..>",
      ),
    ],
    actions: [],
    component: MON,
    run: (cmd) => wAction(code, cmd.args),
    // Subcommands with Latin symbols / one name; a bare list name is free text.
    structuredArgs: ([sub, ...rest]) =>
      sub === "ADD" || sub === "DEL" || sub === "COLS"
        ? rest.length > 0 && rest.every((s) => !hasCyrillic(s))
        : (sub === "NEW" || sub === "DROP") && rest.length === 1,
    title: (p) => `${code === "MON" ? "Monitor" : "Watchlist"} ${p.args[0] ?? ""}`.trim(),
  };
}

export function registerW(): void {
  registerFunction(monDef("MON"));
  registerFunction(monDef("W"));
}

// Re-export so the tape and command handlers share list lookups.
export { executeCommand };
