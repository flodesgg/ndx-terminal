/**
 * US extended hours shaded on intraday GP charts (SPEC §8): bars starting before 09:30 or at
 * 16:00 New York time and later, drawn behind the series as one band per run of such bars.
 */
import type {
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesPrimitive,
  Logical,
  SeriesAttachedParameter,
  Time,
} from "lightweight-charts";

type Target = Parameters<IPrimitivePaneRenderer["draw"]>[0];

const OPEN_S = 9.5 * 3600;
const CLOSE_S = 16 * 3600;

/** Bar times are New York wall clock as unix seconds: the time of day is `t % 86400`. */
export const isUsExtended = (t: number) => {
  const s = ((t % 86400) + 86400) % 86400;
  return s < OPEN_S || s >= CLOSE_S;
};

/** Runs [first, last] of consecutive bar indices that are extended hours. */
export function extendedRuns(times: readonly number[]): [number, number][] {
  const out: [number, number][] = [];
  let start = -1;
  times.forEach((t, i) => {
    if (isUsExtended(t)) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      out.push([start, i - 1]);
      start = -1;
    }
  });
  if (start >= 0) out.push([start, times.length - 1]);
  return out;
}

export class SessionShade implements ISeriesPrimitive<Time> {
  private param: SeriesAttachedParameter<Time> | null = null;
  private runs: [number, number][] = [];
  private readonly views: readonly IPrimitivePaneView[];

  constructor(private color: string) {
    const renderer: IPrimitivePaneRenderer = {
      draw: () => undefined,
      drawBackground: (t) => this.draw(t),
    };
    this.views = [{ zOrder: () => "bottom", renderer: () => renderer }];
  }

  attached(param: SeriesAttachedParameter<Time>): void {
    this.param = param;
  }
  detached(): void {
    this.param = null;
  }
  paneViews(): readonly IPrimitivePaneView[] {
    return this.views;
  }

  /** Bar times to shade (empty: nothing, e.g. daily bars or not a US stock). */
  set(times: readonly number[], color?: string): void {
    this.runs = extendedRuns(times);
    if (color) this.color = color;
    this.param?.requestUpdate();
  }

  private draw(target: Target): void {
    const param = this.param;
    if (!param || !this.runs.length) return;
    const ts = param.chart.timeScale();
    const half = ts.options().barSpacing / 2;
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      ctx.fillStyle = this.color;
      for (const [a, b] of this.runs) {
        const x1 = ts.logicalToCoordinate(a as Logical);
        const x2 = ts.logicalToCoordinate(b as Logical);
        if (x1 === null || x2 === null) continue;
        if (x2 + half < 0 || x1 - half > mediaSize.width) continue;
        ctx.fillRect(x1 - half, 0, x2 - x1 + 2 * half, mediaSize.height);
      }
    });
  }
}
