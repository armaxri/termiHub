import { useMemo } from "react";
import type uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { cssVar, useUplot } from "@/components/charts/uplot";
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

/**
 * Compact, axis-less uPlot sparkline for a single metric series (PROD-0030).
 *
 * A trimmed sibling of {@link import("../NetworkTools/LatencyChart").LatencyChart}:
 * no axes, legend, cursor, or hover read-out — just the line against a fixed
 * `[min, max]` range so a status-bar dropdown or the monitoring panel can show a
 * metric's history at a glance. Both share the uPlot lifecycle glue via
 * {@link useUplot}. Colours resolve from design tokens (no hard-coded hex).
 * uPlot renders a single static frame per data update with no transition, so
 * there is no motion to gate for `prefers-reduced-motion`.
 */
export function MetricSparkline({
  values,
  min = 0,
  max = 100,
  height = SPARK_HEIGHT,
  width = SPARK_WIDTH,
  ariaLabel,
}: MetricSparklineProps) {
  const chart = useMemo(() => buildSparklineData(values), [values]);

  const makeOptions = (container: HTMLDivElement): uPlot.Options => {
    const styles = getComputedStyle(container);
    const accent = cssVar(styles, "--accent-color", "#3794ff");
    return {
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
  };

  const containerRef = useUplot({
    data: chart.data,
    makeOptions,
    // Recreate only when structural options (range / height) change.
    recreateDeps: [min, max, height, width],
  });

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
