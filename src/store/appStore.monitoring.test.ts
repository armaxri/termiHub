import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock service modules before importing the store
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

// After retiring the legacy pull path (#1232), every monitor — desktop-direct
// SSH and remote-session alike — routes through the unified session-based
// `MonitoringProvider` push path: `session_monitoring_open(sessionId)` plus the
// `session-monitoring-stats` / `session-monitoring-status` event streams. There
// is no `monitoring_open` / `monitoring_fetch_stats` / `monitoring_close`
// anymore, so the api mock only exposes the session commands.
const mockSessionMonitoringOpen = vi.fn();
const mockSessionMonitoringClose = vi.fn();

vi.mock("@/services/api", () => ({
  sftpOpen: vi.fn(),
  sftpClose: vi.fn(),
  sftpListDir: vi.fn(),
  localListDir: vi.fn(),
  vscodeAvailable: vi.fn(() => Promise.resolve(false)),
  sessionMonitoringOpen: (...args: unknown[]) => mockSessionMonitoringOpen(...args),
  sessionMonitoringClose: (...args: unknown[]) => mockSessionMonitoringClose(...args),
}));

// Session-based monitoring subscribes to Tauri events and stores the returned
// unlisten fns. Each connect registers its own stats+status callbacks that
// filter by sessionId. The mocks below capture every registered callback so a
// test can fan a push event out to all of them (mirroring the real event bus,
// where every listener receives every event and filters by sessionId).
type StatsCallback = (sessionId: string, stats: SystemStats) => void;
type StatusCallback = (sessionId: string, status: MonitorStatus) => void;
let statsCallbacks: StatsCallback[] = [];
let statusCallbacks: StatusCallback[] = [];
const mockStatsUnlisten = vi.fn();
const mockStatusUnlisten = vi.fn();
const mockOnSessionMonitoringStats = vi.fn((cb: StatsCallback) => {
  statsCallbacks.push(cb);
  return Promise.resolve(mockStatsUnlisten);
});
const mockOnSessionMonitoringStatus = vi.fn((cb: StatusCallback) => {
  statusCallbacks.push(cb);
  return Promise.resolve(mockStatusUnlisten);
});

/** Fan a stats push out to every registered listener (they filter by sessionId). */
function pushStats(sessionId: string, stats: SystemStats) {
  statsCallbacks.forEach((cb) => cb(sessionId, stats));
}
/** Fan a status push out to every registered listener (they filter by sessionId). */
function pushStatus(sessionId: string, status: MonitorStatus) {
  statusCallbacks.forEach((cb) => cb(sessionId, status));
}

vi.mock("@/services/events", () => ({
  onSessionMonitoringStats: (cb: StatsCallback) => mockOnSessionMonitoringStats(cb),
  onSessionMonitoringStatus: (cb: StatusCallback) => mockOnSessionMonitoringStatus(cb),
  onPersistentSessionStateChanged: vi.fn(() => Promise.resolve(() => {})),
}));

import { useAppStore, selectMonitor, selectActiveMonitor, monitorKeyForTab } from "./appStore";
import type { MonitorStatus, SystemStats } from "@/types/monitoring";
import type { LeafPanel, TerminalTab } from "@/types/terminal";

// Desktop-direct SSH is now keyed by the SSH terminal session id (the session
// that owns the monitor), exactly like remote-session tabs.
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

/** Makes a desktop-direct SSH tab (with a session) the active tab. */
function setActiveSshTab(sessionId: string, host: string, port: number, username: string) {
  const tab: TerminalTab = {
    id: "tab-active",
    sessionId,
    title: "ssh",
    connectionType: "ssh",
    contentType: "terminal",
    config: { type: "ssh", config: { host, port, username } },
    panelId: "leaf-1",
    isActive: true,
  };
  const leaf: LeafPanel = { type: "leaf", id: "leaf-1", tabs: [tab], activeTabId: "tab-active" };
  useAppStore.setState({ rootPanel: leaf, activePanelId: "leaf-1" });
}

describe("appStore — monitoring (unified session-based push path, #1232)", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    vi.clearAllMocks();
    statsCallbacks = [];
    statusCallbacks = [];
  });

  describe("connectMonitoring — desktop-direct SSH routes through the MonitoringProvider", () => {
    it("subscribes to the session push path (no legacy pull) keyed by sessionId", async () => {
      mockSessionMonitoringOpen.mockResolvedValue(undefined);

      await useAppStore.getState().connectMonitoring(SESSION_A, HOST_A);

      // The desktop-direct SSH monitor is keyed by the SSH terminal session id.
      const entry = selectMonitor(useAppStore.getState(), SESSION_A);
      expect(entry).not.toBeNull();
      expect(entry!.monitorSessionId).toBe(SESSION_A);
      expect(entry!.host).toBe(HOST_A);
      expect(entry!.loading).toBe(false);
      expect(entry!.status).toBe("live");
      // It went through the provider push path…
      expect(mockSessionMonitoringOpen).toHaveBeenCalledWith(SESSION_A);
      expect(mockOnSessionMonitoringStats).toHaveBeenCalledTimes(1);
      expect(mockOnSessionMonitoringStatus).toHaveBeenCalledTimes(1);
    });

    it("folds pushed stats into the entry keyed by sessionId", async () => {
      mockSessionMonitoringOpen.mockResolvedValue(undefined);
      await useAppStore.getState().connectMonitoring(SESSION_A, HOST_A);

      pushStats(SESSION_A, { ...TEST_STATS, hostname: "pushed" });

      const entry = selectMonitor(useAppStore.getState(), SESSION_A)!;
      expect(entry.stats!.hostname).toBe("pushed");
      expect(entry.sampleCount).toBe(1);
    });

    it("marks the entry loading while the open is in flight", async () => {
      let resolveOpen: () => void;
      mockSessionMonitoringOpen.mockReturnValue(
        new Promise<void>((r) => {
          resolveOpen = r;
        })
      );

      const promise = useAppStore.getState().connectMonitoring(SESSION_A, HOST_A);
      expect(selectMonitor(useAppStore.getState(), SESSION_A)!.loading).toBe(true);

      resolveOpen!();
      await promise;
      expect(selectMonitor(useAppStore.getState(), SESSION_A)!.loading).toBe(false);
    });

    it("sets the error on the entry (no throw) when the open fails and unlistens (no leak)", async () => {
      mockSessionMonitoringOpen.mockRejectedValue(new Error("Connection refused"));

      await useAppStore.getState().connectMonitoring(SESSION_A, HOST_A);

      // The stats+status listeners attached before the failing open are detached.
      expect(mockStatsUnlisten).toHaveBeenCalledTimes(1);
      expect(mockStatusUnlisten).toHaveBeenCalledTimes(1);

      const entry = selectMonitor(useAppStore.getState(), SESSION_A)!;
      expect(entry.monitorSessionId).toBeNull();
      expect(entry.loading).toBe(false);
      expect(entry.error).toBe("Connection refused");
    });
  });

  describe("multi-host — two entries coexist (G6)", () => {
    it("keeps both sessions as independent entries (no clobber)", async () => {
      mockSessionMonitoringOpen.mockResolvedValue(undefined);

      await useAppStore.getState().connectMonitoring(SESSION_A, HOST_A);
      await useAppStore.getState().connectMonitoring(SESSION_B, HOST_B);

      pushStats(SESSION_A, { ...TEST_STATS, hostname: "A" });
      pushStats(SESSION_B, { ...TEST_STATS, hostname: "B" });

      const state = useAppStore.getState();
      expect(Object.keys(state.monitors).sort()).toEqual([SESSION_A, SESSION_B].sort());
      expect(selectMonitor(state, SESSION_A)!.stats!.hostname).toBe("A");
      expect(selectMonitor(state, SESSION_B)!.stats!.hostname).toBe("B");
    });

    it("disconnecting one session leaves the other intact", async () => {
      mockSessionMonitoringOpen.mockResolvedValue(undefined);
      mockSessionMonitoringClose.mockResolvedValue(undefined);

      await useAppStore.getState().connectMonitoring(SESSION_A, HOST_A);
      await useAppStore.getState().connectMonitoring(SESSION_B, HOST_B);

      await useAppStore.getState().disconnectMonitoring(SESSION_A);

      const state = useAppStore.getState();
      expect(selectMonitor(state, SESSION_A)).toBeNull();
      expect(selectMonitor(state, SESSION_B)).not.toBeNull();
      // Only session A's backend monitor was closed.
      expect(mockSessionMonitoringClose).toHaveBeenCalledTimes(1);
      expect(mockSessionMonitoringClose).toHaveBeenCalledWith(SESSION_A);
    });

    it("disconnectMonitoring() with no key tears down every entry", async () => {
      mockSessionMonitoringOpen.mockResolvedValue(undefined);
      mockSessionMonitoringClose.mockResolvedValue(undefined);

      await useAppStore.getState().connectMonitoring(SESSION_A, HOST_A);
      await useAppStore.getState().connectMonitoring(SESSION_B, HOST_B);

      await useAppStore.getState().disconnectMonitoring();

      expect(useAppStore.getState().monitors).toEqual({});
      expect(mockSessionMonitoringClose).toHaveBeenCalledTimes(2);
    });
  });

  describe("push event routing", () => {
    it("routes stats push events to the matching entry only", async () => {
      mockSessionMonitoringOpen.mockResolvedValue(undefined);
      await useAppStore.getState().connectMonitoring(SESSION_A, HOST_A);
      await useAppStore.getState().connectMonitoring(SESSION_B, HOST_B);

      pushStats(SESSION_A, { ...TEST_STATS, hostname: "A-updated" });

      expect(selectMonitor(useAppStore.getState(), SESSION_A)!.stats!.hostname).toBe("A-updated");
      // SESSION_B never received a push → still no stats.
      expect(selectMonitor(useAppStore.getState(), SESSION_B)!.stats).toBeNull();
    });

    it("routes status push events to the matching entry only", async () => {
      mockSessionMonitoringOpen.mockResolvedValue(undefined);
      await useAppStore.getState().connectMonitoring(SESSION_A, HOST_A);
      await useAppStore.getState().connectMonitoring(SESSION_B, HOST_B);

      pushStatus(SESSION_A, "stale");

      expect(selectMonitor(useAppStore.getState(), SESSION_A)!.status).toBe("stale");
      // SESSION_B is untouched.
      expect(selectMonitor(useAppStore.getState(), SESSION_B)!.status).toBe("live");
    });
  });

  describe("selectActiveMonitor / monitorKeyForTab", () => {
    it("monitorKeyForTab keys desktop-direct SSH tabs by their session id", () => {
      const tab = {
        connectionType: "ssh",
        sessionId: "term-sess-a",
        config: { type: "ssh", config: { host: "pi.local", port: 22, username: "pi" } },
      } as unknown as TerminalTab;
      expect(monitorKeyForTab(tab)).toBe("term-sess-a");
    });

    it("monitorKeyForTab keys remote-session tabs by their session id", () => {
      const tab = {
        connectionType: "remote-session",
        sessionId: "sess-xyz",
        config: { type: "remote-session", config: {} },
      } as unknown as TerminalTab;
      expect(monitorKeyForTab(tab)).toBe("sess-xyz");
    });

    it("returns null when the tab has no session id", () => {
      const tab = {
        connectionType: "ssh",
        sessionId: null,
        config: { type: "ssh", config: { host: "pi.local", port: 22, username: "pi" } },
      } as unknown as TerminalTab;
      expect(monitorKeyForTab(tab)).toBeNull();
    });

    it("returns the active tab's entry", async () => {
      mockSessionMonitoringOpen.mockResolvedValue(undefined);
      await useAppStore.getState().connectMonitoring(SESSION_A, HOST_A);
      await useAppStore.getState().connectMonitoring(SESSION_B, HOST_B);
      pushStats(SESSION_B, { ...TEST_STATS, hostname: "B" });

      setActiveSshTab(SESSION_B, "server.local", 2222, "admin");
      const active = selectActiveMonitor(useAppStore.getState());
      expect(active).not.toBeNull();
      expect(active!.key).toBe(SESSION_B);
      expect(active!.stats!.hostname).toBe("B");
    });

    it("returns null when the active tab has no monitor", () => {
      setActiveSshTab("no-monitor-sess", "nowhere.local", 22, "nobody");
      expect(selectActiveMonitor(useAppStore.getState())).toBeNull();
    });
  });

  describe("stats cache (folded, keyed by MonitorKey)", () => {
    it("connect pre-populates the entry stats from cache while loading", async () => {
      let resolveOpen: () => void;
      mockSessionMonitoringOpen.mockReturnValue(
        new Promise<void>((r) => {
          resolveOpen = r;
        })
      );
      useAppStore.setState({ monitoringStatsCache: { [SESSION_A]: TEST_STATS } });

      const promise = useAppStore.getState().connectMonitoring(SESSION_A, HOST_A);
      const loadingEntry = selectMonitor(useAppStore.getState(), SESSION_A)!;
      expect(loadingEntry.loading).toBe(true);
      expect(loadingEntry.stats).toEqual(TEST_STATS);

      resolveOpen!();
      await promise;
    });

    it("disconnect saves the entry's last stats back to the cache", async () => {
      mockSessionMonitoringOpen.mockResolvedValue(undefined);
      mockSessionMonitoringClose.mockResolvedValue(undefined);
      await useAppStore.getState().connectMonitoring(SESSION_A, HOST_A);
      pushStats(SESSION_A, TEST_STATS);

      await useAppStore.getState().disconnectMonitoring(SESSION_A);

      expect(useAppStore.getState().monitoringStatsCache[SESSION_A]).toEqual(TEST_STATS);
    });
  });

  describe("sampleCount priming (per entry, G10)", () => {
    it("counts each pushed sample", async () => {
      mockSessionMonitoringOpen.mockResolvedValue(undefined);
      await useAppStore.getState().connectMonitoring(SESSION_A, HOST_A);
      expect(selectMonitor(useAppStore.getState(), SESSION_A)!.sampleCount).toBe(0);

      pushStats(SESSION_A, TEST_STATS);
      expect(selectMonitor(useAppStore.getState(), SESSION_A)!.sampleCount).toBe(1);
      pushStats(SESSION_A, TEST_STATS);
      expect(selectMonitor(useAppStore.getState(), SESSION_A)!.sampleCount).toBe(2);
    });
  });

  describe("clearMonitoringError(key) (G9)", () => {
    it("clears a lingering error on a specific entry", async () => {
      mockSessionMonitoringOpen.mockRejectedValue(new Error("boom"));
      await useAppStore.getState().connectMonitoring(SESSION_A, HOST_A);
      expect(selectMonitor(useAppStore.getState(), SESSION_A)!.error).toBe("boom");

      useAppStore.getState().clearMonitoringError(SESSION_A);
      expect(selectMonitor(useAppStore.getState(), SESSION_A)!.error).toBeNull();
    });
  });
});
