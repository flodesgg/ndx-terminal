/**
 * Status bar content (SPEC §4.1): market states and provider health as text, so colour is never
 * the only cue. Everything comes from the server (`/markets`, `/providers`); nothing is assumed.
 */
import type { Schemas } from "@/core/api";
import { NA, fmtDate, fmtHM } from "./format";

type Market = Schemas["ExchangeStatus"];
type Provider = Schemas["ProviderStatus"];

export interface MarketGroup {
  label: "OPEN" | "HOLIDAY" | "CLOSED" | "N.A.";
  dot: string;
  codes: { code: string; title: string }[];
}

function marketTitle(m: Market): string {
  const state =
    m.is_open == null
      ? "state N.A. (calendar unavailable)"
      : m.is_open
        ? "open"
        : m.holiday
          ? "holiday"
          : "closed";
  const next = m.next_change
    ? ` · ${m.is_open ? "closes" : "opens"} ${fmtDate(m.next_change)} ${fmtHM(m.next_change)}`
    : "";
  return `${m.name}: ${state}${next}`;
}

export function marketGroups(markets: readonly Market[]): MarketGroup[] {
  const groups: MarketGroup[] = [
    { label: "OPEN", dot: "dot-open", codes: [] },
    { label: "HOLIDAY", dot: "dot-closed", codes: [] },
    { label: "CLOSED", dot: "dot-closed", codes: [] },
    { label: "N.A.", dot: "dot-na", codes: [] },
  ];
  for (const m of markets) {
    const i = m.is_open == null ? 3 : m.is_open ? 0 : m.holiday ? 1 : 2;
    groups[i]!.codes.push({ code: m.code, title: marketTitle(m) });
  }
  return groups.filter((g) => g.codes.length);
}

/** Short reason for a disabled provider, from the server's own detail text. */
function offReason(detail: string | null | undefined): string {
  if (!detail) return "off";
  if (detail === "no API key") return "no key";
  if (detail.startsWith("opt-in")) return "opt-in";
  if (detail.startsWith("DEMO")) return "DEMO";
  return "off";
}

export interface ProviderSummary {
  active: { name: string; state: string; text: string; title: string }[];
  off: { reason: string; names: string[]; title: string }[];
  /** No answer from the server: the bar says N.A. instead of looking healthy. */
  na: boolean;
}

export function providerSummary(rows: readonly Provider[] | undefined): ProviderSummary {
  if (!rows) return { active: [], off: [], na: true };
  const active: ProviderSummary["active"] = [];
  const off = new Map<string, { names: string[]; details: string[] }>();
  for (const p of rows) {
    const name = p.name.toUpperCase();
    if (p.state === "disabled") {
      const r = offReason(p.detail);
      const g = off.get(r) ?? { names: [], details: [] };
      g.names.push(name);
      g.details.push(`${p.label}: ${p.detail ?? "disabled"}`);
      off.set(r, g);
      continue;
    }
    // A working provider shows its SPEC §6.1 tag from the server (RT·TRD, EOD, CACHE…); the
    // DEMO provider's tag is its own name, so it is not repeated.
    const text =
      p.state === "ok"
        ? p.tag === name
          ? ""
          : p.tag
        : p.state === "down"
          ? "DOWN"
          : p.state === "degraded"
            ? "degraded"
            : p.state === "limit"
              ? "LIMIT"
              : p.state;
    active.push({
      name,
      state: p.state,
      text,
      title: `${p.label}: ${p.state}${p.detail ? ` — ${p.detail}` : ""}`,
    });
  }
  return {
    active,
    off: [...off.entries()].map(([reason, g]) => ({
      reason,
      names: g.names,
      title: `Disabled — ${g.details.join(" · ")}`,
    })),
    na: false,
  };
}

/** OFFLINE badge (SPEC §6.3): providers unreachable, values served from cache as STALE. */
export function networkBadge(
  h: Schemas["Health"] | undefined,
): { text: "OFFLINE"; title: string } | null {
  if (!h || h.network !== "offline") return null;
  const since = h.offline_since
    ? ` since ${fmtDate(h.offline_since)} ${fmtHM(h.offline_since)}`
    : "";
  const next =
    h.reconnect_in_s != null
      ? ` · reconnecting in ${Math.ceil(h.reconnect_in_s)} s`
      : " · reconnecting";
  return {
    text: "OFFLINE",
    title: `Data providers unreachable${since}${next}. Cached values are shown with STALE.`,
  };
}

/** PROV quota cell: requests used of the budget in the current window (or stream symbols). */
export function quotaText(
  p: Pick<Provider, "quota_limit" | "quota_used" | "quota_left" | "quota_period">,
): string {
  if (p.quota_limit == null || p.quota_used == null) return NA;
  return p.quota_period === "symbols"
    ? `${p.quota_used}/${p.quota_limit} symbols`
    : `${p.quota_used}/${p.quota_limit} per ${p.quota_period ?? "window"}`;
}
