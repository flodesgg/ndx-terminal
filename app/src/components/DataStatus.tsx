import type { ReactNode } from "react";
import { ApiError, errorMessage, queuedTurn, type Meta } from "@/core/api";
import { fmtTime } from "@/lib/format";
import { freshnessClass, freshnessLabel, isStale, provenance, useNow } from "@/lib/freshness";

/** Freshness tag (SPEC §6.1) with the provenance hover card (§1.3) and PERSONAL USE marker. */
export function LatencyTag({ meta, stale }: { meta: Meta; stale?: boolean }) {
  const now = useNow();
  const label = stale ? "STALE" : freshnessLabel(meta, now);
  return (
    <span title={provenance(meta)} tabIndex={0} className="lat-wrap">
      <span className={`lat lat-${freshnessClass(label)}`}>{label}</span>
      {meta.personal_use ? <span className="personal-use"> PERSONAL USE</span> : null}
    </span>
  );
}

/**
 * Provenance line shown at the top of every data panel:
 * source · latency label · data timestamp · fetch time. On error a red banner is shown with the
 * time of the data still on screen; that data turns STALE by age only (§6.1: older than 2× the
 * expected refresh), never just because one refetch failed (review 1a #20).
 */
export function DataStatus({
  meta,
  error,
  fetching,
  updatedAt,
  extra,
  waiting,
}: {
  meta?: Meta | null;
  error?: unknown;
  fetching?: boolean;
  updatedAt?: number;
  extra?: ReactNode;
  /** The failure a fetch in progress is retrying after (react-query `failureReason`). */
  waiting?: unknown;
}) {
  const now = useNow();
  const stale = !!meta && isStale(meta, now);
  return (
    <>
      {fetching && waiting ? <QueueWait reason={waiting} /> : null}
      {error ? (
        <ErrorBanner error={error} stale={stale} updatedAt={meta ? updatedAt : undefined} />
      ) : null}
      {meta ? (
        <div className="ds">
          <LatencyTag meta={meta} />
          <span>
            SRC <span className="src">{meta.source}</span>
          </span>
          {meta.as_of ? <span>AS OF {fmtTime(meta.as_of, true)}</span> : null}
          <span>FETCHED {fmtTime(meta.fetched_at)}</span>
          {meta.cached ? <span>CACHED</span> : null}
          {meta.attempts.length > 1 ? (
            <span className="amber">FALLBACK ({meta.attempts.join(" → ")})</span>
          ) : null}
          {meta.note ? (
            <span
              className="dim"
              title={meta.note}
              style={{ overflow: "hidden", textOverflow: "ellipsis" }}
            >
              {meta.note}
            </span>
          ) : null}
          {fetching ? <span className="cyan">…</span> : null}
          {extra}
        </div>
      ) : null}
    </>
  );
}

/** A request waiting for its turn in a provider's budget: not a failure, it repeats itself. */
export function QueueWait({ reason }: { reason: unknown }) {
  const now = useNow();
  const turn = queuedTurn(reason);
  if (!turn) return null;
  const s = Math.max(0, Math.ceil((turn.at - now) / 1000));
  return (
    <div className="ds-wait" data-testid="rate-wait">
      {`waiting for ${turn.provider} rate limit, retry in ${s} s`}
    </div>
  );
}

export function ErrorBanner({
  error,
  stale,
  updatedAt,
}: {
  error: unknown;
  stale?: boolean;
  updatedAt?: number;
}) {
  const code = error instanceof ApiError ? error.code.toUpperCase() : "ERROR";
  // No enabled source is a configuration state, not a failed fetch: neutral N.A., not red.
  // Asked by a window not in focus: a tight-budget source waits until it is focused.
  if (code === "DEFERRED") {
    return (
      <div className="ds-na" data-testid="deferred">
        {errorMessage(error)}
      </div>
    );
  }
  if (code === "NO_PROVIDER") {
    return (
      <div className="ds-na" data-testid="no-source">
        <b>N.A.</b> NO SOURCE — {errorMessage(error)}
      </div>
    );
  }
  return (
    <div className="ds-err">
      <b>FETCH FAILED [{code}]</b> {errorMessage(error)}
      {error instanceof ApiError && error.body?.attempts?.length ? (
        <> · tried: {error.body.attempts.join(", ")}</>
      ) : null}
      {updatedAt ? (
        <>
          {" "}
          · showing data from {fmtTime(new Date(updatedAt).toISOString())}
          {stale ? " — STALE" : ""}
        </>
      ) : null}
    </div>
  );
}

export function Loading({ what }: { what?: string }) {
  return <div className="loading">LOADING{what ? ` ${what}` : ""}…</div>;
}
