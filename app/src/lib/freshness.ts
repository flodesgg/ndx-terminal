/**
 * Freshness tags (SPEC §6.1). The backend sends the base tag (`meta.tag`: RT, RT·<venue>, D{n},
 * EOD, CACHE, STALE, DEMO); the UI adds the cache time and turns any value into STALE once it
 * has not been refreshed for longer than `stale_after_s` (2× the expected refresh).
 */
import { useSyncExternalStore } from "react";
import type { Meta } from "@/core/api";
import { NA, fmtDate, fmtHM, fmtTime, userTimeZone } from "./format";

export function isStale(meta: Meta, now: number): boolean {
  if (meta.tag === "STALE") return true;
  if (meta.stale_after_s == null) return false;
  const fetched = Date.parse(meta.fetched_at);
  return Number.isFinite(fetched) && now - fetched > meta.stale_after_s * 1000;
}

/** Display tag: `RT·TRD`, `D15`, `EOD`, `CACHE 09:42`, `STALE`, `DEMO`. */
export function freshnessLabel(meta: Meta, now: number, tz: string = userTimeZone()): string {
  if (meta.tag === "DEMO") return "DEMO";
  if (isStale(meta, now)) return "STALE";
  if (meta.tag === "CACHE") {
    const t = fmtHM(meta.fetched_at, tz);
    return t === NA ? "CACHE" : `CACHE ${t}`;
  }
  return meta.tag;
}

/** CSS class family for the tag: RT, D, EOD, CACHE, STALE, DEMO. */
export function freshnessClass(label: string): string {
  if (label.startsWith("RT")) return "RT";
  if (/^D\d+$/.test(label)) return "D";
  return label.split(" ")[0]!;
}

/** Hover card text (SPEC §1.3): provider, provider symbol, as_of, fetched_at. */
export function provenance(meta: Meta, tz: string = userTimeZone()): string {
  const fmt = (iso: string | null | undefined) =>
    fmtDate(iso, tz) === NA ? NA : `${fmtDate(iso, tz)} ${fmtTime(iso, false, tz)}`;
  const lines = [
    `Provider: ${meta.source}`,
    `Provider symbol: ${meta.provider_symbol ?? NA}`,
    `As of: ${fmt(meta.as_of)}`,
    `Fetched: ${fmt(meta.fetched_at)}`,
  ];
  if (meta.personal_use)
    lines.push("PERSONAL USE: unofficial source, enabled by you in PDF (opt-in).");
  if (meta.note) lines.push(meta.note);
  return lines.join("\n");
}

// One shared 1 s clock for every tag on screen (STALE needs re-evaluation as time passes).
let now = Date.now();
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  timer ??= setInterval(() => {
    now = Date.now();
    listeners.forEach((l) => l());
  }, 1000);
  return () => {
    listeners.delete(cb);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

const snapshot = () => now;

export function useNow(): number {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** SPEC §6.1: a `RT·REF` value is a derived reference price; its bid/ask are the vendor's
 * estimates (Tiingo), so they are labelled `est.`. */
export function bookIsEstimated(meta: Pick<Meta, "venue"> | null | undefined): boolean {
  return meta?.venue === "REF";
}
