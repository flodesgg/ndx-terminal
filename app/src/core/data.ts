/** Data-fetch hooks. Every data payload from the server carries `meta` (source + latency). */
import { useQueries, useQuery, type UseQueryResult } from "@tanstack/react-query";
import { api, queuedTurn, type Meta } from "./api";

export interface Envelope<T> {
  meta: Meta;
  data: T;
}

type Params = Record<string, string | number | boolean | undefined | null>;

export function useApi<T>(
  path: string | null,
  params?: Params,
  opts: { refetchMs?: number | false; staleMs?: number; enabled?: boolean } = {},
): UseQueryResult<T> {
  return useQuery<T>({
    queryKey: [path, params],
    queryFn: ({ signal }) => api.get<T>(path!, params, signal),
    enabled: path !== null && (opts.enabled ?? true),
    refetchInterval: opts.refetchMs ?? false,
    staleTime: opts.staleMs ?? 0,
    retry: shouldRetry,
    retryDelay: retryDelayMs,
  });
}

/** useApi for a variable number of paths with the same params (e.g. GP compare overlays);
 * the query keys match useApi's, so the same request elsewhere shares the cache. */
export function useApiMany<T>(
  paths: readonly string[],
  params?: Params,
  opts: { refetchMs?: number | false; staleMs?: number; enabled?: boolean } = {},
): UseQueryResult<T>[] {
  return useQueries({
    queries: paths.map((path) => ({
      queryKey: [path, params],
      queryFn: ({ signal }: { signal: AbortSignal }) => api.get<T>(path, params, signal),
      enabled: opts.enabled ?? true,
      refetchInterval: opts.refetchMs ?? false,
      staleTime: opts.staleMs ?? 0,
      retry: shouldRetry,
      retryDelay: retryDelayMs,
    })),
  });
}

/** Repeats of a request queued for a provider's budget (Massive: 4 calls/min, so a dozen
 * windows wait about 3 minutes); each repeat lands on the turn the backend holds for it. */
export const QUEUE_RETRIES = 30;
/** A little after the turn: the client's timer is not exact. */
const TURN_MARGIN_MS = 300;

export function shouldRetry(count: number, err: unknown): boolean {
  if (queuedTurn(err)) return count < QUEUE_RETRIES;
  const code = (err as { code?: string }).code;
  if (code === "not_found" || code === "bad_request" || code === "no_provider") return false;
  if (code === "deferred") return false; // asked again when the window is focused
  return count < 1;
}

export function retryDelayMs(count: number, err: unknown): number {
  const turn = queuedTurn(err);
  if (turn) return Math.max(0, turn.at - Date.now()) + TURN_MARGIN_MS;
  return Math.min(1000 * 2 ** count, 30_000); // react-query's default back-off
}
