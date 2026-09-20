import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { buildSparklineData } from "./metricSparklineData";

interface MetricSparklineProps {
  /** Series values (oldest first). `null` entries render as gaps. */
  values: (number | null)[];
  /** Y-axis lower bound (defaults to 0, e.g. a percentage floor). */
  min?: number;
  /** Y-axis upper bound (defaults to 100, e.g. a percentage ceiling). */
  max?: number;
  /** Sparkline height in pixels. */
  height?: number;
  /** Sparkline width in pixels. */
  width?: number;
  /** Accessible label for the chart (it carries no axis text of its own). */
  ariaLabel: string;
}

/** Default sparkline dimensions — compact enough for a status-bar dropdown. */
const SPARK_HEIGHT = 32;
const SPARK_WIDTH = 176;

/** Resolve a CSS custom property to a concrete colour (canvas can't read CSS vars). */
function cssVar(styles: CSSStyleDeclaration, name: string, fallback: string): string {
  return styles.getPropertyValue(name).trim() || fallback;
}

/**
 * Compact, axis-less uPlot sparkline for a single metric series (PROD-0030).
 *
 * A trimmed sibling of {@link import("../NetworkTools/LatencyChart").LatencyChart}:
 * no axes, legend, cursor, or hover read-out — just the line against a fixed
 * `[min, max]` range so a status-bar dropdown can show CPU% history at a glance.
 * Colours resolve from design tokens (no hard-coded hex). uPlot renders a single
 * static frame per data update with no transition, so there is no motion to gate
 * for `prefers-reduced-motion`.
 */
export function MetricSparkline({
  values,
  min = 0,
  max = 100,
  height = SPARK_HEIGHT,
  width = SPARK_WIDTH,
  ariaLabel,
}: MetricSparklineProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const plotRef = useRef<uPlot | null>(null);

  const chart = useMemo(() => buildSparklineData(values), [values]);

  // Create the uPlot instance once, wired to the container width.
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const styles = getComputedStyle(container);
    const accent = cssVar(styles, "--accent-color", "#3794ff");

    const opts: uPlot.Options = {
      width: container.clientWidth || width,
      height,
      padding: [2, 2, 2, 2],
      cursor: { show: false },
      legend: { show: false },
      scales: { x: { time: false }, y: { range: [min, max] } },
      axes: [{ show: false }, { show: false }],
      series: [
        {},
        {
          stroke: accent,
          width: 1.5,
          spanGaps: false,
          points: { show: false },
        },
      ],
    };

    const plot = new uPlot(opts, chart.data, container);
    plotRef.current = plot;

    const resizeObserver = new ResizeObserver(() => {
      const w = container.clientWidth;
      if (w > 0) plot.setSize({ width: w, height });
    });
    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
      plot.destroy();
      plotRef.current = null;
    };
    // Recreate only when structural options (range / height) change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [min, max, height, width]);

  // Push new samples into the existing instance on every update.
  useEffect(() => {
    const plot = plotRef.current;
    if (!plot) return;
    plot.setData(chart.data);
  }, [chart]);

  return (
    <div
      ref={containerRef}
      className="metric-sparkline"
      role="img"
      aria-label={ariaLabel}
      style={{ height }}
    />
  );
}
