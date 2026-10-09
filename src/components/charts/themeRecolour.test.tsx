/**
 * Live theme recolouring for the uPlot charts (UI2-004, #4356).
 *
 * A `<canvas>` cannot read `var(--token)`, so both charts resolve their colours
 * to concrete values when the plot is built. They used to build it only when
 * structural options changed, so a theme switch left a mounted chart drawing
 * the previous palette (e.g. dark-theme grid lines on a light background).
 * These tests switch the theme while a chart is mounted and assert the plot is
 * rebuilt with the new theme's colours.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import type uPlot from "uplot";
import { MetricSparkline } from "@/components/StatusBar/MetricSparkline";
import { LatencyChart } from "@/components/NetworkTools/LatencyChart";
import { applyTheme, dispose } from "@/themes/engine";
import { darkTheme } from "@/themes/dark";
import { lightTheme } from "@/themes/light";
import { solarizedLightTheme } from "@/themes/solarized-light";

const ctorOpts: uPlot.Options[] = [];
const destroy = vi.fn();

vi.mock("uplot/dist/uPlot.min.css", () => ({}));
vi.mock("uplot", () => ({
  default: vi.fn().mockImplementation(function (this: unknown, opts: uPlot.Options) {
    ctorOpts.push(opts);
    return { setData: vi.fn(), destroy, setSize: vi.fn(), setScale: vi.fn() };
  }),
}));

let container: HTMLDivElement;
let root: Root;
let realGetComputedStyle: typeof window.getComputedStyle;

/** Colour a series/axis was built with, as handed to uPlot. */
function latest(): uPlot.Options {
  return ctorOpts[ctorOpts.length - 1];
}

describe("uPlot charts follow a live theme switch", () => {
  beforeEach(() => {
    // jsdom does not inherit custom properties from :root to descendants, so
    // resolve `--*` reads against the document root as a real browser would.
    realGetComputedStyle = window.getComputedStyle;
    vi.spyOn(window, "getComputedStyle").mockImplementation((el, pseudo) => {
      const own = realGetComputedStyle(el, pseudo);
      const rootStyles = realGetComputedStyle(document.documentElement);
      return new Proxy(own, {
        get(target, prop) {
          if (prop === "getPropertyValue") {
            return (name: string) =>
              target.getPropertyValue(name) || rootStyles.getPropertyValue(name);
          }
          const value = Reflect.get(target, prop, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    });
    applyTheme("dark");
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    ctorOpts.length = 0;
    destroy.mockClear();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    dispose();
    vi.restoreAllMocks();
  });

  it("rebuilds the sparkline with the new accent on a theme switch", async () => {
    await act(async () => {
      root.render(<MetricSparkline values={[1, 2, 3]} ariaLabel="CPU history" />);
    });
    expect(latest().series[1].stroke).toBe(darkTheme.colors.accentColor);

    await act(async () => {
      applyTheme("solarized-light");
    });
    expect(destroy).toHaveBeenCalled();
    expect(latest().series[1].stroke).toBe(solarizedLightTheme.colors.accentColor);
  });

  it("rebuilds the latency chart with the new axis, grid and line colours", async () => {
    await act(async () => {
      root.render(<LatencyChart points={[10, null, 12]} intervalMs={1000} />);
    });
    const dark = latest();
    expect(dark.series[1].stroke).toBe(darkTheme.colors.accentColor);
    expect(dark.axes?.[0].stroke).toBe(darkTheme.colors.textSecondary);
    expect(dark.axes?.[0].grid?.stroke).toBe(darkTheme.colors.borderPrimary);

    await act(async () => {
      applyTheme("light");
    });
    const light = latest();
    expect(light.series[1].stroke).toBe(lightTheme.colors.accentColor);
    expect(light.axes?.[0].stroke).toBe(lightTheme.colors.textSecondary);
    expect(light.axes?.[1].grid?.stroke).toBe(lightTheme.colors.borderPrimary);
  });

  it("does not rebuild the chart when the theme is unchanged by a data update", async () => {
    await act(async () => {
      root.render(<MetricSparkline values={[1]} ariaLabel="CPU history" />);
    });
    await act(async () => {
      root.render(<MetricSparkline values={[1, 2]} ariaLabel="CPU history" />);
    });
    expect(ctorOpts).toHaveLength(1);
  });
});
