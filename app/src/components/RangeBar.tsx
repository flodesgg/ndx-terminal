import { fmtPrice } from "@/lib/format";
import { NAValue } from "@/components/V";

/** Horizontal low–high range with a marker at `value`. Renders nothing without real data. */
export function RangeBar({
  low,
  high,
  value,
  label,
  symbol,
}: {
  /** Instrument, for class precision (SPEC §4.2). */
  symbol?: string;
  low: number | null | undefined;
  high: number | null | undefined;
  value: number | null | undefined;
  label: string;
}) {
  if (low == null || high == null || value == null || high <= low) {
    return (
      <div className="kv" style={{ gridTemplateColumns: "90px 1fr" }}>
        <dt>{label}</dt>
        <dd>
          <NAValue />
        </dd>
      </div>
    );
  }
  const pct = Math.min(100, Math.max(0, ((value - low) / (high - low)) * 100));
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "90px 80px 1fr 80px",
        gap: 8,
        padding: "2px 8px",
        alignItems: "center",
      }}
    >
      <span className="amber">{label}</span>
      <span style={{ textAlign: "right" }}>{fmtPrice(low, symbol)}</span>
      <div style={{ position: "relative", height: 6, background: "var(--grid-line)" }}>
        <div
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            bottom: 0,
            width: `${pct}%`,
            background: "var(--range-fill)",
          }}
        />
        <div
          style={{
            position: "absolute",
            left: `calc(${pct}% - 1px)`,
            top: -3,
            width: 3,
            height: 12,
            background: "var(--fg)",
          }}
        />
      </div>
      <span>{fmtPrice(high, symbol)}</span>
    </div>
  );
}
