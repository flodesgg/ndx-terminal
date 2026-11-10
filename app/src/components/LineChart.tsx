import { useEffect, useRef } from "react";
import uPlot from "uplot";
import { NA } from "@/lib/format";
import "uplot/dist/uPlot.min.css";
import { token } from "@/theme/tokens";

export interface LineSeriesDef {
  label: string;
  values: (number | null)[];
  color: string;
  width?: number;
  dash?: number[];
}

/**
 * Small uPlot wrapper for simple line charts (yield curves, macro series).
 * `x` is either unix seconds (time axis) or category indices with `categories` labels.
 */
export function LineChart({
  x,
  series,
  categories,
  time = false,
  yFormat,
}: {
  x: number[];
  series: LineSeriesDef[];
  categories?: string[];
  time?: boolean;
  yFormat?: (v: number) => string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const plot = useRef<uPlot | null>(null);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const axisStroke = token("amber-dim");
    const grid = { stroke: token("chart-grid"), width: 1 };
    const opts: uPlot.Options = {
      width: el.clientWidth || 400,
      height: el.clientHeight || 200,
      legend: { show: true, live: true },
      cursor: { drag: { x: true, y: false } },
      scales: { x: { time } },
      series: [
        {
          label: time ? "date" : "tenor",
          value: categories ? (_u, v) => (v == null ? NA : (categories[v] ?? "")) : undefined,
        },
        ...series.map((s) => ({
          label: s.label,
          stroke: s.color,
          width: s.width ?? 1.5,
          dash: s.dash,
          spanGaps: true,
          points: { show: !!categories, size: 4 },
          value: yFormat
            ? (_u: uPlot, v: number | null) => (v == null ? NA : yFormat(v))
            : undefined,
        })),
      ],
      axes: [
        {
          stroke: axisStroke,
          grid,
          ticks: grid,
          font: "11px JetBrains Mono",
          ...(categories
            ? {
                splits: () => categories.map((_, i) => i),
                // Thin out labels when the chart is narrow so they never overlap.
                values: (u: uPlot, splits: number[]) => {
                  const step = Math.max(
                    1,
                    Math.ceil(
                      (categories.length * 34) / Math.max(1, u.bbox.width / devicePixelRatio),
                    ),
                  );
                  return splits.map((i) => (i % step === 0 ? (categories[i] ?? "") : ""));
                },
              }
            : {}),
        },
        {
          stroke: axisStroke,
          grid,
          ticks: grid,
          font: "11px JetBrains Mono",
          size: 60,
          values: yFormat
            ? (_u: uPlot, splits: number[]) => splits.map((v) => yFormat(v))
            : undefined,
        },
      ],
    };
    const data = [x, ...series.map((s) => s.values)] as uPlot.AlignedData;
    const u = new uPlot(opts, data, el);
    plot.current = u;
    let frame = 0;
    const ro = new ResizeObserver(() => {
      // Resize on the next frame: resizing inside the observer callback triggers the benign
      // "ResizeObserver loop completed with undelivered notifications" warning.
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (el.clientWidth > 0 && el.clientHeight > 0) {
          u.setSize({ width: el.clientWidth, height: el.clientHeight - 24 });
        }
      });
    });
    ro.observe(el);
    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
      u.destroy();
      plot.current = null;
    };
  }, [x, series, categories, time, yFormat]);

  return <div ref={box} className="uplot-box" style={{ width: "100%", height: "100%" }} />;
}
