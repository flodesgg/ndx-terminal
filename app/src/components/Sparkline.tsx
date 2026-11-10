import { NAValue } from "@/components/V";
import { signClass } from "@/lib/format";
import { sparkPoints } from "@/lib/series";

/** A small line of a series' closes, coloured by the day's change; N.A. with its reason when
 * there are fewer than two points. */
export function Sparkline({
  values,
  change,
  label,
  title,
  naTitle,
  width = 64,
  height = 14,
}: {
  values: readonly number[];
  change: number | null | undefined;
  label: string;
  title: string;
  naTitle: string;
  width?: number;
  height?: number;
}) {
  const pts = sparkPoints(values, width, height);
  if (!pts)
    return (
      <span title={naTitle} data-testid="spark-na">
        <NAValue />
      </span>
    );
  return (
    <svg
      width={width}
      height={height}
      className={signClass(change)}
      data-testid="spark"
      aria-label={label}
    >
      <title>{title}</title>
      <polyline points={pts} fill="none" stroke="currentColor" strokeWidth={1} />
    </svg>
  );
}
