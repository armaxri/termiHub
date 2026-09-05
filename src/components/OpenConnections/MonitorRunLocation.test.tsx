/**
 * The system-monitor "Run on" control (#2593) lets a user pick where a monitor
 * runs — This computer (default) or a connected agent — and reconnects the
 * monitor so the streamed samples come from the chosen host. This pins:
 *   - the selector renders on the monitor row, and
 *   - choosing an agent records the vantage and reconnects the monitor
 *     (disconnect → reconnect) forwarding the chosen run-location.
 *
 * The Radix `Select` inside {@link RunLocationSelect} is not interactive under
 * jsdom, so it is mocked to a button that fires `onChange` with the first agent
 * — the wiring under test is the handler, not the primitive.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";

import { useRunLocationStore } from "@/store/runLocationStore";
import { useAppStore } from "@/store/appStore";
import type { MonitoringEntry } from "@/types/monitoring";
import { MonitorRunLocation } from "./MonitorRunLocation";

vi.mock("@/store/useProjectedAgents", () => ({
  useProjectedAgents: () => ({ remoteAgents: [{ id: "build", name: "Build box" }] }),
}));

vi.mock("@/components/ui", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// Expose the selector's onChange as a click that chooses the first agent.
vi.mock("@/components/RunLocationSelect", () => ({
  RunLocationSelect: ({
    onChange,
    agents,
  }: {
    onChange: (l: { kind: "agent"; agentId: string }) => void;
    agents: { id: string }[];
  }) => (
    <button
      data-testid="mock-select-agent"
      onClick={() => onChange({ kind: "agent", agentId: agents[0].id })}
    >
      pick agent
    </button>
  ),
}));

const entry: MonitoringEntry = {
  key: "sess-1",
  host: "host-a",
  monitorSessionId: "sess-1",
  stats: null,
  loading: false,
  error: null,
  status: "live",
  sampleCount: 3,
  paused: false,
  intervalMs: 2000,
};

let container: HTMLDivElement;
let root: Root;
let connectMonitoring: ReturnType<typeof useAppStore.getState>["connectMonitoring"] &
  ReturnType<typeof vi.fn>;
let disconnectMonitoring: ReturnType<typeof useAppStore.getState>["disconnectMonitoring"] &
  ReturnType<typeof vi.fn>;

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe("MonitorRunLocation", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useRunLocationStore.setState({ systemMonitorLocations: {} });
    connectMonitoring = vi.fn(() => Promise.resolve()) as typeof connectMonitoring;
    disconnectMonitoring = vi.fn(() => Promise.resolve()) as typeof disconnectMonitoring;
    useAppStore.setState({ connectMonitoring, disconnectMonitoring });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("renders the selector", async () => {
    await act(async () => {
      root.render(<MonitorRunLocation entry={entry} />);
    });
    await flush();
    expect(container.querySelector('[data-testid="mock-select-agent"]')).not.toBeNull();
  });

  it("records the agent vantage and reconnects with the chosen host", async () => {
    await act(async () => {
      root.render(<MonitorRunLocation entry={entry} />);
    });
    await flush();

    const btn = container.querySelector<HTMLButtonElement>('[data-testid="mock-select-agent"]')!;
    await act(async () => {
      btn.click();
    });
    await flush();

    // Reconnect: tear down the current subscription, then re-open on the agent.
    expect(disconnectMonitoring).toHaveBeenCalledWith("sess-1");
    expect(connectMonitoring).toHaveBeenCalledWith("sess-1", "host-a", {
      kind: "agent",
      agentId: "build",
    });
    // The chosen vantage is recorded so the selector keeps showing it.
    expect(useRunLocationStore.getState().systemMonitorLocations["sess-1"]).toEqual({
      kind: "agent",
      agentId: "build",
    });
  });

  it("is a no-op when the chosen vantage is unchanged", async () => {
    // Already on the agent the mocked selector fires: re-picking it must not
    // churn a live subscription.
    useRunLocationStore.setState({
      systemMonitorLocations: { "sess-1": { kind: "agent", agentId: "build" } },
    });
    await act(async () => {
      root.render(<MonitorRunLocation entry={entry} />);
    });
    await flush();

    const btn = container.querySelector<HTMLButtonElement>('[data-testid="mock-select-agent"]')!;
    await act(async () => {
      btn.click();
    });
    await flush();

    expect(disconnectMonitoring).not.toHaveBeenCalled();
    expect(connectMonitoring).not.toHaveBeenCalled();
  });
});
