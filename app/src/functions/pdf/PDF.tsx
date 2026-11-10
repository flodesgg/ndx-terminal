/** PDF (SPEC §7): personal defaults — default exchange, colours, opt-in providers. */
import { useRef, useState } from "react";
import { api, errorMessage, type Schemas } from "@/core/api";
import { useApi } from "@/core/data";
import { usePanelKeys } from "@/core/keys";
import { useWorkspace } from "@/core/layout/store";
import { noticeFor } from "@/core/notices";
import {
  pdfArgs,
  PDF_SECTIONS,
  savePdf,
  usePdf,
  YF_MODES,
  yfMode,
  type YfinanceOptIn,
} from "@/core/pdf";
import { matching, oneOf, registerFunction, type PanelProps } from "@/core/registry";
import { EXCHANGES } from "@/core/secmaster";
import { ErrorBanner } from "@/components/DataStatus";
import { NAValue } from "@/components/V";
import { COLOR_SCHEMES, token, type ColorScheme } from "@/theme/tokens";

type OptIn = Schemas["OptInProviders"];
type NewsFeeds = Schemas["NewsFeeds"];

/** RSS/Atom feeds for TOP (no defaults: each publisher's terms are the user's call). */
function NewsFeedsRow({ inputRef }: { inputRef: React.RefObject<HTMLInputElement | null> }) {
  const feeds = useApi<NewsFeeds>("/news/feeds");
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const list = feeds.data?.feeds ?? [];
  const save = (next: string[]) =>
    api.put<NewsFeeds>("/news/feeds", { feeds: next }).then(
      (r) => {
        setError(r.feeds.length < next.length ? "not a valid http(s) URL — not added" : null);
        void feeds.refetch();
      },
      (e: unknown) => setError(errorMessage(e)),
    );
  return (
    <tr data-testid="pdf-news">
      <td className="l amber">NEWS</td>
      <td className="l">
        {list.map((f) => (
          <div key={f} data-testid="pdf-news-feed">
            {f}{" "}
            <button
              type="button"
              className="link"
              onClick={() => void save(list.filter((x) => x !== f))}
            >
              ✕
            </button>
          </div>
        ))}
        <input
          ref={inputRef}
          data-testid="pdf-news-input"
          value={draft}
          placeholder="https://… RSS/Atom feed (n)"
          maxLength={300}
          style={{ width: 260 }}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              if (e.key === "Enter" && draft.trim())
                void save([...list, draft.trim()]).then(() => setDraft(""));
              (e.target as HTMLInputElement).blur();
            }
          }}
        />
        {error ? <div className="down">{error}</div> : null}
      </td>
      <td className="l dim" style={{ whiteSpace: "normal" }}>
        RSS/Atom feeds for TOP, at most 12. None by default: whether a publisher allows its feed in
        a personal reader is in its terms, so you pick them. Headline, summary and link only;
        fetched with an honest User-Agent. n adds · PDF NEWS
      </td>
    </tr>
  );
}

const SCHEME_LABEL: Record<ColorScheme, string> = {
  STANDARD: "Standard: green up, red down",
  COLORBLIND: "Colour-blind safe: blue up, orange down",
};

async function setYfinance(o: YfinanceOptIn): Promise<OptIn> {
  return api.put<OptIn>("/providers/opt-in", o);
}

const YF_NOTE: Record<"ON" | "DK" | "OFF", string> = {
  ON: "ON — personal use, every market",
  DK: "DK — personal use, Danish stocks and indices only",
  OFF: "OFF",
};

function Pdf({ id, panel }: PanelProps) {
  const pdf = usePdf((s) => s.pdf);
  const optIn = useApi<OptIn>("/providers/opt-in");
  const [error, setError] = useState<string | null>(null);
  const notify = useWorkspace((s) => s.notify);
  const colorsOnly = panel.args[0]?.toUpperCase() === "COLORS";
  const newsOnly = panel.args[0]?.toUpperCase() === "NEWS";
  const feedRef = useRef<HTMLInputElement>(null);
  const yf = optIn.data?.yfinance;
  const mode = optIn.data ? yfMode(optIn.data) : undefined;

  const save = (p: Parameters<typeof savePdf>[0]) =>
    savePdf(p).then(
      () => setError(null),
      (e: unknown) => setError(errorMessage(e)),
    );
  const setMode = (next: "ON" | "DK" | "OFF") => {
    const a = pdfArgs(["YFINANCE", next]);
    if (!("optIn" in a)) return;
    setYfinance(a.optIn).then(
      () => {
        void optIn.refetch();
        notify(`yfinance ${YF_NOTE[next]}`);
      },
      (e: unknown) => setError(errorMessage(e)),
    );
  };
  // The checkbox switches it on with the scope it had (every market by default) or off.
  const toggleYf = () => {
    if (!optIn.data) return;
    setMode(yf ? "OFF" : optIn.data.yfinance_scope === "dk_indices" ? "DK" : "ON");
  };
  const nextScheme = () =>
    void save({
      colors: COLOR_SCHEMES[(COLOR_SCHEMES.indexOf(pdf.colors) + 1) % COLOR_SCHEMES.length]!,
    });
  usePanelKeys(id, "PDF", (a) => {
    if (a === "colors") nextScheme();
    else if (a === "yfinance" && !colorsOnly && !newsOnly) toggleYf();
    else if (a === "news" && !colorsOnly) feedRef.current?.focus();
    else return false;
    return true;
  });

  const colors = (
    <tr data-testid="pdf-colors">
      <td className="l amber">COLORS</td>
      <td className="l">
        <select
          value={pdf.colors}
          onChange={(e) => void save({ colors: e.target.value as ColorScheme })}
        >
          {COLOR_SCHEMES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>{" "}
        <span style={{ color: token("up") }}>▲ up</span>{" "}
        <span style={{ color: token("down") }}>▼ down</span>
      </td>
      <td className="l dim" style={{ whiteSpace: "normal" }}>
        {SCHEME_LABEL[pdf.colors]} · c cycles · PDF COLORS &lt;scheme&gt;
      </td>
    </tr>
  );

  return (
    <div style={{ overflow: "auto", flex: 1 }} data-testid="pdf">
      {error ? <div className="down menu-note">{error}</div> : null}
      <div className="ds">
        PERSONAL DEFAULTS · stored in your local database · PDF &lt;SETTING&gt; &lt;VALUE&gt; from
        the command line
      </div>
      <table className="grid">
        <tbody>
          {colorsOnly ? (
            colors
          ) : newsOnly ? (
            <NewsFeedsRow inputRef={feedRef} />
          ) : (
            <>
              <tr data-testid="pdf-exchange">
                <td className="l amber" style={{ width: 110 }}>
                  EXCH
                </td>
                <td className="l" style={{ width: 280 }}>
                  <select
                    value={pdf.defaultExchange}
                    onChange={(e) => void save({ defaultExchange: e.target.value })}
                  >
                    {[...EXCHANGES].sort().map((x) => (
                      <option key={x} value={x}>
                        {x}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="l dim" style={{ whiteSpace: "normal" }}>
                  Default exchange: a bare ticker that is not a US listing resolves here (NOVOB →
                  NOVOB {pdf.defaultExchange} EQUITY). Default DC.
                </td>
              </tr>
              {colors}
              <tr data-testid="pdf-yfinance">
                <td className="l amber">YFINANCE</td>
                <td className="l">
                  <label>
                    <input
                      type="checkbox"
                      data-testid="pdf-yfinance-toggle"
                      checked={!!yf}
                      disabled={yf === undefined}
                      onChange={toggleYf}
                    />{" "}
                    {mode === undefined ? <NAValue /> : mode === "OFF" ? "OFF (default)" : mode}
                  </label>{" "}
                  <span className="amber">PERSONAL USE</span>{" "}
                  {YF_MODES.map((m) => (
                    <button
                      key={m}
                      data-testid={`pdf-yfinance-${m.toLowerCase()}`}
                      className={m === mode ? "on" : ""}
                      disabled={mode === undefined || m === mode}
                      onClick={() => setMode(m)}
                    >
                      {m}
                    </button>
                  ))}
                </td>
                <td className="l dim" style={{ whiteSpace: "normal" }}>
                  Opt-in, off by default. {noticeFor("yfinance")!.text} ON: every market. DK: Danish
                  stocks and all indices (other markets keep their free sources; EODHD stays the
                  fallback). y toggles · PDF YFINANCE ON|DK|OFF
                </td>
              </tr>
              <NewsFeedsRow inputRef={feedRef} />
            </>
          )}
        </tbody>
      </table>
      {optIn.error ? <ErrorBanner error={optIn.error} /> : null}
    </div>
  );
}

/** `PDF EXCH GY` etc. save first, then the page opens showing the result. */
async function pdfAction(args: string[]): Promise<boolean> {
  const a = pdfArgs(args);
  const ws = useWorkspace.getState();
  if ("error" in a) throw new Error(a.error);
  if ("set" in a) {
    await savePdf(a.set);
    ws.notify(`PDF saved: ${Object.values(a.set).join(" ")}`);
  }
  if ("optIn" in a) {
    await setYfinance(a.optIn);
    ws.notify(`yfinance ${YF_NOTE[yfMode(a.optIn)]}`);
  }
  return false;
}

export function registerPDF(): void {
  registerFunction({
    code: "PDF",
    name: "Personal defaults",
    description:
      "Default exchange for bare non-US tickers (default DC), colour palette (PDF COLORS: " +
      "standard or colour-blind safe), opt-in providers (yfinance, off by default, personal use), " +
      "news feeds (PDF NEWS: RSS/Atom feeds for TOP, none by default).",
    ticker: "none",
    syntax: "PDF [COLORS [SCHEME]] · PDF EXCH <CODE> · PDF YFINANCE ON|DK|OFF · PDF NEWS",
    examples: ["PDF", "PDF COLORS", "PDF EXCH DC", "PDF YFINANCE OFF"],
    category: "System",
    sectors: [],
    menu: ["Settings"],
    args: [
      oneOf("setting", PDF_SECTIONS, "which setting"),
      oneOf("value", [...COLOR_SCHEMES, ...YF_MODES], "colour scheme, or ON/DK/OFF for yfinance"),
      matching("exchange", /^[A-Z]{2}$/, "<exchange>", "exchange code for EXCH, e.g. DC GY LN"),
    ],
    actions: [],
    title: (p) =>
      ({ COLORS: "Colours", NEWS: "News feeds" })[p.args[0]?.toUpperCase() ?? ""] ??
      "Personal defaults",
    component: Pdf,
    run: (cmd) => pdfAction(cmd.args),
  });
}
