/** HTTP client for the local data service. */
import type { components } from "@shared/api";

export type Schemas = components["schemas"];
export type Meta = Schemas["Meta"];
export type ErrorBody = Schemas["ErrorBody"];

export interface BackendInfo {
  port: number;
  token: string;
}

let infoPromise: Promise<BackendInfo> | null = null;

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function resolveInfo(): Promise<BackendInfo> {
  if (isTauri()) {
    const { invoke } = await import("@tauri-apps/api/core");
    // The Rust shell blocks until the sidecar (or dev server) answers /health.
    return invoke<BackendInfo>("backend_info");
  }
  // Browser mode: the Vite dev server hands out the per-launch port + token (never in the bundle).
  const res = await fetch("/__ndx/backend", { cache: "no-store" });
  if (!res.ok) throw new Error(`backend info unavailable (HTTP ${res.status}); run \`make dev\``);
  return (await res.json()) as BackendInfo;
}

export function backendInfo(): Promise<BackendInfo> {
  infoPromise ??= resolveInfo().catch((e: unknown) => {
    infoPromise = null;
    throw e;
  });
  return infoPromise;
}

export class ApiError extends Error {
  /** When the answer arrived (ms since epoch): a queue turn counts from here. */
  readonly at = Date.now();
  constructor(
    readonly status: number,
    readonly body: ErrorBody | null,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
  get code(): string {
    return this.body?.code ?? (this.status === 0 ? "offline" : "upstream");
  }
  /** Rate-limited with a place in the provider's queue: seconds until its turn, else null. */
  get retryAfterS(): number | null {
    return this.code === "rate_limited" ? (this.body?.retry_after_s ?? null) : null;
  }
}

/** A request holding a place in a provider's queue (its own per-minute budget): which
 * provider, and when (ms since epoch) the request is repeated. Null for anything else. */
export function queuedTurn(e: unknown): { provider: string; at: number } | null {
  if (!(e instanceof ApiError)) return null;
  const s = e.retryAfterS;
  if (s === null) return null;
  return { provider: e.body?.provider ?? "provider", at: e.at + s * 1000 };
}

type Params = Record<string, string | number | boolean | undefined | null>;

export async function baseUrl(): Promise<string> {
  const { port } = await backendInfo();
  return `http://127.0.0.1:${port}`;
}

export async function request<T>(
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  opts: { params?: Params; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  const info = await backendInfo();
  const url = new URL(`http://127.0.0.1:${info.port}${path}`);
  for (const [k, v] of Object.entries(opts.params ?? {})) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      signal: opts.signal,
      headers: {
        "x-ndx-token": info.token,
        ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    throw new ApiError(0, null, "Backend unreachable");
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    const body = json as Partial<ErrorBody> & { detail?: unknown };
    const msg =
      typeof body?.error === "string"
        ? body.error
        : typeof body?.detail === "string"
          ? body.detail
          : `HTTP ${res.status}`;
    throw new ApiError(res.status, body?.error ? (body as ErrorBody) : null, msg);
  }
  return json as T;
}

export const api = {
  get: <T>(path: string, params?: Params, signal?: AbortSignal) =>
    request<T>("GET", path, { params, signal }),
  post: <T>(path: string, body?: unknown) => request<T>("POST", path, { body }),
  put: <T>(path: string, body?: unknown) => request<T>("PUT", path, { body }),
  del: <T>(path: string) => request<T>("DELETE", path),
};

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}

export function clientLog(level: "debug" | "info" | "warn" | "error", message: string): void {
  void api.post("/logs/client", { level, message }).catch(() => undefined);
}
