/**
 * JRNL — trade journal (SPEC §8 "Smaller ones", simple version per the scope cut):
 * entry/exit, size, side, thesis, setup and mistake tags, post-mortem; stats by tag. These are
 * the user's own records, no market data: P&L is in the trade's currency, stats use return %
 * so different currencies are never summed (server/ndx_server/journal.py).
 */
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, errorMessage, type Schemas } from "@/core/api";
import { usePanelKeys } from "@/core/keys";
import { registerFunction, type PanelProps } from "@/core/registry";
import { ErrorBanner, Loading } from "@/components/DataStatus";
import { Sgn } from "@/components/V";
import { NA, fmtNum, fmtPct, fmtSigned } from "@/lib/format";

type Journal = Schemas["JournalResponse"];
type Entry = Schemas["JournalEntry"];
type Body = Schemas["JournalEntryBody"];

interface Form {
  symbol: string;
  side: "LONG" | "SHORT";
  qty: string;
  entry: string;
  exit: string;
  opened: string;
  setup: string;
  mistakes: string;
  thesis: string;
  review: string;
}

const EMPTY: Form = {
  symbol: "",
  side: "LONG",
  qty: "",
  entry: "",
  exit: "",
  opened: "",
  setup: "",
  mistakes: "",
  thesis: "",
  review: "",
};

/** Form → request body, or the first problem. */
export function toBody(f: Form): Body | string {
  const num = (s: string) => (s.trim() === "" ? null : Number(s));
  const qty = num(f.qty);
  const entry = num(f.entry);
  const exit = num(f.exit);
  if (!f.symbol.trim()) return "symbol is required";
  if (qty === null || !(qty > 0)) return "size must be a positive number";
  if (entry === null || !(entry > 0)) return "entry must be a positive price";
  if (exit !== null && !(exit > 0)) return "exit must be a positive price or empty";
  if (f.opened && !/^\d{4}-\d{2}-\d{2}$/.test(f.opened)) return "opened must be YYYY-MM-DD";
  return {
    symbol: f.symbol.trim(),
    side: f.side,
    qty,
    entry,
    exit,
    opened: f.opened || null,
    closed: null,
    setup: f.setup,
    mistakes: f.mistakes,
    thesis: f.thesis,
    review: f.review,
  };
}

function formOf(e: Entry): Form {
  return {
    symbol: e.symbol,
    side: e.side,
    qty: String(e.qty),
    entry: String(e.entry),
    exit: e.exit == null ? "" : String(e.exit),
    opened: e.opened,
    setup: e.setup,
    mistakes: e.mistakes,
    thesis: e.thesis,
    review: e.review,
  };
}

function JRNL({ id }: PanelProps) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["journal"], queryFn: () => api.get<Journal>("/journal") });
  const [form, setForm] = useState<Form>(EMPTY);
  const [editing, setEditing] = useState<number | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [sel, setSel] = useState(0);
  const first = useRef<HTMLInputElement>(null);
  const body = useRef<HTMLTableSectionElement>(null);
  const entries = q.data?.entries ?? [];
  const cur = entries[Math.min(sel, entries.length - 1)];

  useEffect(() => {
    body.current?.querySelector(`[data-idx="${sel}"]`)?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  const done = (j: Journal) => {
    qc.setQueryData(["journal"], j);
    setForm(EMPTY);
    setEditing(null);
  };
  const save = async () => {
    const b = toBody(form);
    if (typeof b === "string") return setMsg(b);
    try {
      done(
        editing === null
          ? await api.post<Journal>("/journal", b)
          : await api.put<Journal>(`/journal/${editing}`, b),
      );
      setMsg(null);
    } catch (e) {
      setMsg(errorMessage(e));
    }
  };
  const remove = async (e: Entry) => {
    try {
      qc.setQueryData(["journal"], await api.del<Journal>(`/journal/${e.id}`));
    } catch (err) {
      setMsg(errorMessage(err));
    }
  };

  usePanelKeys(id, "JRNL", (a) => {
    if (a === "down") setSel((s) => Math.min(entries.length - 1, s + 1));
    else if (a === "up") setSel((s) => Math.max(0, s - 1));
    else if (a === "new") {
      setForm(EMPTY);
      setEditing(null);
      first.current?.focus();
    } else if (a === "edit" && cur) {
      setForm(formOf(cur));
      setEditing(cur.id);
      first.current?.focus();
    } else if (a === "delete" && cur) void remove(cur);
    else return false;
    return true;
  });

  if (q.isLoading) return <Loading what="journal" />;
  const j = q.data;
  const field = (k: keyof Form, label: string, w = 90, ref?: React.Ref<HTMLInputElement>) => (
    <label className="jrnl-field">
      <span className="dim">{label}</span>
      <input
        ref={ref}
        className="amber-field"
        style={{ width: w }}
        value={form[k]}
        data-testid={`jrnl-${k}`}
        onChange={(e) => setForm({ ...form, [k]: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === "Enter") void save();
        }}
      />
    </label>
  );
  return (
    <div className="jrnl" data-testid="jrnl">
      {q.error ? <ErrorBanner error={q.error} /> : null}
      <div className="ds">
        <span className="dim">SRC</span> your entries ·{" "}
        <span data-testid="jrnl-summary">
          CLOSED {j?.closed ?? 0} · OPEN {j?.open ?? 0} · WIN RATE{" "}
          {j?.win_rate == null ? NA : fmtPct(j.win_rate, 0, false)} · AVG RETURN{" "}
          {j?.avg_ret_pct == null ? NA : fmtPct(j.avg_ret_pct, 2)}
        </span>
      </div>
      <div className="jrnl-form" data-testid="jrnl-form">
        <span className="amber">{editing === null ? "NEW TRADE" : `EDIT #${editing}`}</span>
        {field("symbol", "SYMBOL", 120, first)}
        <label className="jrnl-field">
          <span className="dim">SIDE</span>
          <select
            className="amber-field"
            value={form.side}
            data-testid="jrnl-side"
            onChange={(e) => setForm({ ...form, side: e.target.value as Form["side"] })}
          >
            <option>LONG</option>
            <option>SHORT</option>
          </select>
        </label>
        {field("qty", "SIZE", 70)}
        {field("entry", "ENTRY", 80)}
        {field("exit", "EXIT", 80)}
        {field("opened", "OPENED", 95)}
        {field("setup", "SETUP TAGS", 130)}
        {field("mistakes", "MISTAKE TAGS", 130)}
        {field("thesis", "THESIS", 220)}
        {field("review", "POST-MORTEM", 220)}
        <button onClick={() => void save()} data-testid="jrnl-save">
          SAVE (Enter)
        </button>
        {editing !== null ? (
          <button
            onClick={() => {
              setForm(EMPTY);
              setEditing(null);
            }}
          >
            CANCEL
          </button>
        ) : null}
        {msg ? (
          <span className="down" data-testid="jrnl-msg">
            {msg}
          </span>
        ) : null}
      </div>
      <div className="jrnl-body">
        <table className="grid">
          <thead>
            <tr>
              <th className="l">OPENED</th>
              <th className="l">SYMBOL</th>
              <th className="l">SIDE</th>
              <th>SIZE</th>
              <th>ENTRY</th>
              <th>EXIT</th>
              <th title="In the trade's currency">P&amp;L</th>
              <th>RET %</th>
              <th className="l">SETUP</th>
              <th className="l">MISTAKES</th>
              <th className="l">THESIS</th>
            </tr>
          </thead>
          <tbody ref={body}>
            {entries.map((e, i) => (
              <tr
                key={e.id}
                data-idx={i}
                data-testid="jrnl-row"
                className={e === cur ? "sel" : ""}
                onClick={() => setSel(i)}
                onDoubleClick={() => {
                  setForm(formOf(e));
                  setEditing(e.id);
                }}
                title={e.review ? `Post-mortem: ${e.review}` : undefined}
              >
                <td className="l">{e.opened}</td>
                <td className="l amber">{e.symbol}</td>
                <td className="l">{e.side}</td>
                <td>{fmtNum(e.qty, e.qty % 1 ? 4 : 0)}</td>
                <td>{fmtNum(e.entry, 2)}</td>
                <td>{e.exit == null ? <span className="dim">open</span> : fmtNum(e.exit, 2)}</td>
                <Sgn as="td" v={e.pnl}>
                  {e.pnl == null ? NA : fmtSigned(e.pnl, 2)}
                </Sgn>
                <Sgn as="td" v={e.ret_pct}>
                  {e.ret_pct == null ? NA : fmtPct(e.ret_pct, 2)}
                </Sgn>
                <td className="l">{e.setup}</td>
                <td className="l">{e.mistakes}</td>
                <td className="l jrnl-thesis">{e.thesis}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!entries.length ? (
          <div className="empty">
            No trades yet. Fill the amber fields and press Enter. Tags are comma-separated.
          </div>
        ) : null}
        {j?.by_tag.length ? (
          <table className="grid jrnl-tags" data-testid="jrnl-tags">
            <thead>
              <tr>
                <th className="l">TAG</th>
                <th className="l">KIND</th>
                <th>CLOSED</th>
                <th>WIN RATE</th>
                <th>AVG RET %</th>
              </tr>
            </thead>
            <tbody>
              {j.by_tag.map((t) => (
                <tr key={`${t.kind}:${t.tag}`}>
                  <td className="l amber">{t.tag}</td>
                  <td className="l">{t.kind}</td>
                  <td>{t.trades}</td>
                  <td>{t.win_rate == null ? NA : fmtPct(t.win_rate, 0, false)}</td>
                  <Sgn as="td" v={t.avg_ret_pct}>
                    {t.avg_ret_pct == null ? NA : fmtPct(t.avg_ret_pct, 2)}
                  </Sgn>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </div>
    </div>
  );
}

export function registerJRNL(): void {
  registerFunction({
    code: "JRNL",
    name: "Trade journal",
    description:
      "Your trades with entry/exit, size, thesis, setup and mistake tags, post-mortem; win rate " +
      "and average return by tag",
    ticker: "none",
    syntax: "JRNL",
    examples: ["JRNL"],
    category: "Tools",
    sectors: ["CLIENT"],
    menu: ["Portfolio"],
    args: [],
    actions: [],
    component: JRNL,
  });
}
