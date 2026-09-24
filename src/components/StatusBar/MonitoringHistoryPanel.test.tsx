/**
 * Component test for the monitoring history panel (PROD-0030): it renders a
 * chart per metric once samples exist, and a loading empty-state when the window
 * is still empty. uPlot is mocked so the assertions are about which blocks
 * render, not canvas output.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { MonitoringHistoryPanel } from "./MonitoringHistoryPanel";
import { emptyMonitorHistories, type MonitorHistories } from "@/store/useMonitorHistory";

vi.mock("uplot/dist/uPlot.min.css", () => ({}));
vi.mock("uplot", () => ({
  default: vi.fn().mockImplementation(function (this: unknown) {
    return { setData: vi.fn(), destroy: vi.fn(), setSize: vi.fn() };
  }),
}));

let container: HTMLDivElement;
let root: Root;

function histories(overrides: Partial<MonitorHistories>): MonitorHistories {
  return { ...emptyMonitorHistories(), ...overrides };
}

describe("MonitoringHistoryPanel", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.clearAllMocks();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("shows a loading empty-state when there are no samples", async () => {
    await act(async () => {
      root.render(
        <MonitoringHistoryPanel
          open
          onOpenChange={() => {}}
          host="example"
          histories={emptyMonitorHistories()}
        />
      );
    });
    expect(document.querySelector('[data-testid="monitoring-history-empty"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="monitoring-history-cpu"]')).toBeNull();
  });

  it("renders a chart block per metric once samples exist", async () => {
    await act(async () => {
      root.render(
        <MonitoringHistoryPanel
          open
          onOpenChange={() => {}}
          host="example"
          histories={histories({ cpu: [10, 20, 30], memory: [40, 45, 50], netRx: [0, 1000, 2000] })}
        />
      );
    });
    expect(document.querySelector('[data-testid="monitoring-history-empty"]')).toBeNull();
    expect(document.querySelector('[data-testid="monitoring-history-cpu"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="monitoring-history-memory"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="monitoring-history-netRx"]')).not.toBeNull();
    // Swap has no samples here, so its block is omitted.
    expect(document.querySelector('[data-testid="monitoring-history-swap"]')).toBeNull();
  });

  it("includes a swap block when swap has history", async () => {
    await act(async () => {
      root.render(
        <MonitoringHistoryPanel
          open
          onOpenChange={() => {}}
          host="example"
          histories={histories({ cpu: [10], swap: [5, 6] })}
        />
      );
    });
    expect(document.querySelector('[data-testid="monitoring-history-swap"]')).not.toBeNull();
  });
});
