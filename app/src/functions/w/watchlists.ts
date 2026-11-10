import { useQuery, type QueryClient } from "@tanstack/react-query";
import { api, type Schemas } from "@/core/api";

export type Watchlist = Schemas["Watchlist"];

export const WL_KEY = ["watchlists"] as const;

export function useWatchlists() {
  return useQuery({
    queryKey: WL_KEY,
    queryFn: () => api.get<Watchlist[]>("/watchlists"),
    staleTime: 60_000,
  });
}

let client: QueryClient | null = null;
export function setWatchlistClient(c: QueryClient): void {
  client = c;
}
export function watchlistClient(): QueryClient | null {
  return client;
}

async function fresh(): Promise<Watchlist[]> {
  const lists = await api.get<Watchlist[]>("/watchlists");
  client?.setQueryData(WL_KEY, lists);
  return lists;
}

export async function findList(name: string | undefined): Promise<Watchlist> {
  const lists = await fresh();
  if (!lists.length) throw new Error("No watchlists. Create one: W NEW <NAME>");
  if (!name) return lists[0]!;
  const w = lists.find((l) => l.name === name.toUpperCase());
  if (!w) throw new Error(`No watchlist ${name}. Lists: ${lists.map((l) => l.name).join(", ")}`);
  return w;
}

/** Replace a list's rows: symbols and "#name" group headers, in order. */
export async function setSymbols(list: Watchlist, rows: string[]): Promise<Watchlist> {
  const w = await api.put<Watchlist>(`/watchlists/${list.id}/items`, { symbols: rows });
  await fresh();
  return w;
}

export async function createList(name: string): Promise<Watchlist> {
  const w = await api.post<Watchlist>("/watchlists", { name });
  await fresh();
  return w;
}

export async function deleteList(list: Watchlist): Promise<void> {
  await api.del(`/watchlists/${list.id}`);
  await fresh();
}
