/**
 * `useProjectedMonitors` — the status bar & Open Connections cut to the projected
 * `system-monitors` region (#2224 render cut). Drives the hook against an
 * in-memory substrate double and asserts: flag-off returns the appStore slice and
 * dispatches nothing; flag-on seeds the region (a `monitor.replace` mirror) and
 * then renders the slice from the projection, value-identical to appStore; and a
 * region that has not caught up falls back to the appStore slice.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  FrameHandler,
  Intent,
  IntentAck,
  ProjectionFrame,
  SnapshotFrame,
  Subscription,
  Transport,
} from "@/services/transport";
import { useAppStore } from "@/store/appStore";
import type { MonitoringEntry, SystemStats } from "@/types/monitoring";

import {
  setMonitorRenderFromProjectionEnabled,
  setMonitorTransportForTest,
  stopMonitorsSubscription,
  SYSTEM_MONITORS_REGION,
  type SystemMonitorsView,
} from "./systemMonitorBridge";
import { useProjectedMonitors } from "./useProjectedMonitors";

vi.mock("@/services/storage", () => ({
  loadConnections: vi.fn(() =>
    Promise.resolve({ connections: [], folders: [], agents: [], externalErrors: [] })
  ),
  getSettings: vi.fn(() =>
    Promise.resolve({ version: "1", externalConnectionFiles: [], powerMonitoringEnabled: true })
  ),
  saveSettings: vi.fn(() => Promise.resolve()),
  getRecoveryWarnings: vi.fn(() => Promise.resolve([])),
}));

vi.mock("@/themes", () => ({ applyTheme: vi.fn(), onThemeChange: vi.fn(() => vi.fn()) }));

function stats(hostname: string, cpu: number): SystemStats {
  return {
    hostname,
    uptimeSeconds: 100,
    loadAverage: [0.1, 0.2, 0.3],
    cpuUsagePercent: cpu,
    memoryTotalKb: 16_000_000,
    memoryAvailableKb: 8_000_000,
    memoryUsedPercent: 50,
    diskTotalKb: 100_000_000,
    diskUsedKb: 40_000_000,
    diskUsedPercent: 40,
    osInfo: "Linux 6.1",
  };
}

function entry(key: string, host: string, s: SystemStats): MonitoringEntry {
  return {
    key,
    host,
    monitorSessionId: key,
    stats: s,
    loading: false,
    error: null,
    status: "live",
    sampleCount: 1,
    paused: false,
    intervalMs: 2000,
  };
}

/** In-memory substrate double: applies `monitor.replace` and fans a snapshot. */
class FakeTransport implements Transport {
  dispatched: Intent[] = [];
  /** When false, `monitor.replace` acks but does NOT advance the region. */
  applyReplace = true;
  private view: SystemMonitorsView = { monitors: {}, statsCache: {} };
  private version = 0;
  private handlers: FrameHandler[] = [];

  async dispatch(intent: Intent): Promise<IntentAck> {
    this.dispatched.push(intent);
    if (intent.kind === "monitor.replace" && this.applyReplace) {
      const p = intent.payload as Partial<SystemMonitorsView>;
      this.view = { monitors: p.monitors ?? {}, statsCache: p.statsCache ?? {} };
      this.version += 1;
      this.fan();
    }
    return {
      intentId: intent.intentId,
      status: "accepted",
      produced: [{ region: SYSTEM_MONITORS_REGION, version: this.version }],
    };
  }

  async subscribe(region: string, onFrame: FrameHandler): Promise<Subscription> {
    this.handlers.push(onFrame);
    return {
      snapshot: this.snapshot(region),
      unsubscribe: () => {
        this.handlers = this.handlers.filter((h) => h !== onFrame);
      },
    };
  }

  async resync(): Promise<SnapshotFrame | null> {
    return null;
  }

  private snapshot(region: string): SnapshotFrame {
    return { kind: "snapshot", region, version: this.version, view: structuredClone(this.view) };
  }

  private fan(): void {
    const frame: ProjectionFrame = this.snapshot(SYSTEM_MONITORS_REGION);
    for (const h of this.handlers) h(frame);
  }
}

/** Render the hook into a throwaway component, exposing the latest return value. */
function renderHook(): { get: () => SystemMonitorsView; unmount: () => void } {
  const container = document.createElement("div");
  const root: Root = createRoot(container);
  let latest: SystemMonitorsView = { monitors: {}, statsCache: {} };

  function Probe() {
    latest = useProjectedMonitors();
    return null;
  }

  act(() => root.render(<Probe />));
  return { get: () => latest, unmount: () => act(() => root.unmount()) };
}

let transport: FakeTransport;

beforeEach(() => {
  transport = new FakeTransport();
  setMonitorTransportForTest(transport);
  useAppStore.setState({ monitors: {}, monitoringStatsCache: {} });
});

afterEach(() => {
  stopMonitorsSubscription();
  setMonitorTransportForTest(null);
  setMonitorRenderFromProjectionEnabled(null);
});

const flush = () => act(async () => await Promise.resolve());

describe("useProjectedMonitors", () => {
  it("flag off: returns the appStore slice and dispatches nothing", async () => {
    setMonitorRenderFromProjectionEnabled(false);
    const s = stats("host-a", 12);
    useAppStore.setState({ monitors: { s1: entry("s1", "host-a", s) }, monitoringStatsCache: { s1: s } });

    const hook = renderHook();
    await flush();

    expect(hook.get().monitors.s1.stats?.cpuUsagePercent).toBe(12);
    expect(transport.dispatched).toHaveLength(0);
    hook.unmount();
  });

  it("flag on: seeds the region then renders the slice from the projection", async () => {
    const s = stats("host-a", 21);
    const monitors = { s1: entry("s1", "host-a", s) };
    useAppStore.setState({ monitors, monitoringStatsCache: { s1: s } });

    const hook = renderHook();
    await flush();
    await flush();

    // The hook seeded appStore's slice via monitor.replace…
    expect(transport.dispatched.some((d) => d.kind === "monitor.replace")).toBe(true);
    // …and now renders a value-identical slice (sourced from the projection).
    expect(hook.get().monitors.s1).toEqual(monitors.s1);
    hook.unmount();
  });

  it("region not caught up: falls back to the appStore slice", async () => {
    transport.applyReplace = false; // the replace acks but never advances the region
    const s = stats("host-b", 7);
    const monitors = { s2: entry("s2", "host-b", s) };
    useAppStore.setState({ monitors, monitoringStatsCache: { s2: s } });

    const hook = renderHook();
    await flush();
    await flush();

    // The projection stays empty, so the gate rejects it and the hook renders
    // the appStore slice verbatim — parity preserved.
    expect(hook.get().monitors.s2).toEqual(monitors.s2);
    hook.unmount();
  });
});
