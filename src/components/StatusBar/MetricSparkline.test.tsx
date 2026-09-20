/**
 * Component test for the CPU sparkline (PROD-0030): mounting with N samples must
 * hand uPlot a series of N points, and a data update must push the new series.
 * uPlot is mocked so the test asserts the data contract without a real canvas.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { MetricSparkline } from "./MetricSparkline";

const ctorData: unknown[] = [];
const setDataCalls: unknown[] = [];
const setData = vi.fn((d: unknown) => setDataCalls.push(d));
const destroy = vi.fn();
const setSize = vi.fn();

vi.mock("uplot/dist/uPlot.min.css", () => ({}));
vi.mock("uplot", () => ({
  default: vi.fn().mockImplementation(function (this: unknown, _opts: unknown, data: unknown) {
    ctorData.push(data);
    return { setData, destroy, setSize };
  }),
}));

let container: HTMLDivElement;
let root: Root;

describe("MetricSparkline", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    ctorData.length = 0;
    setDataCalls.length = 0;
    vi.clearAllMocks();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("hands uPlot N points for N samples", async () => {
    await act(async () => {
      root.render(<MetricSparkline values={[10, 20, 30, 40, 50]} ariaLabel="CPU history" />);
    });
    const data = ctorData[0] as [number[], (number | null)[]];
    expect(data[0]).toHaveLength(5);
    expect(data[1]).toEqual([10, 20, 30, 40, 50]);
  });

  it("pushes the updated series when values change", async () => {
    await act(async () => {
      root.render(<MetricSparkline values={[1, 2]} ariaLabel="CPU history" />);
    });
    await act(async () => {
      root.render(<MetricSparkline values={[1, 2, 3]} ariaLabel="CPU history" />);
    });
    const latest = setDataCalls[setDataCalls.length - 1] as [number[], (number | null)[]];
    expect(latest[1]).toEqual([1, 2, 3]);
  });

  it("exposes an accessible label", async () => {
    await act(async () => {
      root.render(<MetricSparkline values={[1]} ariaLabel="CPU usage history" />);
    });
    const el = container.querySelector(".metric-sparkline");
    expect(el?.getAttribute("aria-label")).toBe("CPU usage history");
    expect(el?.getAttribute("role")).toBe("img");
  });
});
