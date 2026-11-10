import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AreaSeries,
  BarSeries,
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  LineStyle,
  PriceScaleMode,
  createChart,
  createSeriesMarkers,
  type ISeriesMarkersPluginApi,
  type SeriesMarker,
  type Time,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type MouseEventParams,
  type UTCTimestamp,
} from "lightweight-charts";
import type { Schemas } from "@/core/api";
import { useApi, useApiMany } from "@/core/data";
import { usePanelKeys } from "@/core/keys";
import { useLiveBars, useLiveQuote, type Bar } from "@/core/live";
import type { PanelProps } from "@/core/registry";
import { DataStatus, LatencyTag, Loading } from "@/components/DataStatus";
import {
  chartNumberFormat,
  chartPriceFormat,
  chartSpreadFormat,
  chartTimeFormat,
  fmtBig,
  fmtDate,
  fmtNum,
  fmtPct,
  fmtPrice,
  priceClassOf,
  signClass,
} from "@/lib/format";
import { Sgn } from "@/components/V";
import { atr, bollinger, ema, macd, rsi, sma, vwap, type Series } from "@/lib/indicators";
import {
  CHART_TYPES,
  EVENT_KINDS,
  INDICATORS,
  NUMBERED_RANGES,
  TIMEFRAMES,
  dateSec,
  formatGpArgs,
  isDate,
  isIntraday,
  lookbackFor,
  parseGpArgs,
  rangeStart,
  timeframe,
  toggle,
  type ChartType,
  type EventKind,
  type GpState,
  type Indicator,
} from "./args";
import { token, withAlpha } from "@/theme/tokens";
import { MAX_COMPARE, rebase, type ComparePoint } from "./compare";
import {
  DRAW_KINDS,
  DRAW_LABEL,
  DRAW_POINTS,
  MAX_TEXT,
  timeAtLogical,
  type Anchor,
  type DrawKind,
  type Drawing,
} from "./drawings";
import { DrawingsPrimitive, type DrawStyle } from "./drawPrimitive";
import { loadDrawings, saveDrawings, useDrawings } from "./drawStore";
import { placeEvents, type ChartEvent } from "./events";
import { SessionShade } from "./sessionShade";
import { loadGpTemplate, saveGpTemplate, useGpTemplate } from "./template";

type BarsResponse = Schemas["BarsResponse"];
type EventsResponse = Schemas["EventsResponse"];

const EVENT_LABEL: Record<EventKind, string> = {
  E: "earnings",
  D: "dividends",
  S: "splits",
};
const EVENT_STYLE: Record<EventKind, { color: () => string; position: "aboveBar" | "belowBar" }> = {
  E: { color: () => token("amber"), position: "aboveBar" },
  D: { color: () => token("up"), position: "belowBar" },
  S: { color: () => token("link"), position: "aboveBar" },
};

/** One event for the legend, values through the shared formatters (§4.2). */
function eventText(e: ChartEvent): string {
  if (e.kind === "D" && e.value != null) {
    const cents = Math.round(e.value * 100) === e.value * 100;
    return `${e.title} ${fmtNum(e.value, cents ? 2 : 4)}${e.currency ? ` ${e.currency}` : ""}`;
  }
  return e.title;
}

// Up/down follow the PDF COLORS palette, so they are read when a chart is drawn.
const C = {
  get up() {
    return token("up");
  },
  get down() {
    return token("down");
  },
  get upVol() {
    return withAlpha("up", 0.35);
  },
  get downVol() {
    return withAlpha("down", 0.35);
  },
  amber: token("amber"),
  cyan: token("link"),
  grid: token("chart-grid"),
  text: token("amber-dim"),
};

const OVERLAY_COLORS = {
  sma20: token("series-1"),
  sma50: token("series-2"),
  sma200: token("series-3"),
  ema9: token("series-4"),
  ema21: token("series-5"),
  bb: token("series-6"),
  vwap: token("series-7"),
  rsi: token("series-1"),
  macd: token("series-4"),
  signal: token("series-2"),
  atr: token("series-3"),
};

/** Compare overlay colours, in the order symbols were added. */
const COMPARE_COLORS = ["series-4", "series-5", "series-7", "series-3", "series-2"] as const;
/** Fewer common bars than this is no comparison worth drawing. */
const MIN_COMMON = 2;

const escapeHtml = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** Start of the window the compare overlays are rebased at: the custom FROM, the range, or the
 * bars shown initially (the same window applyInitialRange opens). */
function windowStart(data: readonly Bar[], st: GpState): number {
  const n = data.length;
  if (!n) return 0;
  if (st.from) return dateSec(st.from);
  if (st.range) return rangeStart(st.range, data[n - 1]!.t) ?? 0;
  const visible = DEFAULT_VISIBLE[st.tf];
  return visible && n > visible ? data[n - visible]!.t : data[0]!.t;
}

const drawStyle = (symbol: string): DrawStyle => ({
  line: token("link"),
  dim: token("dim"),
  text: token("amber"),
  font: "11px JetBrains Mono, monospace",
  price: (p) => fmtPrice(p, symbol),
});

/** Study names and what they draw, for the indicator menu (`I`). */
export const STUDY_LABEL: Record<Indicator, string> = {
  SMA: "SMA 20 / 50 / 200",
  EMA: "EMA 9 / 21",
  BB: "Bollinger 20, 2σ",
  VWAP: "VWAP (intraday, per session)",
  RSI: "RSI 14 (pane)",
  MACD: "MACD 12 / 26 / 9 (pane)",
  ATR: "ATR 14 (pane)",
};

type MainSeries =
  ISeriesApi<"Candlestick"> | ISeriesApi<"Bar"> | ISeriesApi<"Line"> | ISeriesApi<"Area">;

function addMain(chart: IChartApi, type: ChartType): MainSeries {
  // The last price is in the header; an axis label here covered the nearest tick label.
  const common = { lastValueVisible: false, priceLineColor: C.amber };
  switch (type) {
    case "OHLC":
      return chart.addSeries(BarSeries, { ...common, upColor: C.up, downColor: C.down });
    case "LINE":
      return chart.addSeries(LineSeries, { ...common, color: C.amber, lineWidth: 2 });
    case "AREA":
      return chart.addSeries(AreaSeries, {
        ...common,
        lineColor: C.amber,
        lineWidth: 2,
        topColor: withAlpha("amber", 0.3),
        bottomColor: withAlpha("amber", 0.02),
      });
    default:
      return chart.addSeries(CandlestickSeries, {
        ...common,
        upColor: C.up,
        downColor: C.down,
        borderVisible: false,
        wickUpColor: C.up,
        wickDownColor: C.down,
      });
  }
}

/** A bar in the main series' shape: OHLC for candles/bars, the close for line/area. */
function mainPoint(type: ChartType, b: Bar, time: UTCTimestamp) {
  return type === "LINE" || type === "AREA"
    ? { time, value: b.c }
    : { time, open: b.o, high: b.h, low: b.l, close: b.c };
}

/** Bars shown initially per timeframe (≈ one session intraday, ≈ one year daily); F fits all. */
const DEFAULT_VISIBLE: Partial<Record<GpState["tf"], number>> = {
  "1m": 390,
  "5m": 312,
  "15m": 260,
  "30m": 260,
  "1h": 300,
  "4h": 300,
  "1d": 260,
};

const isCryptoSymbol = (s: string) => priceClassOf(s).cls === "crypto";

function lastOf<V>(m: Map<number, V>): V | undefined {
  let last: V | undefined;
  for (const v of m.values()) last = v;
  return last;
}

function toLine(bars: Bar[], values: Series, toChart: (t: number) => number) {
  const out: { time: UTCTimestamp; value: number }[] = [];
  values.forEach((v, i) => {
    if (v != null && Number.isFinite(v)) {
      out.push({ time: toChart(bars[i]!.t) as UTCTimestamp, value: v });
    }
  });
  return out;
}

/** GIP: the same chart, opened on the last session in 5-minute bars (SPEC §7). */
export function GIP(props: PanelProps) {
  const { panel } = props;
  return <GP {...props} panel={panel.args.length ? panel : { ...panel, args: ["1D"] }} />;
}

export function GP({ id, panel, update, active }: PanelProps) {
  const symbol = panel.ticker ?? "";
  // The chart is created once; the crosshair legend reads the current symbol through a ref.
  const symbolRef = useRef(symbol);
  symbolRef.current = symbol;
  // A GP opened without arguments takes the saved template (`S`) once, when it opens: a
  // template saved later does not move windows already open.
  const tpl = useGpTemplate();
  useEffect(() => void loadGpTemplate(), []);
  const tplDecided = useRef(false);
  useEffect(() => {
    if (tplDecided.current || tpl.state !== "ready") return;
    tplDecided.current = true;
    if (!panel.args.length && tpl.args.length) update({ ...panel, args: tpl.args });
  }, [tpl, panel, update]);
  const st = useMemo(() => parseGpArgs(panel.args), [panel.args]);
  const tf = timeframe(st.tf);
  const intraday = isIntraday(st.tf);
  const crypto = isCryptoSymbol(symbol);

  // A window that has not been in focus yet leaves tight-budget sources (Massive: 4 calls/min)
  // to the focused one: stored or cheap bars only, the rest when it is first focused.
  const [woken, setWoken] = useState(active);
  useEffect(() => {
    if (active) setWoken(true);
  }, [active]);
  // A custom window asks for enough history to cover its start (whole days: a stable key).
  const lookback = st.from ? lookbackFor(st.from, Date.now()) : undefined;
  const bars = useApi<BarsResponse>(
    symbol ? `/bars/${encodeURIComponent(symbol)}` : null,
    { interval: st.tf, defer: woken ? undefined : true, lookback },
    { refetchMs: intraday ? 60_000 : 300_000, staleMs: 20_000 },
  );
  const liveQuote = useLiveQuote(symbol || null, active ? "focus" : "other");
  // Event markers (E/D/S): slow-changing reference data, asked again at most hourly.
  const events = useApi<EventsResponse>(
    symbol && st.ev.length ? `/events/${encodeURIComponent(symbol)}` : null,
    { defer: woken ? undefined : true },
    { staleMs: 3_600_000 },
  );
  // Compare overlays: the same bar size, window and budget rules as the main series.
  const cmpBars = useApiMany<BarsResponse>(
    st.cmp.map((sym) => `/bars/${encodeURIComponent(sym)}`),
    { interval: st.tf, defer: woken ? undefined : true, lookback },
    { enabled: !!symbol, refetchMs: intraday ? 60_000 : 300_000, staleMs: 20_000 },
  );

  const boxRef = useRef<HTMLDivElement>(null);
  const legendRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const mainRef = useRef<MainSeries | null>(null);
  const mainTypeRef = useRef<ChartType | null>(null);
  // Chart time -> bar, for the legend whatever the series type.
  const byTimeRef = useRef(new Map<number, Bar>());
  const volRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const indRef = useRef<ISeriesApi<"Line" | "Histogram">[]>([]);
  const linesRef = useRef<IPriceLine[]>([]);
  const lastBarRef = useRef<Bar | null>(null);
  // Bar time -> chart time (display-zone wall clock, see chartTimeFormat); set with the data.
  const toChartRef = useRef<(t: number) => number>((t) => t);
  const crossPriceRef = useRef<number | null>(null);
  const cmpSeriesRef = useRef<ISeriesApi<"Line">[]>([]);
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  // Chart time -> events on that bar, for the legend.
  const eventsByTimeRef = useRef(new Map<number, ChartEvent[]>());
  // Drawings (`D`): one primitive on the main series; the tool and first point live in refs
  // too, since the chart's click and crosshair handlers are bound once.
  const drawRef = useRef<DrawingsPrimitive | null>(null);
  const shadeRef = useRef<SessionShade | null>(null);
  const timesRef = useRef<number[]>([]);
  const crossAnchorRef = useRef<Anchor | null>(null);
  const [tool, setToolState] = useState<DrawKind | null>(null);
  const [pending, setPendingState] = useState<Anchor | null>(null);
  const [textAt, setTextAt] = useState<Anchor | null>(null);
  const toolRef = useRef<DrawKind | null>(null);
  const pendingRef = useRef<Anchor | null>(null);
  const setTool = (t: DrawKind | null) => {
    toolRef.current = t;
    setToolState(t);
    pendingRef.current = null;
    setPendingState(null);
    drawRef.current?.set({ preview: null });
  };
  const placeRef = useRef<(a: Anchor) => void>(() => undefined);
  // Per overlay, chart time -> % since the base bar, for the legend.
  const cmpLegendRef = useRef<{ sym: string; color: string; byT: Map<number, ComparePoint> }[]>([]);
  const stateRef = useRef(st);
  stateRef.current = st;

  const setState = useCallback(
    (patch: Partial<GpState>) => {
      const next = { ...stateRef.current, ...patch };
      update({ ...panel, args: formatGpArgs(next) });
    },
    [panel, update],
  );

  // ---- chart lifecycle ----
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const chart = createChart(el, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: token("bg-panel") },
        textColor: C.text,
        fontFamily: "JetBrains Mono, monospace",
        fontSize: 11,
        panes: {
          separatorColor: token("grid-line"),
          separatorHoverColor: token("grid-line-strong"),
        },
        // lightweight-charts attribution (Apache-2.0 NOTICE requirement, B9).
        attributionLogo: true,
      },
      grid: { vertLines: { color: C.grid }, horzLines: { color: C.grid } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: token("grid-line") },
      timeScale: { borderColor: token("grid-line"), rightOffset: 4 },
    });
    const vol = chart.addSeries(HistogramSeries, {
      priceFormat: { type: "volume" },
      priceScaleId: "vol",
      lastValueVisible: false,
      priceLineVisible: false,
    });
    chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    chartRef.current = chart;
    volRef.current = vol;
    drawRef.current = new DrawingsPrimitive(drawStyle(symbolRef.current));
    shadeRef.current = new SessionShade(withAlpha("link", 0.07));

    // Bar (snapped) and price at a point of the price pane; null elsewhere.
    const anchorXY = (x: number, y: number): Anchor | null => {
      const main = mainRef.current;
      if (!main || x < 0 || y < 0) return null;
      if (x > chart.timeScale().width() || y > (chart.panes()[0]?.getHeight() ?? 0)) return null;
      const l = chart.timeScale().coordinateToLogical(x);
      const price = main.coordinateToPrice(y);
      const t = l === null ? null : timeAtLogical(timesRef.current, Math.round(l));
      return t === null || price === null ? null : { t, p: price };
    };
    const anchorAt = (p: MouseEventParams) => (p.point ? anchorXY(p.point.x, p.point.y) : null);
    // Points are placed on our own pointer events: the chart's click event drops a second click
    // within 500 ms (its double-click window), which two quick points of a line are.
    let down: { x: number; y: number } | null = null;
    const onDown = (e: PointerEvent) => {
      down = e.button === 0 ? { x: e.clientX, y: e.clientY } : null;
    };
    const onUp = (e: PointerEvent) => {
      const d = down;
      down = null;
      if (!d || !toolRef.current) return;
      if (Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) > 4) return; // a pan, not a point
      const r = el.getBoundingClientRect();
      const a = anchorXY(e.clientX - r.left, e.clientY - r.top);
      if (a) placeRef.current(a);
    };
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointerup", onUp);

    const onMove = (p: MouseEventParams) => {
      const at = anchorAt(p);
      crossAnchorRef.current = at;
      const first = pendingRef.current;
      if (first && toolRef.current && at) {
        drawRef.current?.set({ preview: { kind: toolRef.current, a: first, b: at } });
      }
      const legend = legendRef.current;
      if (p.point && mainRef.current) {
        crossPriceRef.current = mainRef.current.coordinateToPrice(p.point.y);
      } else {
        crossPriceRef.current = null;
      }
      if (!legend) return;
      // OHLCV at the cursor (else the last bar), whatever the series type draws.
      const ctime = p.time != null ? (p.time as number) : null;
      const bar = (ctime != null ? byTimeRef.current.get(ctime) : undefined) ?? lastBarRef.current;
      if (!bar) {
        legend.textContent = "";
        return;
      }
      const chg = ((bar.c - bar.o) / bar.o) * 100;
      // A flat bar is neither green nor red (§4.2: colour follows the sign shown).
      const dir = signClass(chg, fmtPct(chg));
      const sym = symbolRef.current;
      legend.innerHTML =
        `O <b>${fmtPrice(bar.o, sym)}</b> H <b>${fmtPrice(bar.h, sym)}</b> L <b>${fmtPrice(bar.l, sym)}</b> ` +
        `C <b class="${dir}">${fmtPrice(bar.c, sym)}</b> ` +
        `<span class="${dir}">${fmtPct(chg)}</span>` +
        (bar.v != null ? ` V <b>${fmtBig(bar.v)}</b>` : "") +
        cmpLegendRef.current
          .map((c) => {
            // At the cursor: that bar's value, never another bar's (no bar there is N.A.).
            const onBar = ctime != null && byTimeRef.current.has(ctime);
            const pt = onBar ? c.byT.get(ctime) : lastOf(c.byT);
            const head = ` <span style="color:${c.color}">■</span> ${escapeHtml(c.sym)} `;
            if (!pt) return head + `<span class="na">N.A.</span>`;
            const d = signClass(pt.pct, fmtPct(pt.pct));
            return head + `<span class="${d}">${fmtPct(pt.pct)}</span>`;
          })
          .join("") +
        (ctime != null && byTimeRef.current.has(ctime)
          ? (eventsByTimeRef.current.get(ctime) ?? [])
              .map(
                (e) =>
                  ` <span style="color:${EVENT_STYLE[e.kind].color()}">${e.kind}</span> ` +
                  escapeHtml(eventText(e)),
              )
              .join("")
          : "");
    };
    chart.subscribeCrosshairMove(onMove);
    return () => {
      chart.unsubscribeCrosshairMove(onMove);
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointerup", onUp);
      chart.remove();
      drawRef.current = null;
      shadeRef.current = null;
      markersRef.current = null;
      chartRef.current = null;
      mainRef.current = null;
      mainTypeRef.current = null;
      volRef.current = null;
      indRef.current = [];
      linesRef.current = [];
      cmpSeriesRef.current = [];
    };
  }, []);

  // ---- data + indicators ----
  const data = bars.data?.data;
  const seriesTz = bars.data?.tz;
  useEffect(() => {
    const chart = chartRef.current;
    const vol = volRef.current;
    if (!chart || !vol || !data) return;
    if (mainTypeRef.current !== st.type || !mainRef.current) {
      if (mainRef.current) {
        if (drawRef.current) mainRef.current.detachPrimitive(drawRef.current);
        if (shadeRef.current) mainRef.current.detachPrimitive(shadeRef.current);
        chart.removeSeries(mainRef.current);
      }
      mainRef.current = addMain(chart, st.type);
      if (drawRef.current) mainRef.current.attachPrimitive(drawRef.current);
      if (shadeRef.current) mainRef.current.attachPrimitive(shadeRef.current);
      markersRef.current?.detach();
      markersRef.current = createSeriesMarkers(mainRef.current as ISeriesApi<"Line">, []);
      mainTypeRef.current = st.type;
      linesRef.current = []; // price lines belonged to the old series
    }
    const main = mainRef.current;

    // Time axis and crosshair through the shared formatters, exchange-local (review 1a #10).
    const time = chartTimeFormat(symbolRef.current, intraday, seriesTz);
    const ct = time.toChart;
    toChartRef.current = ct;
    chart.applyOptions({
      localization: { timeFormatter: time.timeFormatter },
      timeScale: {
        timeVisible: intraday,
        secondsVisible: false,
        tickMarkFormatter: time.tickMarkFormatter,
      },
    });
    // Axis, last-value and crosshair labels through the shared formatter (§4.2, review 1a #10).
    main.applyOptions({
      priceFormat: chartPriceFormat(symbolRef.current, data[data.length - 1]?.c),
    });
    const type = st.type;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- one shape per series type
    (main as ISeriesApi<any>).setData(data.map((b) => mainPoint(type, b, ct(b.t) as UTCTimestamp)));
    byTimeRef.current = new Map(data.map((b) => [ct(b.t), b]));
    timesRef.current = data.map((b) => b.t);
    drawRef.current?.set({ times: timesRef.current, style: drawStyle(symbolRef.current) });
    // US extended hours shaded: New York intraday bars (1m-1h) of a US stock or ETF.
    const cls = priceClassOf(symbolRef.current).cls;
    const usIntraday =
      seriesTz === "America/New_York" &&
      (cls === "equity" || cls === "etf") &&
      ["1m", "5m", "15m", "30m", "1h"].includes(st.tf);
    shadeRef.current?.set(usIntraday ? timesRef.current : [], withAlpha("link", 0.07));
    vol.setData(
      st.vol
        ? data.map((b) =>
            // Missing volume is a gap (whitespace point), never a zero bar.
            b.v == null
              ? { time: ct(b.t) as UTCTimestamp }
              : {
                  time: ct(b.t) as UTCTimestamp,
                  value: b.v,
                  color: b.c >= b.o ? C.upVol : C.downVol,
                },
          )
        : [],
    );
    lastBarRef.current = data[data.length - 1] ?? null;

    for (const s of indRef.current) chart.removeSeries(s);
    indRef.current = [];
    const closes = data.map((b) => b.c);
    const add = (values: Series, color: string, pane = 0, width: 1 | 2 = 1) => {
      const s = chart.addSeries(
        LineSeries,
        {
          color,
          lineWidth: width,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false,
        },
        pane,
      );
      s.setData(toLine(data, values, ct));
      indRef.current.push(s);
      return s;
    };
    const has = (i: Indicator) => st.ind.includes(i);
    if (has("SMA")) {
      add(sma(closes, 20), OVERLAY_COLORS.sma20);
      add(sma(closes, 50), OVERLAY_COLORS.sma50);
      add(sma(closes, 200), OVERLAY_COLORS.sma200);
    }
    if (has("EMA")) {
      add(ema(closes, 9), OVERLAY_COLORS.ema9);
      add(ema(closes, 21), OVERLAY_COLORS.ema21);
    }
    if (has("BB")) {
      const bb = bollinger(closes, 20, 2);
      add(bb.upper, OVERLAY_COLORS.bb);
      add(bb.mid, OVERLAY_COLORS.bb);
      add(bb.lower, OVERLAY_COLORS.bb);
    }
    if (has("VWAP") && intraday) add(vwap(data), OVERLAY_COLORS.vwap, 0, 2);
    let pane = 1;
    if (has("RSI")) {
      const s = add(rsi(closes, 14), OVERLAY_COLORS.rsi, pane);
      s.applyOptions({ lastValueVisible: true, priceFormat: chartNumberFormat(2) });
      s.createPriceLine({
        price: 70,
        color: token("dim"),
        lineStyle: LineStyle.Dashed,
        lineWidth: 1,
        axisLabelVisible: false,
        title: "",
      });
      s.createPriceLine({
        price: 30,
        color: token("dim"),
        lineStyle: LineStyle.Dashed,
        lineWidth: 1,
        axisLabelVisible: false,
        title: "",
      });
      pane++;
    }
    if (has("MACD")) {
      const m = macd(closes);
      // MACD is in price units: the price class precision (FX 4 dp, never 0.00), §4.2.
      const macdFormat = chartSpreadFormat(symbolRef.current, data[data.length - 1]?.c);
      const hist = chart.addSeries(
        HistogramSeries,
        { priceLineVisible: false, lastValueVisible: false, priceFormat: macdFormat },
        pane,
      );
      hist.setData(
        m.hist.flatMap((v, i) =>
          v == null
            ? []
            : [
                {
                  time: ct(data[i]!.t) as UTCTimestamp,
                  value: v,
                  color: v >= 0 ? C.upVol : C.downVol,
                },
              ],
        ),
      );
      indRef.current.push(hist);
      add(m.macd, OVERLAY_COLORS.macd, pane).applyOptions({ priceFormat: macdFormat });
      add(m.signal, OVERLAY_COLORS.signal, pane).applyOptions({ priceFormat: macdFormat });
      pane++;
    }
    if (has("ATR")) {
      // ATR is in price units too.
      const fmt = chartSpreadFormat(symbolRef.current, data[data.length - 1]?.c);
      add(atr(data, 14), OVERLAY_COLORS.atr, pane).applyOptions({
        priceFormat: fmt,
        lastValueVisible: true,
      });
      pane++;
    }
    const panes = chart.panes();
    for (let i = panes.length - 1; i >= pane; i--) chart.removePane(i);
    chart.panes().forEach((p, i) => p.setStretchFactor(i === 0 ? 3 : 1));
  }, [data, seriesTz, st.ind, st.vol, st.type, st.tf, intraday]);

  // ---- compare overlays (SPEC §8: up to 5, normalized) ----
  const cmpData = cmpBars.map((q) => q.data);
  const cmpKey = cmpData.map((d) => d?.meta.fetched_at ?? "").join("|");
  const startT = data ? windowStart(data, st) : 0;
  const overlays = useMemo(
    () =>
      st.cmp.map((sym, i) => {
        const r = cmpData[i];
        if (!data || !r) return { sym, points: null as ComparePoint[] | null };
        const pts = rebase(
          data,
          bars.data?.utc_offset_s ?? 0,
          r.data,
          r.utc_offset_s ?? 0,
          startT,
          intraday,
        );
        return { sym, points: pts.length >= MIN_COMMON ? pts : [] };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- cmpKey stands for cmpData
    [st.cmp.join(","), cmpKey, data, startT, intraday],
  );
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    for (const s of cmpSeriesRef.current) chart.removeSeries(s);
    cmpSeriesRef.current = [];
    cmpLegendRef.current = [];
    if (!data) return;
    const ct = toChartRef.current;
    const fmt = chartPriceFormat(symbolRef.current, data[data.length - 1]?.c);
    overlays.forEach(({ sym, points }, i) => {
      if (!points?.length) return;
      const color = token(COMPARE_COLORS[i % COMPARE_COLORS.length]!);
      const s = chart.addSeries(LineSeries, {
        color,
        lineWidth: 2,
        priceLineVisible: false,
        lastValueVisible: false,
        priceFormat: fmt,
        title: "",
      });
      s.setData(points.map((p) => ({ time: ct(p.t) as UTCTimestamp, value: p.value })));
      cmpSeriesRef.current.push(s);
      cmpLegendRef.current.push({ sym, color, byT: new Map(points.map((p) => [ct(p.t), p])) });
    });
  }, [overlays, data, seriesTz, st.type]);

  // ---- event markers (SPEC §8 E/D/S) ----
  const eventList = events.data?.data;
  const placed = useMemo(
    () =>
      data && eventList
        ? placeEvents(
            data.map((b) => b.t),
            eventList,
            st.ev,
          )
        : null,
    [data, eventList, st.ev],
  );
  useEffect(() => {
    const ct = toChartRef.current;
    const markers: SeriesMarker<Time>[] = [];
    const byTime = new Map<number, ChartEvent[]>();
    for (const [t, list] of placed?.byBar ?? []) {
      byTime.set(ct(t), list);
      for (const k of EVENT_KINDS) {
        if (!list.some((e) => e.kind === k)) continue;
        markers.push({
          time: ct(t) as UTCTimestamp,
          position: EVENT_STYLE[k].position,
          shape: "circle",
          color: EVENT_STYLE[k].color(),
          text: k,
          size: 0.6,
        });
      }
    }
    markers.sort((a, b) => (a.time as number) - (b.time as number));
    eventsByTimeRef.current = byTime;
    markersRef.current?.setMarkers(markers);
  }, [placed, seriesTz, st.type]);

  // ---- drawings (SPEC §8: persisted per security) ----
  const drawings = useDrawings(symbol);
  useEffect(() => {
    if (symbol) void loadDrawings(symbol);
  }, [symbol]);
  useEffect(() => {
    drawRef.current?.set({ items: drawings.items });
  }, [drawings.items]);
  const commitDrawing = (d: Drawing) => {
    void saveDrawings(symbol, [...drawings.items, d]);
    setTool(null);
    setTextAt(null);
  };
  placeRef.current = (a: Anchor) => {
    const t = toolRef.current;
    if (!t) return;
    if (t === "TEXT") {
      setTextAt(a);
      return;
    }
    if (DRAW_POINTS[t] === 1) return commitDrawing({ kind: t, a });
    const first = pendingRef.current;
    if (!first) {
      pendingRef.current = a;
      setPendingState(a);
      return;
    }
    commitDrawing({ kind: t, a: first, b: a });
  };

  // Initial visible range when the dataset changes identity (symbol/timeframe), not on every
  // refetch. Applied once the container has a real size (it can be 0 wide on first render).
  const fitKey = `${symbol}|${st.tf}|${st.range ?? ""}|${st.from ?? ""}|${st.to ?? ""}|${data ? "y" : "n"}`;
  const pendingRangeRef = useRef(false);
  const applyInitialRange = useCallback(() => {
    const chart = chartRef.current;
    const el = boxRef.current;
    const n = data?.length ?? 0;
    if (!chart || !el || !data || !n || el.clientWidth === 0) return false;
    const { range, tf, from, to } = stateRef.current;
    if (from) {
      const a = data.findIndex((b) => b.t >= dateSec(from));
      const end = to ? dateSec(to) + 86400 : Infinity;
      let z = n - 1;
      while (z > 0 && data[z]!.t >= end) z--;
      if (a < 0) chart.timeScale().fitContent();
      else chart.timeScale().setVisibleLogicalRange({ from: a, to: Math.max(a, z) + 1 });
      return true;
    }
    if (range) {
      const start = rangeStart(range, data[n - 1]!.t);
      const from = start === null ? 0 : data.findIndex((b) => b.t >= start);
      if (from <= 0) chart.timeScale().fitContent();
      else chart.timeScale().setVisibleLogicalRange({ from, to: n + 3 });
      return true;
    }
    const visible = DEFAULT_VISIBLE[tf];
    if (!visible || n <= visible) chart.timeScale().fitContent();
    else chart.timeScale().setVisibleLogicalRange({ from: n - visible, to: n + 3 });
    return true;
  }, [data]);
  useEffect(() => {
    if (!data) return;
    pendingRangeRef.current = !applyInitialRange();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitKey]);
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      if (pendingRangeRef.current && applyInitialRange()) pendingRangeRef.current = false;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [applyInitialRange]);

  // ---- log scale ----
  useEffect(() => {
    chartRef.current
      ?.priceScale("right")
      .applyOptions({ mode: st.log ? PriceScaleMode.Logarithmic : PriceScaleMode.Normal });
  }, [st.log]);

  // ---- horizontal lines ----
  const linesKey = st.lines.join(",");
  useEffect(() => {
    const main = mainRef.current;
    if (!main) return;
    for (const l of linesRef.current) main.removePriceLine(l);
    linesRef.current = st.lines.map((price) =>
      main.createPriceLine({
        price,
        color: C.cyan,
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: "",
      }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linesKey, data, st.type]);

  // ---- live updates ----
  const applyLive = useCallback((bar: Bar) => {
    const main = mainRef.current;
    const type = mainTypeRef.current;
    if (!main || !type) return;
    const last = lastBarRef.current;
    if (last && bar.t < last.t) return;
    const ct = toChartRef.current;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- one shape per series type
    (main as ISeriesApi<any>).update(mainPoint(type, bar, ct(bar.t) as UTCTimestamp));
    byTimeRef.current.set(ct(bar.t), bar);
    if (stateRef.current.vol) {
      volRef.current?.update(
        bar.v == null
          ? { time: ct(bar.t) as UTCTimestamp }
          : {
              time: ct(bar.t) as UTCTimestamp,
              value: bar.v,
              color: bar.c >= bar.o ? C.upVol : C.downVol,
            },
      );
    }
    lastBarRef.current = bar;
  }, []);

  useLiveBars(crypto && data ? symbol : null, crypto ? st.tf : null, (bar) => applyLive(bar));

  // No bars are ever built from polled quotes (SPEC §1.2, B1): a quote snapshot is not a trade
  // print, and a new bucket from it would show a fake o=h=l=c bar with zero volume. Non-crypto
  // charts update only when new bars arrive from the bars endpoint.

  // ---- keyboard (SPEC §8 GP hotkeys, content focused) ----
  // The indicator menu (`I`): null = closed, else the highlighted study.
  const [menu, setMenu] = useState<number | null>(null);
  // The draw menu (`D`): null = closed, else the highlighted tool.
  const [drawMenu, setDrawMenu] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 5000);
    return () => clearTimeout(t);
  }, [notice]);
  // The compare field (`C`) is shown while open or while there are overlays.
  const [cmpOpen, setCmpOpen] = useState(false);
  const cmpFieldRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (cmpOpen) cmpFieldRef.current?.focus();
  }, [cmpOpen]);
  const addCompare = (raw: string) => {
    const sym = raw.trim().toUpperCase();
    const cur = stateRef.current.cmp;
    if (!sym || sym === symbol.toUpperCase() || cur.includes(sym) || cur.length >= MAX_COMPARE)
      return;
    setState({ cmp: [...cur, sym] });
  };
  const resetView = () => {
    chartRef.current?.priceScale("right").applyOptions({ autoScale: true });
    if (!applyInitialRange()) chartRef.current?.timeScale().fitContent();
  };
  const pan = (dir: -1 | 1) => {
    const ts = chartRef.current?.timeScale();
    const r = ts?.getVisibleLogicalRange();
    if (!ts || !r) return;
    const step = Math.max(1, Math.round((r.to - r.from) * 0.2)) * dir;
    ts.setVisibleLogicalRange({ from: r.from + step, to: r.to + step });
  };
  usePanelKeys(id, "GP", (a) => {
    if (a.startsWith("range-")) {
      const r = NUMBERED_RANGES[Number(a.slice(6)) - 1]!;
      setState({ range: r.token, tf: r.tf, from: undefined, to: undefined });
      return true;
    }
    if (drawMenu !== null) {
      if (a === "menu-up") setDrawMenu((m) => Math.max(0, (m ?? 0) - 1));
      else if (a === "menu-down") setDrawMenu((m) => Math.min(DRAW_KINDS.length - 1, (m ?? 0) + 1));
      else if (a === "menu-toggle") {
        setTool(DRAW_KINDS[drawMenu]!);
        setDrawMenu(null);
      } else if (a === "draw") setDrawMenu(null);
      else return false;
      return true;
    }
    if (tool && !textAt) {
      // A tool is armed: Enter/Space places a point at the cursor, D cancels.
      if (a === "menu-toggle") {
        if (crossAnchorRef.current) placeRef.current(crossAnchorRef.current);
        return true;
      }
      if (a === "draw") {
        setTool(null);
        return true;
      }
    }
    if (menu !== null) {
      if (a === "menu-up") setMenu((m) => Math.max(0, (m ?? 0) - 1));
      else if (a === "menu-down") setMenu((m) => Math.min(INDICATORS.length - 1, (m ?? 0) + 1));
      else if (a === "menu-toggle")
        setState({ ind: toggle(stateRef.current.ind, INDICATORS[menu]!) });
      else if (a === "indicators") setMenu(null);
      else return false;
      return true;
    }
    switch (a) {
      case "indicators":
        setMenu(0);
        return true;
      case "draw":
        setDrawMenu(0);
        return true;
      case "save-template":
        saveGpTemplate(stateRef.current).then(
          (a) => setNotice(`Template saved: GP ${a.join(" ")} · a GP without arguments opens so`),
          () => setNotice("Template not saved: the settings store did not answer"),
        );
        return true;
      case "undo-draw":
        if (drawings.items.length) void saveDrawings(symbol, drawings.items.slice(0, -1));
        return true;
      case "compare":
        if (cmpOpen) cmpFieldRef.current?.focus();
        else setCmpOpen(true);
        return true;
      case "pan-left":
        pan(-1);
        return true;
      case "pan-right":
        pan(1);
        return true;
      case "reset":
        resetView();
        return true;
      case "log":
        setState({ log: !stateRef.current.log });
        return true;
      case "vol":
        setState({ vol: !stateRef.current.vol });
        return true;
      case "type": {
        const t = CHART_TYPES[(CHART_TYPES.indexOf(stateRef.current.type) + 1) % 4]!;
        setState({ type: t });
        return true;
      }
      case "hline": {
        const p = crossPriceRef.current ?? lastBarRef.current?.c;
        const t = lastBarRef.current?.t;
        if (!p || !Number.isFinite(p)) return true;
        // A drawing of the security; while its drawings cannot be read, a line of this window.
        if (drawings.state === "ready" && t != null)
          commitDrawing({ kind: "HLINE", a: { t, p: +p.toPrecision(6) } });
        else setState({ lines: [...stateRef.current.lines, +p.toPrecision(6)] });
        return true;
      }
      case "clear":
        setState({ lines: [] });
        if (drawings.items.length) void saveDrawings(symbol, []);
        return true;
      case "fit":
        chartRef.current?.timeScale().fitContent();
        return true;
      case "zoom-in":
      case "zoom-out": {
        const ts = chartRef.current?.timeScale();
        if (!ts) return true;
        const spacing = ts.options().barSpacing;
        ts.applyOptions({ barSpacing: Math.max(1, spacing * (a === "zoom-out" ? 0.8 : 1.25)) });
        return true;
      }
    }
    return false;
  });

  const lastQ = liveQuote.quote;
  const liveLabel = crypto ? "Binance stream" : null;

  return (
    <>
      <DataStatus
        meta={bars.data?.meta}
        error={bars.error}
        fetching={bars.isFetching}
        waiting={bars.failureReason}
        updatedAt={bars.dataUpdatedAt}
        extra={
          liveLabel && liveQuote.meta ? (
            <span>
              LIVE <LatencyTag meta={liveQuote.meta} /> {liveLabel}
            </span>
          ) : null
        }
      />
      <div className="toolbar" data-testid="gp-toolbar">
        {NUMBERED_RANGES.map((r, i) => (
          <button
            key={r.token}
            className={!st.from && st.range === r.token ? "on" : ""}
            title={`${i + 1}) range ${r.token} (key ${i + 1})`}
            onClick={() => setState({ range: r.token, tf: r.tf, from: undefined, to: undefined })}
          >
            {r.token}
          </button>
        ))}
        <DateField
          label="FROM"
          value={st.from}
          onCommit={(v) => setState({ from: v, to: v ? st.to : undefined, range: undefined })}
        />
        <DateField
          label="TO"
          value={st.to}
          disabled={!st.from}
          onCommit={(v) => setState({ to: v })}
        />
        <span className="sep" />
        {TIMEFRAMES.map((t) => (
          <button
            key={t.key}
            className={t.key === st.tf ? "on" : ""}
            title={`bar size ${t.label}`}
            onClick={() => setState({ tf: t.key })}
          >
            {t.label}
          </button>
        ))}
        <span className="sep" />
        {CHART_TYPES.map((t) => (
          <button
            key={t}
            className={st.type === t ? "on" : ""}
            title="chart type (T cycles)"
            onClick={() => setState({ type: t })}
          >
            {t}
          </button>
        ))}
        <span className="sep" />
        <button
          className={menu !== null ? "on" : ""}
          title="studies (I)"
          onClick={() => setMenu(menu === null ? 0 : null)}
        >
          STUDIES{st.ind.length ? ` ${st.ind.length}` : ""}
        </button>
        <button
          className={drawMenu !== null || tool ? "on" : ""}
          title="draw (D) · Backspace removes the last · X clears"
          data-testid="gp-draw-btn"
          onClick={() => (tool ? setTool(null) : setDrawMenu(drawMenu === null ? 0 : null))}
        >
          DRAW{drawings.items.length ? ` ${drawings.items.length}` : ""}
        </button>
        <button className={st.log ? "on" : ""} onClick={() => setState({ log: !st.log })}>
          LOG
        </button>
        <button className={st.vol ? "on" : ""} onClick={() => setState({ vol: !st.vol })}>
          VOL
        </button>
        <span className="sep" />
        {EVENT_KINDS.map((k) => {
          const r = events.data;
          const failed = r?.errors.find((x) => x.startsWith(k === "E" ? "E:" : "D/S:"));
          const missing = r?.uncovered.includes(k) || (!r && events.error != null);
          const why = failed ?? (missing ? `no source for ${EVENT_LABEL[k]} here` : null);
          return (
            <button
              key={k}
              className={st.ev.includes(k) ? "on" : ""}
              data-testid={`gp-ev-${k}`}
              title={`${EVENT_LABEL[k]} markers${r ? ` · ${r.meta.source}` : ""}${why ? ` · N.A.: ${why}` : ""}`}
              onClick={() =>
                setState({
                  ev: EVENT_KINDS.filter((x) => (x === k ? !st.ev.includes(k) : st.ev.includes(x))),
                })
              }
            >
              {k}
              {why && st.ev.includes(k) ? <span className="na"> N.A.</span> : null}
            </button>
          );
        })}
        {events.data && st.ev.length ? <LatencyTag meta={events.data.meta} /> : null}
        {lastQ?.price != null ? (
          <span style={{ marginLeft: "auto" }}>
            <span className="amber">{fmtPrice(lastQ.price, symbol)}</span>{" "}
            <Sgn as="span" v={lastQ.change_pct}>
              {fmtPct(lastQ.change_pct)}
            </Sgn>{" "}
            <span className="dim">{lastQ.market_state ?? ""}</span>
          </span>
        ) : null}
      </div>
      {cmpOpen || st.cmp.length ? (
        <div className="toolbar" data-testid="gp-compare">
          <span className="dim">COMPARE</span>
          {st.cmp.map((sym, i) => {
            const q = cmpBars[i];
            const o = overlays[i];
            const color = token(COMPARE_COLORS[i % COMPARE_COLORS.length]!);
            const last = o?.points?.length ? o.points[o.points.length - 1]! : null;
            return (
              <span key={sym} className="gp-chip" data-testid="gp-cmp-chip" data-symbol={sym}>
                <span style={{ color }}>■</span> {sym}{" "}
                {q?.isLoading ? (
                  <span className="dim">LOADING</span>
                ) : q?.error ? (
                  <span className="na" title={String((q.error as Error).message ?? q.error)}>
                    N.A.
                  </span>
                ) : last ? (
                  <Sgn as="span" v={last.pct}>
                    {fmtPct(last.pct)}
                  </Sgn>
                ) : (
                  <span className="na" title="no bars in common with the main series">
                    N.A.
                  </span>
                )}{" "}
                {q?.data ? <LatencyTag meta={q.data.meta} /> : null}
                <button
                  title={`remove ${sym}`}
                  onClick={() => setState({ cmp: st.cmp.filter((c) => c !== sym) })}
                >
                  ✕
                </button>
              </span>
            );
          })}
          {st.cmp.length < MAX_COMPARE ? (
            <input
              ref={cmpFieldRef}
              data-testid="gp-cmp-field"
              placeholder="+ security, Enter"
              style={{ width: 130 }}
              onKeyDown={(e) => {
                const el = e.currentTarget;
                if (e.key === "Enter") {
                  e.preventDefault();
                  addCompare(el.value);
                  el.value = "";
                } else if (e.key === "Escape") {
                  el.value = "";
                  setCmpOpen(false);
                  el.closest<HTMLElement>("[data-panel-id]")?.focus({ preventScroll: true });
                }
              }}
            />
          ) : (
            <span className="dim">max {MAX_COMPARE}</span>
          )}
          {st.cmp.length ? (
            <span className="dim" style={{ marginLeft: "auto" }}>
              % since {startT ? fmtDate(startT * 1000, "UTC") : "first bar"}
            </span>
          ) : null}
        </div>
      ) : null}
      <div style={{ position: "relative", flex: 1, minHeight: 0 }}>
        <div ref={boxRef} data-testid="gp-chart" style={{ position: "absolute", inset: 0 }} />
        <div
          ref={legendRef}
          className="dim"
          data-testid="gp-legend"
          style={{
            position: "absolute",
            left: 6,
            right: 70, // wraps before the price axis
            top: 4,
            zIndex: 3,
            pointerEvents: "none",
            fontSize: 11,
          }}
        />
        {menu !== null ? (
          <div className="gp-menu" data-testid="gp-studies">
            <div className="dim">STUDIES · ↑↓ select · Enter toggle · I close</div>
            {INDICATORS.map((ind, i) => (
              <div
                key={ind}
                className={i === menu ? "sel" : ""}
                onMouseDown={() => setState({ ind: toggle(st.ind, ind) })}
              >
                <span className={st.ind.includes(ind) ? "up" : "dim"}>
                  {st.ind.includes(ind) ? "■" : "□"}
                </span>{" "}
                {ind} <span className="dim">{STUDY_LABEL[ind]}</span>
              </div>
            ))}
          </div>
        ) : null}
        {drawMenu !== null ? (
          <div className="gp-menu" data-testid="gp-draw-menu">
            <div className="dim">DRAW · ↑↓ select · Enter pick · D close</div>
            {DRAW_KINDS.map((k, i) => (
              <div
                key={k}
                className={i === drawMenu ? "sel" : ""}
                onMouseDown={() => {
                  setTool(k);
                  setDrawMenu(null);
                }}
              >
                {DRAW_LABEL[k]}{" "}
                <span className="dim">{DRAW_POINTS[k] === 2 ? "2 points" : "1 point"}</span>
              </div>
            ))}
          </div>
        ) : null}
        {textAt ? (
          <div className="gp-menu" data-testid="gp-draw-text">
            <span className="dim">TEXT </span>
            <input
              autoFocus
              maxLength={MAX_TEXT}
              placeholder="label, Enter"
              style={{ width: 180 }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  const text = e.currentTarget.value.trim();
                  if (text) commitDrawing({ kind: "TEXT", a: textAt, text });
                  else setTextAt(null);
                  e.currentTarget
                    .closest<HTMLElement>("[data-panel-id]")
                    ?.focus({ preventScroll: true });
                } else if (e.key === "Escape") {
                  setTextAt(null);
                  setTool(null);
                }
              }}
            />
          </div>
        ) : null}
        {bars.isLoading ? (
          <div style={{ position: "absolute", left: 6, top: 22, zIndex: 3 }}>
            <Loading what={`${symbol} ${tf.label}`} />
          </div>
        ) : null}
      </div>
      {st.from && data?.length && data[0]!.t > dateSec(st.from) ? (
        <div className="ds hint" data-testid="gp-from-hint">
          FROM {st.from} is before the first {tf.label} bar the source has (
          {fmtDate(data[0]!.t * 1000, "UTC")}): the chart starts there
        </div>
      ) : null}
      {notice ? (
        <div className="ds hint" data-testid="gp-notice">
          {notice}
        </div>
      ) : null}
      {tool ? (
        <div className="ds hint" data-testid="gp-draw-hint">
          DRAW {DRAW_LABEL[tool]}: click {pending ? "the second" : "the first"} point (Enter at the
          cursor) · D cancels
        </div>
      ) : null}
      {drawings.state === "error" ? (
        <div className="ds hint">
          drawings of {symbol} could not be read: new ones are not saved
        </div>
      ) : drawings.unsaved ? (
        <div className="ds hint">the last drawing change was not saved</div>
      ) : null}
      {st.ind.includes("VWAP") && !intraday ? (
        <div className="ds hint">VWAP needs an intraday timeframe</div>
      ) : null}
    </>
  );
}

/** Amber date field (SPEC §4.8): Enter applies, Esc reverts; empty clears. */
export function DateField({
  label,
  value,
  disabled,
  onCommit,
}: {
  label: string;
  value: string | undefined;
  disabled?: boolean;
  onCommit: (v: string | undefined) => void;
}) {
  const [text, setText] = useState(value ?? "");
  useEffect(() => setText(value ?? ""), [value]);
  const bad = text !== "" && !isDate(text);
  return (
    <label className="dim" style={{ marginLeft: 6 }}>
      {label}{" "}
      <input
        value={text}
        placeholder="YYYY-MM-DD"
        disabled={disabled}
        data-testid={`gp-${label.toLowerCase()}`}
        title={bad ? "a date as YYYY-MM-DD" : undefined}
        style={{ width: 92 }}
        className={bad ? "bad" : undefined}
        onChange={(e) => setText(e.target.value.trim())}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            if (text === "") onCommit(undefined);
            else if (isDate(text)) onCommit(text);
          } else if (e.key === "Escape") {
            setText(value ?? "");
          }
        }}
      />
    </label>
  );
}
