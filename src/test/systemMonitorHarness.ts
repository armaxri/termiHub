/**
 * Test harness for the authoritative `system-monitors` projection region (#2224).
 *
 * Since the Monitors reducer removal made the region the single source of truth,
 * tests can no longer seed monitor state into `appStore` — they seed it into the
 * region. {@link FakeMonitorTransport} is an in-memory twin of the Rust
 * `SystemMonitorStore`: it holds one `system-monitors` view, folds the granular
 * `monitor.*` intents exactly as the backend store does, and fans a fresh snapshot
 * to every subscriber. {@link seed} pre-populates the view for a test's initial
 * render; {@link FakeMonitorTransport.dispatched} records dispatched intents for
 * assertions.
 */

import type {
  FrameHandler,
  Intent,
  IntentAck,
  SnapshotFrame,
  Subscription,
  Transport,
} from "@/services/transport";
import {
  setMonitorTransportForTest,
  stopMonitorsSubscription,
  SYSTEM_MONITORS_REGION,
  type SystemMonitorsView,
} from "@/store/systemMonitorBridge";
import { DEFAULT_MONITORING_INTERVAL_MS } from "@/types/monitoring";
import type { MonitorStatus, MonitoringEntry, SystemStats } from "@/types/monitoring";

/** A deterministic stats sample for a host. */
export function fakeStats(hostname: string, cpu = 10): SystemStats {
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

/** A monitor entry, defaulting to a live one keyed by its owning session id. */
export function fakeMonitor(
  key: string,
  overrides: Partial<MonitoringEntry> = {}
): MonitoringEntry {
  return {
    key,
    host: `host-${key}`,
    monitorSessionId: key,
    stats: null,
    loading: false,
    error: null,
    status: "live",
    sampleCount: 0,
    paused: false,
    intervalMs: DEFAULT_MONITORING_INTERVAL_MS,
    ...overrides,
  };
}

/** Build a `system-monitors` view from a list of entries (+ optional stats cache). */
export function monitorsView(
  entries: MonitoringEntry[],
  statsCache: Record<string, SystemStats> = {}
): SystemMonitorsView {
  const monitors: Record<string, MonitoringEntry> = {};
  for (const e of entries) monitors[e.key] = e;
  return { monitors, statsCache };
}

/**
 * An in-memory substrate double for the `system-monitors` region: holds one view,
 * folds the granular `monitor.*` intents like the Rust store, and fans a snapshot
 * to every subscriber. Faithful enough that a client-dispatched intent round-trips
 * back into the projected view.
 */
export class FakeMonitorTransport implements Transport {
  dispatched: Intent[] = [];
  private view: SystemMonitorsView = { monitors: {}, statsCache: {} };
  private version = 0;
  private handlers = new Set<FrameHandler>();

  /** Seed the region view directly (test setup), fanning a snapshot. */
  seed(view: SystemMonitorsView): void {
    this.view = { monitors: { ...view.monitors }, statsCache: { ...view.statsCache } };
    this.bump();
  }

  /** Intent kinds dispatched, in order (assertion helper). */
  kinds(): string[] {
    return this.dispatched.map((i) => i.kind);
  }

  async dispatch(intent: Intent): Promise<IntentAck> {
    this.dispatched.push(intent);
    const p = intent.payload as Record<string, unknown>;
    const m = this.view.monitors;
    const key = p.key as string;
    switch (intent.kind) {
      case "monitor.replace":
        this.view = {
          monitors: (p.monitors as SystemMonitorsView["monitors"]) ?? {},
          statsCache: (p.statsCache as SystemMonitorsView["statsCache"]) ?? {},
        };
        break;
      case "monitor.open": {
        const cached = this.view.statsCache[key] ?? null;
        m[key] = {
          key,
          host: (p.host as string) ?? null,
          monitorSessionId: null,
          stats: cached,
          loading: true,
          error: null,
          status: "connecting",
          sampleCount: 0,
          paused: false,
          intervalMs: (p.intervalMs as number) ?? DEFAULT_MONITORING_INTERVAL_MS,
        };
        break;
      }
      case "monitor.opened":
        if (m[key])
          m[key] = {
            ...m[key],
            monitorSessionId: key,
            loading: false,
            status: "live",
            error: null,
          };
        break;
      case "monitor.openFailed":
        if (m[key])
          m[key] = {
            ...m[key],
            monitorSessionId: null,
            loading: false,
            status: null,
            error: (p.error as string) ?? null,
          };
        break;
      case "monitor.stats": {
        const stats = p.stats as SystemStats;
        this.view.statsCache[key] = stats;
        if (m[key]) m[key] = { ...m[key], stats, sampleCount: m[key].sampleCount + 1 };
        break;
      }
      case "monitor.status":
        if (m[key]) m[key] = { ...m[key], status: p.status as MonitorStatus };
        break;
      case "monitor.setPaused": {
        const paused = p.paused as boolean;
        if (m[key]) m[key] = { ...m[key], paused, status: paused ? "paused" : "live" };
        break;
      }
      case "monitor.setInterval":
        if (m[key]) m[key] = { ...m[key], intervalMs: p.intervalMs as number };
        break;
      case "monitor.clearError":
        if (m[key]) m[key] = { ...m[key], error: null };
        break;
      case "monitor.close":
        delete m[key];
        break;
      default:
        return { intentId: intent.intentId, status: "accepted", produced: [] };
    }
    this.bump();
    return {
      intentId: intent.intentId,
      status: "accepted",
      produced: [{ region: SYSTEM_MONITORS_REGION, version: this.version }],
    };
  }

  async subscribe(region: string, onFrame: FrameHandler): Promise<Subscription> {
    this.handlers.add(onFrame);
    return {
      snapshot: this.snapshot(region),
      unsubscribe: () => this.handlers.delete(onFrame),
    };
  }

  async resync(): Promise<SnapshotFrame | null> {
    return null;
  }

  private snapshot(region: string): SnapshotFrame {
    return { kind: "snapshot", region, version: this.version, view: structuredClone(this.view) };
  }

  private bump(): void {
    this.version += 1;
    const frame = this.snapshot(SYSTEM_MONITORS_REGION);
    for (const h of this.handlers) h(frame);
  }
}

/**
 * Install a {@link FakeMonitorTransport} as the monitor bridge's transport and
 * optionally seed it. Returns the transport plus a `teardown` that drops the
 * subscription and restores the real transport — call it in `afterEach`.
 */
export function installMonitorHarness(initial?: SystemMonitorsView): {
  transport: FakeMonitorTransport;
  teardown: () => void;
} {
  const transport = new FakeMonitorTransport();
  setMonitorTransportForTest(transport);
  if (initial) transport.seed(initial);
  return {
    transport,
    teardown: () => {
      stopMonitorsSubscription();
      setMonitorTransportForTest(null);
    },
  };
}
