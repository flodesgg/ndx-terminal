/** Intraday sparkline of the last session (5-minute bars); N.A. without an intraday source. */
import type { Schemas } from "@/core/api";
import { useApi } from "@/core/data";
import { lastSession } from "@/lib/series";
import { Sparkline } from "@/components/Sparkline";

export function Spark({
  symbol,
  change,
  defer,
}: {
  symbol: string;
  change: number | null | undefined;
  defer: boolean;
}) {
  const q = useApi<Schemas["BarsResponse"]>(
    `/bars/${encodeURIComponent(symbol)}`,
    { interval: "5m", lookback: 5, defer: defer || undefined },
    { refetchMs: 300_000, staleMs: 60_000 },
  );
  const bars = lastSession(q.data?.data ?? []);
  const why = q.error ? (q.error as Error).message : q.isLoading ? "loading" : "no intraday bars";
  return (
    <Sparkline
      values={bars.map((b) => b.c)}
      change={change}
      label={`${symbol} intraday`}
      title={`${q.data?.meta.source ?? ""} ${q.data?.meta.tag ?? ""} · last session, 5m`}
      naTitle={`intraday: ${why}`}
    />
  );
}
