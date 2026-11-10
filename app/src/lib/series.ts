/** Small pure helpers over bar series (sparklines, session slices). */

/** The bars of the last session in a series (the newest bar's date), for the sparkline. */
export function lastSession<T extends { t: number }>(bars: readonly T[]): T[] {
  if (!bars.length) return [];
  const day = (t: number) => Math.floor(t / 86400);
  const last = day(bars[bars.length - 1]!.t);
  return bars.filter((b) => day(b.t) === last);
}

/** SVG user units to 0.1 (geometry, not a displayed value). */
const r1 = (x: number) => Math.round(x * 10) / 10;

/** SVG polyline points scaling `values` into a w×h box (flat series sit in the middle). */
export function sparkPoints(values: readonly number[], w: number, h: number): string {
  if (values.length < 2) return "";
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo;
  const step = w / (values.length - 1);
  return values
    .map((v, i) => {
      const y = span ? h - ((v - lo) / span) * h : h / 2;
      return `${r1(i * step)},${r1(y)}`;
    })
    .join(" ");
}
