import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { buildLatencyChartData } from "./latencyChartData";

interface LatencyChartProps {
  /** Array of latency values (ms). Null entries represent timeouts/drops. */
  points: (number | null)[];
  /** Sampling interval (ms). When set, the x axis is labelled in elapsed seconds. */
  intervalMs?: number;
  /** Chart height in pixels. */
  height?: number;
}

const CHART_HEIGHT = 120;
/** Axis tick-label font size (px). */
const AXIS_FONT_PX = 13;

/** Resolve a CSS custom property to a concrete colour (canvas can't read CSS vars). */
function cssVar(styles: CSSStyleDeclaration, name: string, fallback: string): string {
  return styles.getPropertyValue(name).trim() || fallback;
}

/**
 * uPlot plugin that draws a dashed vertical marker at every dropped/timed-out
 * sample so packet loss is visible even where the latency line has a gap.
 */
function dropMarkersPlugin(getDrops: () => number[], color: string): uPlot.Plugin {
  return {
    hooks: {
      draw: (u) => {
        const drops = getDrops();
        if (drops.length === 0) return;
        const { ctx } = u;
        const top = u.bbox.top;
        const bottom = u.bbox.top + u.bbox.height;
        ctx.save();
        ctx.strokeStyle = color;
        ctx.globalAlpha = 0.5;
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        for (const xVal of drops) {
          const cx = Math.round(u.valToPos(xVal, "x", true));
          ctx.beginPath();
          ctx.moveTo(cx, top);
          ctx.lineTo(cx, bottom);
          ctx.stroke();
        }
        ctx.restore();
      },
    },
  };
}

/**
 * Real-time latency line chart backed by uPlot, with a zero-baselined ms y axis,
 * an elapsed-time x axis, hover read-out, and drop markers for timeouts.
 */
export function LatencyChart({ points, intervalMs, height = CHART_HEIGHT }: LatencyChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const plotRef = useRef<uPlot | null>(null);
  // Latest drops, read by the plugin closure without recreating the chart.
  const dropsRef = useRef<number[]>([]);

  const chart = useMemo(() => buildLatencyChartData(points, intervalMs), [points, intervalMs]);

  // Create the uPlot instance once, wired to the container width.
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const styles = getComputedStyle(container);
    const accent = cssVar(styles, "--accent-color", "#3794ff");
    const axisText = cssVar(styles, "--text-secondary", "#969696");
    // Canvas can't resolve CSS var() in a font string, so build a concrete one.
    const fontFamily = cssVar(styles, "--font-mono", "monospace");
    const grid = cssVar(styles, "--border-primary", "#3c3c3c");
    const dropColor = cssVar(styles, "--color-error", "#f44747");

    const timeAxis = intervalMs != null;
    const axisBase = {
      stroke: axisText,
      grid: { stroke: grid, width: 1 },
      ticks: { stroke: grid, width: 1 },
      font: `${AXIS_FONT_PX}px ${fontFamily}`,
    };
    const opts: uPlot.Options = {
      width: container.clientWidth || 300,
      height,
      // [top, right, bottom, left] gap between the canvas edge and the axes so
      // the first/last tick labels never sit under the container border.
      padding: [12, 18, 8, 12],
      cursor: { y: false, points: { size: 5 } },
      legend: { show: true },
      scales: { x: { time: false }, y: { range: [chart.yMin, chart.yMax] } },
      axes: [
        {
          ...axisBase,
          size: 30,
          values: (_u, splits) => splits.map((v) => (timeAxis ? `${v}s` : `${v}`)),
        },
        {
          ...axisBase,
          size: 46,
          values: (_u, splits) => splits.map((v) => `${v}ms`),
        },
      ],
      series: [
        { label: timeAxis ? "t" : "#" },
        {
          label: "latency",
          stroke: accent,
          width: 1.5,
          spanGaps: false,
          points: { show: true, size: 4, stroke: accent, fill: accent },
          value: (_u, v) => (v == null ? "—" : `${v.toFixed(1)}ms`),
        },
      ],
      plugins: [dropMarkersPlugin(() => dropsRef.current, dropColor)],
    };

    const plot = new uPlot(opts, chart.data, container);
    plotRef.current = plot;

    const resizeObserver = new ResizeObserver(() => {
      const width = container.clientWidth;
      if (width > 0) plot.setSize({ width, height });
    });
    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
      plot.destroy();
      plotRef.current = null;
    };
    // Recreate only when structural options (axis mode / height) change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalMs, height]);

  // Push new samples / axis range into the existing instance on every update.
  useEffect(() => {
    const plot = plotRef.current;
    if (!plot) return;
    // Refresh drop positions before setData triggers the plugin's redraw.
    dropsRef.current = chart.drops;
    plot.setScale("y", { min: chart.yMin, max: chart.yMax });
    plot.setData(chart.data);
  }, [chart]);

  return <div ref={containerRef} className="latency-chart" />;
}
