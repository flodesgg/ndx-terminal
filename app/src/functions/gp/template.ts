/**
 * GP template (`S`, SPEC §8 "S save template"): the bar size, range, chart type, studies,
 * scale and markers a new GP window opens with. Stored in user.db (`/settings/gp-template`).
 */
import { create } from "zustand";
import { api } from "@/core/api";
import { formatGpArgs, parseGpArgs, type GpState } from "./args";

const KEY = "/settings/gp-template";

export const useGpTemplate = create<{ state: "idle" | "loading" | "ready"; args: string[] }>(
  () => ({ state: "idle", args: [] }),
);

/** What a template keeps: the view, not this security's window, overlays or lines. */
export function templateArgs(st: GpState): string[] {
  return formatGpArgs({ ...st, from: undefined, to: undefined, cmp: [], lines: [] });
}

export function parseTemplate(raw: unknown): string[] {
  const args = (raw as { args?: unknown } | null)?.args;
  if (!Array.isArray(args) || !args.every((a) => typeof a === "string")) return [];
  return templateArgs(parseGpArgs(args as string[]));
}

export async function loadGpTemplate(): Promise<void> {
  if (useGpTemplate.getState().state !== "idle") return;
  useGpTemplate.setState({ state: "loading" });
  const raw = await api.get<unknown>(KEY).catch(() => null);
  useGpTemplate.setState({ state: "ready", args: parseTemplate(raw) });
}

export async function saveGpTemplate(st: GpState): Promise<string[]> {
  const args = templateArgs(st);
  await api.put(KEY, { args });
  useGpTemplate.setState({ state: "ready", args });
  return args;
}
