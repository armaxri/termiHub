/**
 * The host menu's metric rows (#5628) say each value at a glance (#6183,
 * states-3): a percentage is a usage bar filled to it, which reads from the
 * first sample, where a 14 px sparkline drew the same flat rule for 45 % and
 * 89 %. A rate has no fixed range and keeps its line.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import type { MetricBlock } from "./monitoringHistoryModel";

vi.mock("./MetricSparkline", () => ({
  MetricSparkline: ({ ariaLabel }: { ariaLabel: string }) => (
    <div data-testid="sparkline" aria-label={ariaLabel} />
  ),
}));
const { MonitoringMetricRows } = await import("./MonitoringMetricRows");

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function block(key: string, unit: MetricBlock["unit"], values: number[]): MetricBlock {
  return {
    key,
    label: key,
    unit,
    values,
    min: 0,
    max: unit === "percent" ? 100 : 1000,
    hasData: true,
  } as MetricBlock;
}

const q = (sel: string) => container.querySelector<HTMLElement>(sel);

describe("MonitoringMetricRows (#6183, states-3)", () => {
  it("draws a percentage as a usage bar filled to its value", () => {
    act(() =>
      root.render(
        <MonitoringMetricRows
          blocks={[block("cpu", "percent", [45]), block("swap", "percent", [10, 89])]}
        />
      )
    );
    const cpu = q('[data-testid="monitoring-metric-cpu"] [role="meter"]')!;
    expect(cpu.getAttribute("aria-valuenow")).toBe("45");
    expect(cpu.getAttribute("aria-label")).toBe("cpu usage");
    expect(
      q('[data-testid="monitoring-metric-cpu"] .monitoring-menu__usage-fill')!.style.width
    ).toBe("45%");
    // A high value takes the warning and critical tones of the per-core bars.
    expect(
      q('[data-testid="monitoring-metric-swap"] .monitoring-menu__usage-fill')!.className
    ).toContain("monitoring-menu__core-fill--warning");
    expect(q('[data-testid="monitoring-metric-cpu"] [data-testid="sparkline"]')).toBeNull();
  });

  it("keeps a line for a rate", () => {
    act(() => root.render(<MonitoringMetricRows blocks={[block("netRx", "rate", [1, 5, 3])]} />));
    expect(q('[data-testid="monitoring-metric-netRx"] [data-testid="sparkline"]')).not.toBeNull();
    expect(q('[data-testid="monitoring-metric-netRx"] [role="meter"]')).toBeNull();
  });
});
