/**
 * Shared uPlot glue (PROD-0030). Both the network {@link
 * import("../NetworkTools/LatencyChart").LatencyChart} and the monitoring
 * {@link import("../StatusBar/MetricSparkline").MetricSparkline} render a live
 * uPlot line whose canvas has to be created once, resized with its container,
 * fed new data on every update, and destroyed on unmount. That lifecycle was
 * duplicated verbatim in each; this module owns it once so callers only supply
 * the bits that differ — the data tuple and an options factory.
 */

import { useEffect, useLayoutEffect, useRef } from "react";
import type { DependencyList, MutableRefObject } from "react";
import uPlot from "uplot";
import { useThemeRevision } from "@/hooks/useThemeRevision";

/**
 * Resolve a CSS custom property to a concrete value. A `<canvas>` cannot read
 * `var(--token)`, so series/axis colours must be resolved to real values before
 * they reach uPlot. The theme engine always writes every colour token, so the
 * optional fallback is only for non-colour values (e.g. a font stack) in a
 * headless (jsdom) environment where computed styles are empty.
 */
export function cssVar(styles: CSSStyleDeclaration, name: string, fallback = ""): string {
  return styles.getPropertyValue(name).trim() || fallback;
}

/** Everything {@link useUplot} needs to own a chart's lifecycle. */
export interface UseUplotSpec {
  /** Current uPlot data tuple. Memoise it so the update effect only fires on change. */
  data: uPlot.AlignedData;
  /**
   * Build the uPlot options for the (mounted) container. Called on create,
   * whenever {@link recreateDeps} changes, and whenever the active theme is
   * re-applied, so it may read `getComputedStyle` to resolve theme tokens. Must set `height` (used to keep the chart's height
   * fixed across container-width resizes) and `width`.
   */
  makeOptions: (container: HTMLDivElement) => uPlot.Options;
  /** Structural inputs (axis mode, range, height) whose change recreates the plot. */
  recreateDeps: DependencyList;
  /**
   * Optional per-update hook run just before `setData` (e.g. to push a new
   * y-axis scale). Read from a ref, so passing a fresh closure each render is
   * fine and never recreates the plot.
   */
  onUpdate?: (plot: uPlot, data: uPlot.AlignedData) => void;
}

/**
 * Own a uPlot instance's full lifecycle for a container `<div>`: create it once
 * (wired to the container width), keep its width in sync via a `ResizeObserver`,
 * push new data on every update, and destroy it on unmount. The plot is also
 * rebuilt on every theme change so the canvas re-reads the colour tokens
 * (UI2-004). Returns the ref the caller must attach to its container element.
 */
export function useUplot({
  data,
  makeOptions,
  recreateDeps,
  onUpdate,
}: UseUplotSpec): MutableRefObject<HTMLDivElement | null> {
  const containerRef = useRef<HTMLDivElement | null>(null);
  // Bumps on every theme apply/preview; a canvas cannot follow CSS variables,
  // so the plot is rebuilt to re-resolve its colours (UI2-004).
  const themeRevision = useThemeRevision();
  const plotRef = useRef<uPlot | null>(null);
  // Latest closures/data read inside effects without widening their deps.
  const onUpdateRef = useRef(onUpdate);
  onUpdateRef.current = onUpdate;
  const dataRef = useRef(data);
  dataRef.current = data;

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const opts = makeOptions(container);
    const plot = new uPlot(opts, dataRef.current, container);
    plotRef.current = plot;

    const { height } = opts;
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
    // Recreate only when the caller's structural options or the theme change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...recreateDeps, themeRevision]);

  useEffect(() => {
    const plot = plotRef.current;
    if (!plot) return;
    onUpdateRef.current?.(plot, data);
    plot.setData(data);
  }, [data]);

  return containerRef;
}
