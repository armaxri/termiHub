import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  FrameHandler,
  Intent,
  IntentAck,
  ProjectionFrame,
  SnapshotFrame,
  Subscription,
  Transport,
} from "@/services/transport";
import type { MonitoringEntry, SystemStats } from "@/types/monitoring";

import {
  currentMonitorsView,
  deepEqual,
  ensureMonitorsSubscribed,
  monitorRenderFromProjectionEnabled,
  monitorsViewMirrors,
  onMonitorsView,
  seedMonitorsRegion,
  setMonitorRenderFromProjectionEnabled,
  setMonitorTransportForTest,
  stopMonitorsSubscription,
  SYSTEM_MONITORS_REGION,
  type SystemMonitorsView,
} from "./systemMonitorBridge";

/** A deterministic stats sample. */
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

/** A live monitor entry for a key. */
function entry(key: string, host: string, s: SystemStats | null): MonitoringEntry {
  return {
    key,
    host,
    monitorSessionId: key,
    stats: s,
    loading: false,
    error: null,
    status: "live",
    sampleCount: s ? 1 : 0,
    paused: false,
    intervalMs: 2000,
  };
}

/**
 * An in-memory substrate double: holds one `system-monitors` view, applies a
 * `monitor.replace` intent by overwriting the view from its payload, and fans a
 * fresh snapshot to every subscriber — so the seed round-trip and multi-subscriber
 * fan-out are exercised without a backend.
 */
class FakeTransport implements Transport {
  dispatched: Intent[] = [];
  private view: SystemMonitorsView = { monitors: {}, statsCache: {} };
  private version = 0;
  private handlers: FrameHandler[] = [];

  async dispatch(intent: Intent): Promise<IntentAck> {
    this.dispatched.push(intent);
    if (intent.kind === "monitor.replace") {
      const payload = intent.payload as Partial<SystemMonitorsView>;
      this.view = { monitors: payload.monitors ?? {}, statsCache: payload.statsCache ?? {} };
      this.version += 1;
      this.fan();
      return {
        intentId: intent.intentId,
        status: "accepted",
        produced: [{ region: SYSTEM_MONITORS_REGION, version: this.version }],
      };
    }
    return { intentId: intent.intentId, status: "accepted", produced: [] };
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

let transport: FakeTransport;

beforeEach(() => {
  transport = new FakeTransport();
  setMonitorTransportForTest(transport);
});

afterEach(() => {
  stopMonitorsSubscription();
  setMonitorTransportForTest(null);
  setMonitorRenderFromProjectionEnabled(null);
});

describe("monitorRenderFromProjectionEnabled flag", () => {
  it("defaults on and honours the programmatic override", () => {
    expect(monitorRenderFromProjectionEnabled()).toBe(true);
    setMonitorRenderFromProjectionEnabled(false);
    expect(monitorRenderFromProjectionEnabled()).toBe(false);
    setMonitorRenderFromProjectionEnabled(true);
    expect(monitorRenderFromProjectionEnabled()).toBe(true);
    setMonitorRenderFromProjectionEnabled(null);
    expect(monitorRenderFromProjectionEnabled()).toBe(true);
  });
});

describe("deepEqual", () => {
  it("treats an integer and its float round-trip as equal", () => {
    expect(deepEqual(40, 40.0)).toBe(true);
    expect(deepEqual({ a: [1, 2] }, { a: [1, 2] })).toBe(true);
  });

  it("distinguishes differing values, key sets, and null", () => {
    expect(deepEqual({ a: 1 }, { a: 2 })).toBe(false);
    expect(deepEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(deepEqual(null, {})).toBe(false);
    expect(deepEqual([1, 2], [1, 2, 3])).toBe(false);
  });
});

describe("monitorsViewMirrors", () => {
  const monitors = { s1: entry("s1", "host-a", stats("host-a", 12)) };
  const statsCache = { s1: stats("host-a", 12) };

  it("is false for an undefined view", () => {
    expect(monitorsViewMirrors(undefined, monitors, statsCache)).toBe(false);
  });

  it("is true when the view value-matches the appStore slice", () => {
    const view: SystemMonitorsView = { monitors: structuredClone(monitors), statsCache };
    expect(monitorsViewMirrors(view, monitors, statsCache)).toBe(true);
  });

  it("is false when any entry field diverges", () => {
    const view: SystemMonitorsView = {
      monitors: { s1: { ...monitors.s1, paused: true } },
      statsCache,
    };
    expect(monitorsViewMirrors(view, monitors, statsCache)).toBe(false);
  });
});

describe("seedMonitorsRegion", () => {
  it("dispatches monitor.replace carrying the whole slice", async () => {
    const monitors = { s1: entry("s1", "host-a", stats("host-a", 5)) };
    const statsCache = { s1: stats("host-a", 5) };
    await seedMonitorsRegion(monitors, statsCache);
    expect(transport.dispatched).toHaveLength(1);
    expect(transport.dispatched[0]).toMatchObject({
      kind: "monitor.replace",
      payload: { monitors, statsCache },
    });
  });

  it("de-dupes an identical slice but re-seeds after a change", async () => {
    const monitors = { s1: entry("s1", "host-a", stats("host-a", 5)) };
    await seedMonitorsRegion(monitors, {});
    await seedMonitorsRegion(monitors, {});
    expect(transport.dispatched).toHaveLength(1);

    const changed = { s1: entry("s1", "host-a", stats("host-a", 9)) };
    await seedMonitorsRegion(changed, {});
    expect(transport.dispatched).toHaveLength(2);
  });
});

describe("seed round-trip → the region mirrors appStore", () => {
  it("makes the projected view a faithful mirror of the seeded slice", async () => {
    const received: SystemMonitorsView[] = [];
    const unsubscribe = onMonitorsView((v) => received.push(v));
    await ensureMonitorsSubscribed();

    const monitors = { s1: entry("s1", "host-a", stats("host-a", 21)) };
    const statsCache = { s1: stats("host-a", 21) };
    await seedMonitorsRegion(monitors, statsCache);

    // The region now carries the seeded slice and the gate accepts it.
    expect(monitorsViewMirrors(currentMonitorsView(), monitors, statsCache)).toBe(true);
    expect(received[received.length - 1]).toEqual({ monitors, statsCache });
    unsubscribe();
  });
});
