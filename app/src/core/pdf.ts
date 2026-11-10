/**
 * PDF — personal defaults (SPEC §7): the default exchange for bare non-US tickers (§4.3 rule 6,
 * default DC, my choice) and the colour palette (`PDF COLORS`). Stored in user.db under
 * the `pdf` setting; opt-in providers (yfinance) live in `/providers/opt-in` on the server.
 */
import { create } from "zustand";
import { api } from "./api";
import { isExchangeCode } from "./secindex";
import { COLOR_SCHEMES, setColorScheme, type ColorScheme } from "@/theme/tokens";

export interface Pdf {
  defaultExchange: string;
  colors: ColorScheme;
}

export const DEFAULT_PDF: Pdf = { defaultExchange: "DC", colors: "STANDARD" };
export const PDF_SETTING = "pdf";

const isScheme = (v: unknown): v is ColorScheme =>
  typeof v === "string" && (COLOR_SCHEMES as readonly string[]).includes(v);

/** A stored value → valid settings; each unknown or missing field keeps its default. */
export function parsePdf(raw: unknown): Pdf {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const ex = typeof o.defaultExchange === "string" ? o.defaultExchange.toUpperCase() : "";
  return {
    defaultExchange: isExchangeCode(ex) ? ex : DEFAULT_PDF.defaultExchange,
    colors: isScheme(o.colors) ? o.colors : DEFAULT_PDF.colors,
  };
}

export const usePdf = create<{ pdf: Pdf }>(() => ({ pdf: DEFAULT_PDF }));

/** Load at launch, before the first command runs. A failed read keeps the defaults. */
export async function bootPdf(): Promise<void> {
  const pdf = parsePdf(await api.get<unknown>(`/settings/${PDF_SETTING}`).catch(() => null));
  usePdf.setState({ pdf });
  setColorScheme(pdf.colors);
}

export async function savePdf(patch: Partial<Pdf>): Promise<Pdf> {
  const pdf = parsePdf({ ...usePdf.getState().pdf, ...patch });
  await api.put(`/settings/${PDF_SETTING}`, pdf);
  usePdf.setState({ pdf });
  setColorScheme(pdf.colors);
  return pdf;
}

export const PDF_SECTIONS = ["COLORS", "EXCH", "YFINANCE", "NEWS"] as const;

export type PdfArgs =
  | { section: "ALL" | "COLORS" | "NEWS" }
  | { set: Partial<Pdf> }
  | { optIn: YfinanceOptIn }
  | { error: string };

/** yfinance opt-in: ON covers every market, DK only Danish stocks and indices (decision
 * 2026-11-10; other markets keep their free sources, EODHD stays the fallback). */
export interface YfinanceOptIn {
  yfinance: boolean;
  yfinance_scope: "all" | "dk_indices";
}

export const YF_MODES = ["ON", "DK", "OFF"] as const;

/** The mode word of a stored opt-in (PDF shows it, `PDF YFINANCE <mode>` sets it). */
export function yfMode(o: Partial<YfinanceOptIn> | undefined): "ON" | "DK" | "OFF" {
  if (!o?.yfinance) return "OFF";
  return o.yfinance_scope === "dk_indices" ? "DK" : "ON";
}

/** `PDF`, `PDF COLORS`, `PDF COLORS COLORBLIND`, `PDF EXCH GY`, `PDF YFINANCE ON|DK|OFF`,
 * `PDF NEWS` (RSS feeds are added in the page: a URL is not a command-line token). */
export function pdfArgs(args: readonly string[]): PdfArgs {
  const [what, value, extra] = args.map((a) => a.toUpperCase());
  if (extra !== undefined) return { error: "PDF takes a setting and one value" };
  if (what === undefined) return { section: "ALL" };
  if (what === "COLORS") {
    if (value === undefined) return { section: "COLORS" };
    return isScheme(value)
      ? { set: { colors: value } }
      : { error: `PDF COLORS: "${value}" — use ${COLOR_SCHEMES.join(" or ")}` };
  }
  if (what === "EXCH") {
    if (value && isExchangeCode(value)) return { set: { defaultExchange: value } };
    return { error: `PDF EXCH: "${value ?? ""}" is not an exchange code (e.g. DC, GY, LN, SS)` };
  }
  if (what === "NEWS") {
    if (value === undefined) return { section: "NEWS" };
    return { error: "PDF NEWS: add or remove feeds on the page (n focuses the URL field)" };
  }
  if (what === "YFINANCE") {
    if (value === "ON") return { optIn: { yfinance: true, yfinance_scope: "all" } };
    if (value === "DK") return { optIn: { yfinance: true, yfinance_scope: "dk_indices" } };
    if (value === "OFF") return { optIn: { yfinance: false, yfinance_scope: "all" } };
    return { error: "PDF YFINANCE: ON (every market), DK (Danish stocks and indices) or OFF" };
  }
  return { error: `PDF: unknown setting "${what}" — ${PDF_SECTIONS.join(", ")}` };
}
