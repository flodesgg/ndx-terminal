import { useLiveQuotes } from "@/core/live";
import { fmtPct, fmtPrice } from "@/lib/format";
import { freshnessClass, freshnessLabel, provenance, useNow } from "@/lib/freshness";
import { Sgn } from "@/components/V";
import { useWatchlists } from "./watchlists";

/** Scrolling tape of the first watchlist. Only symbols with real data are shown. */
export function Tape() {
  const lists = useWatchlists();
  const symbols = lists.data?.[0]?.symbols ?? [];
  const quotes = useLiveQuotes(symbols);
  const now = useNow();
  const items = symbols
    .map((s) => ({ s, q: quotes.get(s)?.quote, meta: quotes.get(s)?.meta }))
    .filter((x) => x.q?.price != null);
  if (!items.length) {
    return (
      <div className="tape">
        <span className="dim" style={{ paddingLeft: 8 }}>
          TAPE · waiting for {lists.data?.[0]?.name ?? "watchlist"} quotes…
        </span>
      </div>
    );
  }
  const duration = Math.max(30, items.length * 6);
  return (
    <div className="tape" title={`Ticker tape: ${lists.data?.[0]?.name} (⌥T to hide)`}>
      {/* Two copies + translate(-50%) = seamless loop that starts filled. */}
      <div className="tape-inner" style={{ animationDuration: `${duration}s` }}>
        {[0, 1].map((copy) =>
          items.map(({ s, q, meta }) => {
            // §1.3/§6.1: every value shows its freshness; hover gives the provenance.
            const label = meta ? freshnessLabel(meta, now) : null;
            return (
              <span
                key={`${copy}-${s}`}
                className="tape-item"
                title={meta ? provenance(meta) : undefined}
              >
                <b>{s}</b>
                {fmtPrice(q!.price, s)}{" "}
                <Sgn as="span" v={q!.change_pct}>
                  {fmtPct(q!.change_pct)}
                </Sgn>
                {label ? (
                  <>
                    {" "}
                    <span className={`lat lat-${freshnessClass(label)}`}>{label}</span>
                  </>
                ) : null}
              </span>
            );
          }),
        )}
      </div>
    </div>
  );
}
