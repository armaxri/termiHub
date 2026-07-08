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

const mockMonitoringOpen = vi.fn();
const mockMonitoringClose = vi.fn();
const mockMonitoringFetchStats = vi.fn();
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
  monitoringOpen: (...args: unknown[]) => mockMonitoringOpen(...args),
  monitoringClose: (...args: unknown[]) => mockMonitoringClose(...args),
  monitoringFetchStats: (...args: unknown[]) => mockMonitoringFetchStats(...args),
  sessionMonitoringOpen: (...args: unknown[]) => mockSessionMonitoringOpen(...args),
  sessionMonitoringClose: (...args: unknown[]) => mockSessionMonitoringClose(...args),
  sessionMonitoringSetPaused: (...args: unknown[]) => mockSessionMonitoringSetPaused(...args),
  sessionMonitoringSetInterval: (...args: unknown[]) => mockSessionMonitoringSetInterval(...args),
  sessionMonitoringCancel: (...args: unknown[]) => mockSessionMonitoringCancel(...args),
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

const HOST_A_CONFIG = {
  host: "pi.local",
  port: 22,
  username: "pi",
  authMethod: "key" as const,
  keyPath: "/home/.ssh/id_rsa",
};
const HOST_A_KEY = "pi@pi.local:22";

const HOST_B_CONFIG = {
  host: "server.local",
  port: 2222,
  username: "admin",
  authMethod: "key" as const,
  keyPath: "/home/.ssh/id_rsa",
};
const HOST_B_KEY = "admin@server.local:2222";

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

/** Makes the given monitor key the active tab by installing a matching SSH tab. */
function setActiveSshTab(host: string, port: number, username: string) {
  const tab: TerminalTab = {
    id: "tab-active",
    sessionId: "term-sess",
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

describe("appStore — monitoring (per-host keyed slice, G6)", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    vi.clearAllMocks();
    statsCallbacks = [];
    statusCallbacks = [];
  });

  describe("connectMonitoring — SSH", () => {
    it("creates a keyed entry with session, host, and stats on success", async () => {
      mockMonitoringOpen.mockResolvedValue("session-123");
      mockMonitoringFetchStats.mockResolvedValue(TEST_STATS);

      await useAppStore.getState().connectMonitoring(HOST_A_CONFIG);

      const entry = selectMonitor(useAppStore.getState(), HOST_A_KEY);
      expect(entry).not.toBeNull();
      expect(entry!.monitorSessionId).toBe("session-123");
      expect(entry!.host).toBe(HOST_A_KEY);
      expect(entry!.sessionBased).toBe(false);
      expect(entry!.stats).toEqual(TEST_STATS);
      expect(entry!.loading).toBe(false);
      expect(entry!.error).toBeNull();
      expect(entry!.status).toBe("live");
    });

    it("sets error on the entry without throwing on connection failure", async () => {
      mockMonitoringOpen.mockRejectedValue(new Error("Connection refused"));

      await useAppStore.getState().connectMonitoring(HOST_A_CONFIG);

      const entry = selectMonitor(useAppStore.getState(), HOST_A_KEY);
      expect(entry!.monitorSessionId).toBeNull();
      expect(entry!.loading).toBe(false);
      expect(entry!.error).toBe("Connection refused");
    });

    it("sets error on stats fetch failure", async () => {
      mockMonitoringOpen.mockResolvedValue("session-123");
      mockMonitoringFetchStats.mockRejectedValue(new Error("Stats timeout"));

      await useAppStore.getState().connectMonitoring(HOST_A_CONFIG);

      const entry = selectMonitor(useAppStore.getState(), HOST_A_KEY);
      expect(entry!.monitorSessionId).toBeNull();
      expect(entry!.loading).toBe(false);
      expect(entry!.error).toBe("Stats timeout");
    });

    it("marks the entry loading while connecting", async () => {
      let resolveOpen: (v: string) => void;
      mockMonitoringOpen.mockReturnValue(
        new Promise<string>((r) => {
          resolveOpen = r;
        })
      );
      mockMonitoringFetchStats.mockResolvedValue(TEST_STATS);

      const promise = useAppStore.getState().connectMonitoring(HOST_A_CONFIG);
      expect(selectMonitor(useAppStore.getState(), HOST_A_KEY)!.loading).toBe(true);

      resolveOpen!("session-123");
      await promise;
      expect(selectMonitor(useAppStore.getState(), HOST_A_KEY)!.loading).toBe(false);
    });
  });

  describe("multi-host — two entries coexist (G6)", () => {
    it("keeps both hosts as independent entries (no clobber)", async () => {
      mockMonitoringOpen.mockResolvedValueOnce("session-A").mockResolvedValueOnce("session-B");
      mockMonitoringFetchStats
        .mockResolvedValueOnce({ ...TEST_STATS, hostname: "A" })
        .mockResolvedValueOnce({ ...TEST_STATS, hostname: "B" });

      await useAppStore.getState().connectMonitoring(HOST_A_CONFIG);
      await useAppStore.getState().connectMonitoring(HOST_B_CONFIG);

      const state = useAppStore.getState();
      expect(Object.keys(state.monitors).sort()).toEqual([HOST_B_KEY, HOST_A_KEY].sort());
      expect(selectMonitor(state, HOST_A_KEY)!.monitorSessionId).toBe("session-A");
      expect(selectMonitor(state, HOST_A_KEY)!.stats!.hostname).toBe("A");
      expect(selectMonitor(state, HOST_B_KEY)!.monitorSessionId).toBe("session-B");
      expect(selectMonitor(state, HOST_B_KEY)!.stats!.hostname).toBe("B");
    });

    it("disconnecting one host leaves the other intact", async () => {
      mockMonitoringOpen.mockResolvedValueOnce("session-A").mockResolvedValueOnce("session-B");
      mockMonitoringFetchStats.mockResolvedValue(TEST_STATS);
      mockMonitoringClose.mockResolvedValue(undefined);

      await useAppStore.getState().connectMonitoring(HOST_A_CONFIG);
      await useAppStore.getState().connectMonitoring(HOST_B_CONFIG);

      await useAppStore.getState().disconnectMonitoring(HOST_A_KEY);

      const state = useAppStore.getState();
      expect(selectMonitor(state, HOST_A_KEY)).toBeNull();
      expect(selectMonitor(state, HOST_B_KEY)).not.toBeNull();
      expect(selectMonitor(state, HOST_B_KEY)!.monitorSessionId).toBe("session-B");
      // Only host A's backend session was closed.
      expect(mockMonitoringClose).toHaveBeenCalledTimes(1);
      expect(mockMonitoringClose).toHaveBeenCalledWith("session-A");
    });

    it("disconnectMonitoring() with no key tears down every entry", async () => {
      mockMonitoringOpen.mockResolvedValueOnce("session-A").mockResolvedValueOnce("session-B");
      mockMonitoringFetchStats.mockResolvedValue(TEST_STATS);
      mockMonitoringClose.mockResolvedValue(undefined);

      await useAppStore.getState().connectMonitoring(HOST_A_CONFIG);
      await useAppStore.getState().connectMonitoring(HOST_B_CONFIG);

      await useAppStore.getState().disconnectMonitoring();

      expect(useAppStore.getState().monitors).toEqual({});
      expect(mockMonitoringClose).toHaveBeenCalledTimes(2);
    });
  });

  describe("connectMonitoring — session-based (push)", () => {
    it("creates a session-keyed entry on successful open", async () => {
      mockSessionMonitoringOpen.mockResolvedValue(undefined);

      await useAppStore
        .getState()
        .connectMonitoring({ _sessionBased: true, _sessionId: "sess-abc" });

      const entry = selectMonitor(useAppStore.getState(), "sess-abc");
      expect(entry).not.toBeNull();
      expect(entry!.sessionBased).toBe(true);
      expect(entry!.monitorSessionId).toBe("sess-abc");
      expect(entry!.host).toBe("sess-abc");
      expect(entry!.loading).toBe(false);
      expect(entry!.status).toBe("live");
      expect(mockOnSessionMonitoringStats).toHaveBeenCalledTimes(1);
    });

    it("unlistens the stats listener when session_monitoring_open fails (no leak)", async () => {
      mockSessionMonitoringOpen.mockRejectedValue(new Error("open refused"));

      await useAppStore
        .getState()
        .connectMonitoring({ _sessionBased: true, _sessionId: "sess-abc" });

      expect(mockOnSessionMonitoringStats).toHaveBeenCalledTimes(1);
      expect(mockStatsUnlisten).toHaveBeenCalledTimes(1);

      const entry = selectMonitor(useAppStore.getState(), "sess-abc");
      expect(entry!.monitorSessionId).toBeNull();
      expect(entry!.loading).toBe(false);
      expect(entry!.error).toBe("open refused");
    });

    it("routes stats push events to the matching entry only", async () => {
      mockSessionMonitoringOpen.mockResolvedValue(undefined);
      await useAppStore.getState().connectMonitoring({ _sessionBased: true, _sessionId: "sess-a" });
      await useAppStore.getState().connectMonitoring({ _sessionBased: true, _sessionId: "sess-b" });

      pushStats("sess-a", { ...TEST_STATS, hostname: "A-updated" });

      expect(selectMonitor(useAppStore.getState(), "sess-a")!.stats!.hostname).toBe("A-updated");
      // sess-b never received a push → still no stats.
      expect(selectMonitor(useAppStore.getState(), "sess-b")!.stats).toBeNull();
    });

    it("routes status push events to the matching entry only", async () => {
      mockSessionMonitoringOpen.mockResolvedValue(undefined);
      await useAppStore.getState().connectMonitoring({ _sessionBased: true, _sessionId: "sess-a" });
      await useAppStore.getState().connectMonitoring({ _sessionBased: true, _sessionId: "sess-b" });

      pushStatus("sess-a", "stale");

      expect(selectMonitor(useAppStore.getState(), "sess-a")!.status).toBe("stale");
      // sess-b is untouched.
      expect(selectMonitor(useAppStore.getState(), "sess-b")!.status).toBe("live");
    });
  });

  describe("selectActiveMonitor / monitorKeyForTab", () => {
    it("monitorKeyForTab derives the SSH host key", () => {
      const tab = {
        connectionType: "ssh",
        sessionId: "s",
        config: { type: "ssh", config: { host: "pi.local", port: 22, username: "pi" } },
      } as unknown as TerminalTab;
      expect(monitorKeyForTab(tab)).toBe(HOST_A_KEY);
    });

    it("monitorKeyForTab uses sessionId for remote-session tabs", () => {
      const tab = {
        connectionType: "remote-session",
        sessionId: "sess-xyz",
        config: { type: "remote-session", config: {} },
      } as unknown as TerminalTab;
      expect(monitorKeyForTab(tab)).toBe("sess-xyz");
    });

    it("returns the active tab's entry", async () => {
      mockMonitoringOpen.mockResolvedValueOnce("session-A").mockResolvedValueOnce("session-B");
      mockMonitoringFetchStats
        .mockResolvedValueOnce({ ...TEST_STATS, hostname: "A" })
        .mockResolvedValueOnce({ ...TEST_STATS, hostname: "B" });
      await useAppStore.getState().connectMonitoring(HOST_A_CONFIG);
      await useAppStore.getState().connectMonitoring(HOST_B_CONFIG);

      setActiveSshTab("server.local", 2222, "admin");
      const active = selectActiveMonitor(useAppStore.getState());
      expect(active).not.toBeNull();
      expect(active!.key).toBe(HOST_B_KEY);
      expect(active!.stats!.hostname).toBe("B");
    });

    it("returns null when the active tab has no monitor", () => {
      setActiveSshTab("nowhere.local", 22, "nobody");
      expect(selectActiveMonitor(useAppStore.getState())).toBeNull();
    });
  });

  describe("refreshMonitoring(key)", () => {
    it("does NOT toggle the entry's loading flag", async () => {
      mockMonitoringOpen.mockResolvedValue("session-123");
      mockMonitoringFetchStats.mockResolvedValue(TEST_STATS);
      await useAppStore.getState().connectMonitoring(HOST_A_CONFIG);

      const loadingStates: boolean[] = [];
      const unsub = useAppStore.subscribe((state) => {
        const e = state.monitors[HOST_A_KEY];
        if (e) loadingStates.push(e.loading);
      });

      await useAppStore.getState().refreshMonitoring(HOST_A_KEY);
      unsub();
      expect(loadingStates.every((v) => v === false)).toBe(true);
    });

    it("updates stats and recovers status to live on success", async () => {
      mockMonitoringOpen.mockResolvedValue("session-123");
      mockMonitoringFetchStats.mockResolvedValue(TEST_STATS);
      await useAppStore.getState().connectMonitoring(HOST_A_CONFIG);
      useAppStore.setState((s) => ({
        monitors: { ...s.monitors, [HOST_A_KEY]: { ...s.monitors[HOST_A_KEY], status: "stale" } },
      }));

      const updated = { ...TEST_STATS, cpuUsagePercent: 75 };
      mockMonitoringFetchStats.mockResolvedValue(updated);
      await useAppStore.getState().refreshMonitoring(HOST_A_KEY);

      const entry = selectMonitor(useAppStore.getState(), HOST_A_KEY)!;
      expect(entry.stats).toEqual(updated);
      expect(entry.status).toBe("live");
      expect(entry.error).toBeNull();
    });

    it("flips the entry to stale on a failed poll", async () => {
      mockMonitoringOpen.mockResolvedValue("session-123");
      mockMonitoringFetchStats.mockResolvedValue(TEST_STATS);
      await useAppStore.getState().connectMonitoring(HOST_A_CONFIG);

      mockMonitoringFetchStats.mockRejectedValue(new Error("timeout"));
      await useAppStore.getState().refreshMonitoring(HOST_A_KEY);

      const entry = selectMonitor(useAppStore.getState(), HOST_A_KEY)!;
      expect(entry.status).toBe("stale");
      expect(entry.error).toBe("timeout");
    });

    it("no-ops for an unknown key", async () => {
      await useAppStore.getState().refreshMonitoring("no-such-key");
      expect(mockMonitoringFetchStats).not.toHaveBeenCalled();
    });
  });

  describe("stats cache (folded, keyed by MonitorKey)", () => {
    it("connect pre-populates the entry stats from cache while loading", async () => {
      mockMonitoringOpen.mockResolvedValue("session-456");
      mockMonitoringFetchStats.mockResolvedValue(TEST_STATS);
      useAppStore.setState({ monitoringStatsCache: { [HOST_A_KEY]: TEST_STATS } });

      let capturedStats: SystemStats | null = null;
      const unsub = useAppStore.subscribe((state) => {
        const e = state.monitors[HOST_A_KEY];
        if (e && e.loading && e.stats !== null) capturedStats = e.stats;
      });

      await useAppStore.getState().connectMonitoring(HOST_A_CONFIG);
      unsub();
      expect(capturedStats).toEqual(TEST_STATS);
    });

    it("disconnect saves the entry's last stats back to the cache", async () => {
      mockMonitoringOpen.mockResolvedValue("session-123");
      mockMonitoringFetchStats.mockResolvedValue(TEST_STATS);
      mockMonitoringClose.mockResolvedValue(undefined);
      await useAppStore.getState().connectMonitoring(HOST_A_CONFIG);

      await useAppStore.getState().disconnectMonitoring(HOST_A_KEY);

      expect(useAppStore.getState().monitoringStatsCache[HOST_A_KEY]).toEqual(TEST_STATS);
    });
  });

  describe("sampleCount priming (per entry, G10)", () => {
    it("is 1 after the first SSH connect fetch", async () => {
      mockMonitoringOpen.mockResolvedValue("session-123");
      mockMonitoringFetchStats.mockResolvedValue(TEST_STATS);
      await useAppStore.getState().connectMonitoring(HOST_A_CONFIG);
      expect(selectMonitor(useAppStore.getState(), HOST_A_KEY)!.sampleCount).toBe(1);
    });

    it("increments to 2 after a refresh", async () => {
      mockMonitoringOpen.mockResolvedValue("session-123");
      mockMonitoringFetchStats.mockResolvedValue(TEST_STATS);
      await useAppStore.getState().connectMonitoring(HOST_A_CONFIG);
      await useAppStore.getState().refreshMonitoring(HOST_A_KEY);
      expect(selectMonitor(useAppStore.getState(), HOST_A_KEY)!.sampleCount).toBe(2);
    });
  });

  describe("clearMonitoringError(key) / setMonitoringCancelled(key) (G8/G9)", () => {
    it("clears a lingering error on a specific entry", async () => {
      mockMonitoringOpen.mockRejectedValue(new Error("boom"));
      await useAppStore.getState().connectMonitoring(HOST_A_CONFIG);
      expect(selectMonitor(useAppStore.getState(), HOST_A_KEY)!.error).toBe("boom");

      useAppStore.getState().clearMonitoringError(HOST_A_KEY);
      expect(selectMonitor(useAppStore.getState(), HOST_A_KEY)!.error).toBeNull();
    });

    it("setMonitoringCancelled toggles the flag on a keyed entry", () => {
      useAppStore.getState().setMonitoringCancelled(HOST_A_KEY, true);
      expect(selectMonitor(useAppStore.getState(), HOST_A_KEY)!.cancelled).toBe(true);

      useAppStore.getState().setMonitoringCancelled(HOST_A_KEY, false);
      expect(selectMonitor(useAppStore.getState(), HOST_A_KEY)!.cancelled).toBe(false);
    });
  });

  // ── Controls: Pause / Resume, Interval, Cancel (#1233) ───────────────
  describe("setMonitoringPaused(key) (#1233)", () => {
    it("pauses an SSH monitor locally without a backend call", async () => {
      mockMonitoringOpen.mockResolvedValue("session-123");
      mockMonitoringFetchStats.mockResolvedValue(TEST_STATS);
      await useAppStore.getState().connectMonitoring(HOST_A_CONFIG);

      await useAppStore.getState().setMonitoringPaused(HOST_A_KEY, true);

      const entry = selectMonitor(useAppStore.getState(), HOST_A_KEY)!;
      expect(entry.paused).toBe(true);
      expect(entry.status).toBe("paused");
      // SSH monitors are frontend-polled: no backend pause RPC.
      expect(mockSessionMonitoringSetPaused).not.toHaveBeenCalled();
    });

    it("resume flips paused back to false and status to live", async () => {
      mockMonitoringOpen.mockResolvedValue("session-123");
      mockMonitoringFetchStats.mockResolvedValue(TEST_STATS);
      await useAppStore.getState().connectMonitoring(HOST_A_CONFIG);

      await useAppStore.getState().setMonitoringPaused(HOST_A_KEY, true);
      await useAppStore.getState().setMonitoringPaused(HOST_A_KEY, false);

      const entry = selectMonitor(useAppStore.getState(), HOST_A_KEY)!;
      expect(entry.paused).toBe(false);
      expect(entry.status).toBe("live");
    });

    it("signals the backend for a session monitor", async () => {
      mockSessionMonitoringOpen.mockResolvedValue(undefined);
      mockSessionMonitoringSetPaused.mockResolvedValue(undefined);
      await useAppStore.getState().connectMonitoring({ _sessionBased: true, _sessionId: "sess-p" });

      await useAppStore.getState().setMonitoringPaused("sess-p", true);

      expect(mockSessionMonitoringSetPaused).toHaveBeenCalledWith("sess-p", true);
      expect(selectMonitor(useAppStore.getState(), "sess-p")!.paused).toBe(true);
    });

    it("rolls back the optimistic flag when the backend pause fails", async () => {
      mockSessionMonitoringOpen.mockResolvedValue(undefined);
      mockSessionMonitoringSetPaused.mockRejectedValue(new Error("no session"));
      await useAppStore.getState().connectMonitoring({ _sessionBased: true, _sessionId: "sess-p" });

      await expect(useAppStore.getState().setMonitoringPaused("sess-p", true)).rejects.toThrow(
        "no session"
      );
      expect(selectMonitor(useAppStore.getState(), "sess-p")!.paused).toBe(false);
    });
  });

  describe("refreshMonitoring skips paused SSH monitors (#1233)", () => {
    it("does not fetch stats while paused", async () => {
      mockMonitoringOpen.mockResolvedValue("session-123");
      mockMonitoringFetchStats.mockResolvedValue(TEST_STATS);
      await useAppStore.getState().connectMonitoring(HOST_A_CONFIG);
      await useAppStore.getState().setMonitoringPaused(HOST_A_KEY, true);

      mockMonitoringFetchStats.mockClear();
      await useAppStore.getState().refreshMonitoring(HOST_A_KEY);

      expect(mockMonitoringFetchStats).not.toHaveBeenCalled();
    });
  });

  describe("setMonitoringInterval(key) (#1233)", () => {
    it("updates the entry interval for an SSH monitor without a backend call", async () => {
      mockMonitoringOpen.mockResolvedValue("session-123");
      mockMonitoringFetchStats.mockResolvedValue(TEST_STATS);
      await useAppStore.getState().connectMonitoring(HOST_A_CONFIG);

      await useAppStore.getState().setMonitoringInterval(HOST_A_KEY, 5000);

      expect(selectMonitor(useAppStore.getState(), HOST_A_KEY)!.intervalMs).toBe(5000);
      expect(mockSessionMonitoringSetInterval).not.toHaveBeenCalled();
    });

    it("reconfigures the backend loop for a session monitor", async () => {
      mockSessionMonitoringOpen.mockResolvedValue(undefined);
      mockSessionMonitoringSetInterval.mockResolvedValue(undefined);
      await useAppStore.getState().connectMonitoring({ _sessionBased: true, _sessionId: "sess-i" });

      await useAppStore.getState().setMonitoringInterval("sess-i", 10000);

      expect(mockSessionMonitoringSetInterval).toHaveBeenCalledWith("sess-i", 10000);
      expect(selectMonitor(useAppStore.getState(), "sess-i")!.intervalMs).toBe(10000);
    });

    it("carries a chosen interval into session_monitoring_open on connect", async () => {
      mockSessionMonitoringOpen.mockResolvedValue(undefined);
      // Seed an interval on a placeholder entry, then connect that key.
      useAppStore.getState().setMonitoringCancelled("sess-i", false);
      await useAppStore.getState().setMonitoringInterval("sess-i", 5000);
      await useAppStore.getState().connectMonitoring({ _sessionBased: true, _sessionId: "sess-i" });

      expect(mockSessionMonitoringOpen).toHaveBeenCalledWith("sess-i", 5000);
    });
  });

  describe("cancelMonitoring(key) (#1233)", () => {
    it("aborts the backend connect and tears the session entry down", async () => {
      mockSessionMonitoringOpen.mockResolvedValue(undefined);
      mockSessionMonitoringClose.mockResolvedValue(undefined);
      mockSessionMonitoringCancel.mockResolvedValue(undefined);
      await useAppStore.getState().connectMonitoring({ _sessionBased: true, _sessionId: "sess-c" });

      await useAppStore.getState().cancelMonitoring("sess-c");

      expect(mockSessionMonitoringCancel).toHaveBeenCalledWith("sess-c");
      expect(selectMonitor(useAppStore.getState(), "sess-c")).toBeNull();
    });

    it("tears down an SSH monitor entry without a cancel RPC", async () => {
      mockMonitoringOpen.mockResolvedValue("session-123");
      mockMonitoringFetchStats.mockResolvedValue(TEST_STATS);
      mockMonitoringClose.mockResolvedValue(undefined);
      await useAppStore.getState().connectMonitoring(HOST_A_CONFIG);

      await useAppStore.getState().cancelMonitoring(HOST_A_KEY);

      expect(mockSessionMonitoringCancel).not.toHaveBeenCalled();
      expect(selectMonitor(useAppStore.getState(), HOST_A_KEY)).toBeNull();
    });
  });
});
