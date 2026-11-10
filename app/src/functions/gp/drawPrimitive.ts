/**
 * Renders GP drawings on the main series' pane. lightweight-charts has no drawing tools
 * (SPEC §3), so this is a series primitive behind our own model (drawings.ts).
 */
import type {
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesPrimitive,
  Logical,
  SeriesAttachedParameter,
  Time,
} from "lightweight-charts";
import { FIB_LABELS, fibPrices, logicalOf, type Drawing } from "./drawings";

type Target = Parameters<IPrimitivePaneRenderer["draw"]>[0];

export interface DrawStyle {
  line: string;
  dim: string;
  text: string;
  font: string;
  /** Price label through the shared formatter (§4.2). */
  price: (p: number) => string;
}

export class DrawingsPrimitive implements ISeriesPrimitive<Time> {
  private param: SeriesAttachedParameter<Time> | null = null;
  private items: readonly Drawing[] = [];
  private preview: Drawing | null = null;
  /** Bar times of the main series (venue wall clock), for anchor → bar index. */
  private times: readonly number[] = [];
  private readonly views: readonly IPrimitivePaneView[];

  constructor(private style: DrawStyle) {
    const renderer: IPrimitivePaneRenderer = { draw: (t) => this.draw(t) };
    this.views = [{ zOrder: () => "top", renderer: () => renderer }];
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

  set(patch: {
    items?: readonly Drawing[];
    preview?: Drawing | null;
    times?: readonly number[];
    style?: DrawStyle;
  }): void {
    if (patch.items) this.items = patch.items;
    if (patch.preview !== undefined) this.preview = patch.preview;
    if (patch.times) this.times = patch.times;
    if (patch.style) this.style = patch.style;
    this.param?.requestUpdate();
  }

  private draw(target: Target): void {
    const param = this.param;
    if (!param) return;
    const ts = param.chart.timeScale();
    const series = param.series;
    const x = (t: number) => {
      const l = logicalOf(this.times, t);
      return l === null ? null : ts.logicalToCoordinate(l as Logical);
    };
    const y = (p: number) => series.priceToCoordinate(p);
    const st = this.style;
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      ctx.save();
      ctx.font = st.font;
      ctx.lineWidth = 1;
      const all = this.preview ? [...this.items, this.preview] : this.items;
      all.forEach((d) => {
        const preview = d === this.preview;
        ctx.setLineDash(preview ? [4, 3] : []);
        ctx.strokeStyle = st.line;
        ctx.fillStyle = st.text;
        const ax = x(d.a.t);
        const ay = y(d.a.p);
        if (ay === null) return;
        if (d.kind === "HLINE") {
          line(ctx, 0, ay, mediaSize.width, ay);
          ctx.fillText(st.price(d.a.p), 4, ay - 3);
          return;
        }
        if (ax === null) return;
        if (d.kind === "TEXT") {
          ctx.fillText(d.text ?? "", ax, ay);
          return;
        }
        const b = d.b;
        const bx = b ? x(b.t) : null;
        const by = b ? y(b.p) : null;
        if (!b || bx === null || by === null) return;
        if (d.kind === "TREND") {
          line(ctx, ax, ay, bx, by);
        } else if (d.kind === "RECT") {
          ctx.strokeRect(Math.min(ax, bx), Math.min(ay, by), Math.abs(bx - ax), Math.abs(by - ay));
          ctx.globalAlpha = 0.08;
          ctx.fillStyle = st.line;
          ctx.fillRect(Math.min(ax, bx), Math.min(ay, by), Math.abs(bx - ax), Math.abs(by - ay));
          ctx.globalAlpha = 1;
        } else if (d.kind === "FIB") {
          const left = Math.min(ax, bx);
          const right = Math.max(ax, bx);
          fibPrices(d.a, b).forEach((p, i) => {
            const ly = y(p);
            if (ly === null) return;
            ctx.strokeStyle = i === 0 || i === 6 ? st.line : st.dim;
            line(ctx, left, ly, right, ly);
            ctx.fillStyle = st.text;
            ctx.fillText(`${FIB_LABELS[i]} ${st.price(p)}`, left + 3, ly - 3);
          });
          ctx.strokeStyle = st.dim;
          ctx.setLineDash([2, 3]);
          line(ctx, ax, ay, bx, by);
        }
      });
      ctx.restore();
    });
  }
}

function line(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number) {
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}
