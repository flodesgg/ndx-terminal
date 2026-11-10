import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type Schemas } from "@/core/api";
import { executeCommand } from "@/core/executor";
import { fmtHM, fmtNum } from "@/lib/format";
import { marketGroups, networkBadge, providerSummary } from "@/lib/statusbar";

const CLOCKS: { label: string; tz: string }[] = [
  { label: "NY", tz: "America/New_York" },
  { label: "LDN", tz: "Europe/London" },
  { label: "TYO", tz: "Asia/Tokyo" },
  { label: "CPH", tz: "Europe/Copenhagen" },
];

export function StatusBar() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  const health = useQuery({
    queryKey: ["health"],
    queryFn: async () => {
      const t0 = performance.now();
      const h = await api.get<Schemas["Health"]>("/health");
      return { h, ms: Math.round(performance.now() - t0) };
    },
    refetchInterval: 5000,
    retry: false,
  });
  const markets = useQuery({
    queryKey: ["markets"],
    queryFn: () => api.get<Schemas["ExchangeStatus"][]>("/markets"),
    refetchInterval: 60_000,
    retry: 1,
  });
  const providers = useQuery({
    queryKey: ["providers"],
    queryFn: () => api.get<Schemas["ProviderStatus"][]>("/providers"),
    refetchInterval: 10_000,
    retry: false,
  });

  const backendOk = health.isSuccess && !health.isError;

  // A failed refetch keeps the last data in the cache: states that may be out of date are not
  // shown next to MARKETS N.A. (review 1b #8).
  const groups = markets.isError ? [] : marketGroups(markets.data ?? []);
  const prov = providerSummary(providers.isError ? undefined : (providers.data ?? []));
  const offline = backendOk ? networkBadge(health.data.h) : null;

  return (
    <div className="statusbar" data-testid="status-bar">
      {CLOCKS.map((c) => (
        <span key={c.label} className="clock" data-testid="clock" title={c.tz}>
          <b>{c.label}</b>
          {fmtHM(now, c.tz)}
        </span>
      ))}
      <span className="sb-sep" />
      {offline ? (
        <span className="sb-offline" data-testid="offline" title={offline.title}>
          <span className="dot dot-down" />
          {offline.text}
        </span>
      ) : null}
      <span className="sb-markets" data-testid="markets">
        {groups.map((g) => (
          <span key={g.label} className="mkt" data-state={g.label}>
            <span className={`dot ${g.dot}`} />
            <span className="sb-label">{g.label}</span>
            {g.codes.map((c) => (
              <span key={c.code} className="mkt-code" title={c.title}>
                {c.code}
              </span>
            ))}
          </span>
        ))}
        {markets.isError ? <span className="dim">MARKETS N.A.</span> : null}
      </span>
      <div
        className="sb-right"
        data-testid="providers"
        title="Provider status (PROV for details)"
        onClick={() => void executeCommand("PROV")}
      >
        {prov.na ? <span className="dim">PROVIDERS N.A.</span> : null}
        {prov.active.map((p) => (
          <span key={p.name} className="mkt" title={p.title} data-provider={p.name}>
            <span className={`dot dot-${p.state}`} />
            {p.name} <span className="sb-label">{p.text}</span>
          </span>
        ))}
        {prov.off.map((o) => (
          <span key={o.reason} className="mkt sb-off" title={o.title} data-off={o.reason}>
            <span className="dot dot-disabled" />
            off ({o.reason}): {o.names.join(" ")}
          </span>
        ))}
        <span title={health.error ? String(health.error) : "local data service, round trip"}>
          {health.isPending ? (
            <>
              <span className="dot dot-na" />
              <span className="dim">SERVER N.A.</span>
            </>
          ) : (
            <>
              <span className={`dot ${backendOk ? "dot-ok" : "dot-down"}`} />
              {backendOk ? `SERVER ${fmtNum(health.data.ms, 0)} ms` : "SERVER DOWN"}
            </>
          )}
        </span>
      </div>
    </div>
  );
}
