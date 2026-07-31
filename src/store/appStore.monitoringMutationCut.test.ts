/**
 * Monitors mutation cut (#2224, part of #2139) — cut-vs-local parity.
 *
 * The mutation cut routes each monitor lifecycle action through a granular
 * `monitor.*` intent so the backend `SystemMonitorStore` becomes authoritative,
 * while the local `appStore` reducer path stays in place as the render source and
 * the resilience / rollback fallback (the reducer removal is a later step).
 *
 * These tests prove the cut is parity-safe end to end: with the flag **on**, the
 * intents dispatched by the actions — applied by a faithful in-memory port of the
 * Rust store (mirroring `system_monitor_projection/store.rs`) — reproduce the exact
 * `appStore` monitoring slice (`monitors` + `monitoringStatsCache`) for every
 * action and its fan-out. With the flag **off**, no intents are dispatched and the
 * local slice is byte-identical — the instant rollback path the flip relies on.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@/services/storage", () => ({
  loadConnections: vi.fn(() =>
    Promise.resolve({ connections: [], folders: [], agents: [], externalErrors: [] })
  ),
  persistConnection: vi.fn(() => Promise.resolve()),
  removeConnection: vi.fn(() => Promise.resolve()),
  persistFolder: vi.fn(() => Promise.resolve()),
  removeFolder: vi.fn(() => Promise.resolve()),
  getSettings: vi.fn(() =>
    Promise.resolve({
      version: "1",
      externalConnectionFiles: [],
      powerMonitoringEnabled: true,
      fileBrowserEnabled: true,
    })
  ),
  saveSettings: vi.fn(() => Promise.resolve()),
  moveConnectionToFile: vi.fn(() => Promise.resolve()),
  reloadExternalConnections: vi.fn(() => Promise.resolve([])),
  getRecoveryWarnings: vi.fn(() => Promise.resolve([])),
}));

const mockSessionMonitoringOpen = vi.fn();
const mockSessionMonitoringClose = vi.fn();
const mockSessionMonitoringSetPaused = vi.fn();
const mockSessionMonitoringSetInterval = vi.fn();
const mockSessionMonitoringCancel = vi.fn();

vi.mock("@/services/api", () => ({
  sftpOpen: vi.fn(),
  sftpClose: vi.fn(),
  sftpListDir: vi.fn(),
  localListDir: vi.fn(),
  vscodeAvailable: vi.fn(() => Promise.resolve(false)),
  sessionMonitoringOpen: (...args: unknown[]) => mockSessionMonitoringOpen(...args),
  sessionMonitoringClose: (...args: unknown[]) => mockSessionMonitoringClose(...args),
  sessionMonitoringSetPaused: (...args: unknown[]) => mockSessionMonitoringSetPaused(...args),
  sessionMonitoringSetInterval: (...args: unknown[]) => mockSessionMonitoringSetInterval(...args),
  sessionMonitoringCancel: (...args: unknown[]) => mockSessionMonitoringCancel(...args),
}));

type StatsCallback = (sessionId: string, stats: SystemStats) => void;
type StatusCallback = (sessionId: string, status: MonitorStatus) => void;
let statsCallbacks: StatsCallback[] = [];
let statusCallbacks: StatusCallback[] = [];
const mockStatsUnlisten = vi.fn();
const mockStatusUnlisten = vi.fn();

function pushStats(sessionId: string, stats: SystemStats) {
  statsCallbacks.forEach((cb) => cb(sessionId, stats));
}
function pushStatus(sessionId: string, status: MonitorStatus) {
  statusCallbacks.forEach((cb) => cb(sessionId, status));
}

vi.mock("@/services/events", () => ({
  onSessionMonitoringStats: (cb: StatsCallback) => {
    statsCallbacks.push(cb);
    return Promise.resolve(mockStatsUnlisten);
  },
  onSessionMonitoringStatus: (cb: StatusCallback) => {
    statusCallbacks.push(cb);
    return Promise.resolve(mockStatusUnlisten);
  },
  onPersistentSessionStateChanged: vi.fn(() => Promise.resolve(() => {})),
}));

import { useAppStore } from "./appStore";
import { setMonitorIntentsEnabled, setMonitorTransportForTest } from "./systemMonitorBridge";
import {
  DEFAULT_MONITORING_INTERVAL_MS,
  type MonitoringEntry,
  type MonitorStatus,
  type SystemStats,
} from "@/types/monitoring";
import type {
  FrameHandler,
  Intent,
  IntentAck,
  ProjectionFrame,
  SnapshotFrame,
  Subscription,
  Transport,
} from "@/services/transport";

const SESSION_A = "term-sess-a";
const SESSION_B = "term-sess-b";
const HOST_A = "pi@pi.local:22";
const HOST_B = "admin@server.local:2222";

const TEST_STATS: SystemStats = {
  hostname: "pi",
  uptimeSeconds: 86400,
  loadAverage: [0.5, 0.3, 0.2],
  cpuUsagePercent: 25.0,
  memoryTotalKb: 1048576,
  memoryAvailableKb: 524288,
  memoryUsedPercent: 50.0,
  diskTotalKb: 10485760,
  diskUsedKb: 5242880,
  diskUsedPercent: 50.0,
  osInfo: "Linux 6.1",
};

interface RegionView {
  monitors: Record<string, MonitoringEntry>;
  statsCache: Record<string, SystemStats>;
}

/** A fresh idle entry — the twin of the Rust `MonitorEntry::empty`. */
function emptyEntry(key: string, host: string | null): MonitoringEntry {
  return {
    key,
    host,
    monitorSessionId: null,
    stats: null,
    loading: false,
    error: null,
    status: null,
    sampleCount: 0,
    paused: false,
    intervalMs: DEFAULT_MONITORING_INTERVAL_MS,
  };
}

/**
 * An in-memory substrate double that applies the granular `monitor.*` intents
 * with the same semantics as the Rust `SystemMonitorStore`, so a run of the real
 * `appStore` actions (which mirror those intents) reconstructs the region view the
 * status bar and Open Connections would render. Only `monitor.replace` (the
 * render-cut mirror) is intentionally not applied here — the mutation cut drives
 * the region through the per-transition intents.
 */
class MonitorStoreTransport implements Transport {
  dispatched: Intent[] = [];
  private monitors: Record<string, MonitoringEntry> = {};
  private statsCache: Record<string, SystemStats> = {};
  private version = 0;
  private handlers: FrameHandler[] = [];

  async dispatch(intent: Intent): Promise<IntentAck> {
    this.dispatched.push(intent);
    this.apply(intent);
    this.version += 1;
    this.fan();
    return {
      intentId: intent.intentId,
      status: "accepted",
      produced: [{ region: "system-monitors", version: this.version }],
    };
  }

  private apply(intent: Intent): void {
    const p = intent.payload as Record<string, unknown>;
    const key = p.key as string;
    switch (intent.kind) {
      case "monitor.open": {
        const host = (p.host as string | undefined) ?? null;
        const intervalMs = (p.intervalMs as number | undefined) ?? DEFAULT_MONITORING_INTERVAL_MS;
        const cached = this.statsCache[key] ?? null;
        this.monitors[key] = {
          ...emptyEntry(key, host),
          loading: true,
          status: "connecting",
          stats: cached,
          intervalMs,
        };
        break;
      }
      case "monitor.opened": {
        const e = this.monitors[key];
        if (e)
          this.monitors[key] = {
            ...e,
            monitorSessionId: key,
            loading: false,
            status: "live",
            error: null,
          };
        break;
      }
      case "monitor.openFailed": {
        const e = this.monitors[key];
        if (e)
          this.monitors[key] = {
            ...e,
            monitorSessionId: null,
            loading: false,
            status: null,
            error: (p.error as string | undefined) ?? null,
          };
        break;
      }
      case "monitor.stats": {
        const stats = p.stats as SystemStats;
        this.statsCache[key] = stats;
        const e = this.monitors[key];
        if (e) this.monitors[key] = { ...e, stats, sampleCount: e.sampleCount + 1 };
        break;
      }
      case "monitor.status": {
        const e = this.monitors[key];
        if (e) this.monitors[key] = { ...e, status: p.status as MonitorStatus };
        break;
      }
      case "monitor.setPaused": {
        const paused = p.paused as boolean;
        const e = this.monitors[key];
        if (e) this.monitors[key] = { ...e, paused, status: paused ? "paused" : "live" };
        break;
      }
      case "monitor.setInterval": {
        const e = this.monitors[key];
        if (e) this.monitors[key] = { ...e, intervalMs: p.intervalMs as number };
        break;
      }
      case "monitor.clearError": {
        const e = this.monitors[key];
        if (e) this.monitors[key] = { ...e, error: null };
        break;
      }
      case "monitor.close": {
        delete this.monitors[key];
        break;
      }
      default:
        break;
    }
  }

  /** The reconstructed region view, twin of the store snapshot. */
  regionView(): RegionView {
    return structuredClone({ monitors: this.monitors, statsCache: this.statsCache });
  }

  kinds(): string[] {
    return this.dispatched.map((i) => i.kind);
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
    return { kind: "snapshot", region, version: this.version, view: this.regionView() };
  }

  private fan(): void {
    const frame: ProjectionFrame = this.snapshot("system-monitors");
    for (const h of this.handlers) h(frame);
  }
}

let transport: MonitorStoreTransport;

/** Assert the region the intents reconstruct equals the local appStore slice. */
function expectParity() {
  const state = useAppStore.getState();
  const region = transport.regionView();
  expect(region.monitors).toEqual(state.monitors);
  expect(region.statsCache).toEqual(state.monitoringStatsCache);
}

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState());
  vi.clearAllMocks();
  statsCallbacks = [];
  statusCallbacks = [];
  transport = new MonitorStoreTransport();
  setMonitorTransportForTest(transport);
  setMonitorIntentsEnabled(true);
});

afterEach(() => {
  setMonitorTransportForTest(null);
  setMonitorIntentsEnabled(null);
});

describe("monitors mutation cut — cut-vs-local parity (flag on)", () => {
  it("connect → opened reproduces the live entry", async () => {
    mockSessionMonitoringOpen.mockResolvedValue(undefined);
    await useAppStore.getState().connectMonitoring(SESSION_A, HOST_A);

    expect(transport.kinds()).toEqual(["monitor.open", "monitor.opened"]);
    expectParity();
    expect(transport.regionView().monitors[SESSION_A].status).toBe("live");
  });

  it("a failed open reproduces the error entry", async () => {
    mockSessionMonitoringOpen.mockRejectedValue(new Error("Connection refused"));
    await useAppStore.getState().connectMonitoring(SESSION_A, HOST_A);

    expect(transport.kinds()).toEqual(["monitor.open", "monitor.openFailed"]);
    expectParity();
    const entry = transport.regionView().monitors[SESSION_A];
    expect(entry.error).toBe("Connection refused");
    expect(entry.monitorSessionId).toBeNull();
  });

  it("pushed stats fan out into the entry and the cache", async () => {
    mockSessionMonitoringOpen.mockResolvedValue(undefined);
    await useAppStore.getState().connectMonitoring(SESSION_A, HOST_A);

    pushStats(SESSION_A, { ...TEST_STATS, hostname: "s1" });
    pushStats(SESSION_A, { ...TEST_STATS, hostname: "s2" });

    expectParity();
    const view = transport.regionView();
    expect(view.monitors[SESSION_A].sampleCount).toBe(2);
    expect(view.monitors[SESSION_A].stats!.hostname).toBe("s2");
    expect(view.statsCache[SESSION_A].hostname).toBe("s2");
  });

  it("a status push flips the projected badge", async () => {
    mockSessionMonitoringOpen.mockResolvedValue(undefined);
    await useAppStore.getState().connectMonitoring(SESSION_A, HOST_A);

    pushStatus(SESSION_A, "stale");

    expectParity();
    expect(transport.regionView().monitors[SESSION_A].status).toBe("stale");
  });

  it("setMonitoringPaused mirrors the pause", async () => {
    mockSessionMonitoringOpen.mockResolvedValue(undefined);
    mockSessionMonitoringSetPaused.mockResolvedValue(undefined);
    await useAppStore.getState().connectMonitoring(SESSION_A, HOST_A);

    await useAppStore.getState().setMonitoringPaused(SESSION_A, true);
    expectParity();
    expect(transport.regionView().monitors[SESSION_A].paused).toBe(true);
    expect(transport.regionView().monitors[SESSION_A].status).toBe("paused");

    await useAppStore.getState().setMonitoringPaused(SESSION_A, false);
    expectParity();
    expect(transport.regionView().monitors[SESSION_A].paused).toBe(false);
  });

  it("a failed pause rolls back locally and re-mirrors the revert", async () => {
    mockSessionMonitoringOpen.mockResolvedValue(undefined);
    mockSessionMonitoringSetPaused.mockRejectedValue(new Error("nope"));
    await useAppStore.getState().connectMonitoring(SESSION_A, HOST_A);

    await expect(useAppStore.getState().setMonitoringPaused(SESSION_A, true)).rejects.toThrow(
      "nope"
    );

    // Local rollback: the entry is not paused (the resilience path held).
    expect(useAppStore.getState().monitors[SESSION_A].paused).toBe(false);
    // Both the optimistic pause and its revert were mirrored.
    expect(transport.kinds()).toEqual([
      "monitor.open",
      "monitor.opened",
      "monitor.setPaused",
      "monitor.setPaused",
    ]);
    expect(transport.regionView().monitors[SESSION_A].paused).toBe(false);
  });

  it("setMonitoringInterval mirrors the new cadence", async () => {
    mockSessionMonitoringOpen.mockResolvedValue(undefined);
    mockSessionMonitoringSetInterval.mockResolvedValue(undefined);
    await useAppStore.getState().connectMonitoring(SESSION_A, HOST_A);

    await useAppStore.getState().setMonitoringInterval(SESSION_A, 5000);
    expectParity();
    expect(transport.regionView().monitors[SESSION_A].intervalMs).toBe(5000);
  });

  it("clearMonitoringError mirrors the dismissal", async () => {
    mockSessionMonitoringOpen.mockRejectedValue(new Error("boom"));
    await useAppStore.getState().connectMonitoring(SESSION_A, HOST_A);
    expect(transport.regionView().monitors[SESSION_A].error).toBe("boom");

    useAppStore.getState().clearMonitoringError(SESSION_A);
    expectParity();
    expect(transport.regionView().monitors[SESSION_A].error).toBeNull();
    expect(transport.kinds()).toContain("monitor.clearError");
  });

  it("clearMonitoringError with nothing to clear dispatches nothing", async () => {
    mockSessionMonitoringOpen.mockResolvedValue(undefined);
    await useAppStore.getState().connectMonitoring(SESSION_A, HOST_A);
    const before = transport.dispatched.length;

    useAppStore.getState().clearMonitoringError(SESSION_A);
    expect(transport.dispatched.length).toBe(before);
  });

  it("disconnect drops the entry and retains the cache", async () => {
    mockSessionMonitoringOpen.mockResolvedValue(undefined);
    mockSessionMonitoringClose.mockResolvedValue(undefined);
    await useAppStore.getState().connectMonitoring(SESSION_A, HOST_A);
    pushStats(SESSION_A, TEST_STATS);

    await useAppStore.getState().disconnectMonitoring(SESSION_A);

    expectParity();
    const view = transport.regionView();
    expect(view.monitors[SESSION_A]).toBeUndefined();
    // The cache is retained for an instant reconnect (parity with the local path).
    expect(view.statsCache[SESSION_A]).toEqual(TEST_STATS);
  });

  it("cancelMonitoring tears the entry down via close", async () => {
    mockSessionMonitoringOpen.mockResolvedValue(undefined);
    mockSessionMonitoringClose.mockResolvedValue(undefined);
    mockSessionMonitoringCancel.mockResolvedValue(undefined);
    await useAppStore.getState().connectMonitoring(SESSION_A, HOST_A);

    await useAppStore.getState().cancelMonitoring(SESSION_A);

    expectParity();
    expect(transport.regionView().monitors[SESSION_A]).toBeUndefined();
    expect(transport.kinds()).toContain("monitor.close");
  });

  it("multi-monitor fan-out stays independent", async () => {
    mockSessionMonitoringOpen.mockResolvedValue(undefined);
    mockSessionMonitoringClose.mockResolvedValue(undefined);
    await useAppStore.getState().connectMonitoring(SESSION_A, HOST_A);
    await useAppStore.getState().connectMonitoring(SESSION_B, HOST_B);
    pushStats(SESSION_A, { ...TEST_STATS, hostname: "A" });
    pushStats(SESSION_B, { ...TEST_STATS, hostname: "B" });

    expectParity();

    await useAppStore.getState().disconnectMonitoring(SESSION_A);
    expectParity();
    const view = transport.regionView();
    expect(view.monitors[SESSION_A]).toBeUndefined();
    expect(view.monitors[SESSION_B].stats!.hostname).toBe("B");
  });

  it("disconnect with no key tears down every entry", async () => {
    mockSessionMonitoringOpen.mockResolvedValue(undefined);
    mockSessionMonitoringClose.mockResolvedValue(undefined);
    await useAppStore.getState().connectMonitoring(SESSION_A, HOST_A);
    await useAppStore.getState().connectMonitoring(SESSION_B, HOST_B);

    await useAppStore.getState().disconnectMonitoring();

    expectParity();
    expect(transport.regionView().monitors).toEqual({});
  });

  it("a full lifecycle stays in parity across every step", async () => {
    mockSessionMonitoringOpen.mockResolvedValue(undefined);
    mockSessionMonitoringClose.mockResolvedValue(undefined);
    mockSessionMonitoringSetPaused.mockResolvedValue(undefined);
    mockSessionMonitoringSetInterval.mockResolvedValue(undefined);

    await useAppStore.getState().connectMonitoring(SESSION_A, HOST_A);
    expectParity();
    pushStats(SESSION_A, TEST_STATS);
    expectParity();
    pushStatus(SESSION_A, "stale");
    expectParity();
    await useAppStore.getState().setMonitoringInterval(SESSION_A, 10000);
    expectParity();
    await useAppStore.getState().setMonitoringPaused(SESSION_A, true);
    expectParity();
    await useAppStore.getState().setMonitoringPaused(SESSION_A, false);
    expectParity();
    await useAppStore.getState().disconnectMonitoring(SESSION_A);
    expectParity();
  });
});

describe("monitors mutation cut — flag off (rollback path)", () => {
  beforeEach(() => setMonitorIntentsEnabled(false));

  it("dispatches no intents and drives the slice locally", async () => {
    mockSessionMonitoringOpen.mockResolvedValue(undefined);
    mockSessionMonitoringClose.mockResolvedValue(undefined);
    mockSessionMonitoringSetPaused.mockResolvedValue(undefined);

    await useAppStore.getState().connectMonitoring(SESSION_A, HOST_A);
    pushStats(SESSION_A, TEST_STATS);
    await useAppStore.getState().setMonitoringPaused(SESSION_A, true);
    await useAppStore.getState().disconnectMonitoring(SESSION_A);

    // No mirror reached the region — the pre-cut local path is intact.
    expect(transport.dispatched).toHaveLength(0);
    // The local slice still behaves exactly as before the cut.
    expect(useAppStore.getState().monitors[SESSION_A]).toBeUndefined();
    expect(useAppStore.getState().monitoringStatsCache[SESSION_A]).toEqual(TEST_STATS);
  });
});
