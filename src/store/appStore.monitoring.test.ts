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
}));

// Session-based monitoring subscribes to Tauri events and stores the returned
// unlisten fns; the tests below assert those listeners are not leaked on a
// failed open. Status callbacks are captured so a test can push a transition.
const mockUnlisten = vi.fn();
const mockStatusUnlisten = vi.fn();
type StatusCallback = (sessionId: string, status: MonitorStatus) => void;
let capturedStatusCallback: StatusCallback | null = null;
const mockOnSessionMonitoringStats = vi.fn((..._args: unknown[]) => Promise.resolve(mockUnlisten));
const mockOnSessionMonitoringStatus = vi.fn((cb: StatusCallback) => {
  capturedStatusCallback = cb;
  return Promise.resolve(mockStatusUnlisten);
});

vi.mock("@/services/events", () => ({
  onSessionMonitoringStats: (...args: unknown[]) => mockOnSessionMonitoringStats(...args),
  onSessionMonitoringStatus: (cb: StatusCallback) => mockOnSessionMonitoringStatus(cb),
  onPersistentSessionStateChanged: vi.fn(() => Promise.resolve(() => {})),
}));

import { useAppStore } from "./appStore";
import type { MonitorStatus, SystemStats } from "@/types/monitoring";

const TEST_SSH_CONFIG = {
  host: "pi.local",
  port: 22,
  username: "pi",
  authMethod: "key" as const,
  keyPath: "/home/.ssh/id_rsa",
};

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

describe("appStore — monitoring", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    vi.clearAllMocks();
    capturedStatusCallback = null;
  });

  describe("connectMonitoring", () => {
    it("sets session, host, and stats on success", async () => {
      mockMonitoringOpen.mockResolvedValue("session-123");
      mockMonitoringFetchStats.mockResolvedValue(TEST_STATS);

      await useAppStore.getState().connectMonitoring(TEST_SSH_CONFIG);

      const state = useAppStore.getState();
      expect(state.monitoringSessionId).toBe("session-123");
      expect(state.monitoringHost).toBe("pi@pi.local:22");
      expect(state.monitoringStats).toEqual(TEST_STATS);
      expect(state.monitoringLoading).toBe(false);
      expect(state.monitoringError).toBeNull();
    });

    it("sets error without throwing on connection failure", async () => {
      mockMonitoringOpen.mockRejectedValue(new Error("Connection refused"));

      await useAppStore.getState().connectMonitoring(TEST_SSH_CONFIG);

      const state = useAppStore.getState();
      expect(state.monitoringSessionId).toBeNull();
      expect(state.monitoringLoading).toBe(false);
      expect(state.monitoringError).toBe("Connection refused");
    });

    it("sets error without throwing on stats fetch failure", async () => {
      mockMonitoringOpen.mockResolvedValue("session-123");
      mockMonitoringFetchStats.mockRejectedValue(new Error("Stats timeout"));

      await useAppStore.getState().connectMonitoring(TEST_SSH_CONFIG);

      const state = useAppStore.getState();
      expect(state.monitoringSessionId).toBeNull();
      expect(state.monitoringLoading).toBe(false);
      expect(state.monitoringError).toBe("Stats timeout");
    });

    it("sets monitoringLoading to true while connecting", async () => {
      let resolveOpen: (v: string) => void;
      mockMonitoringOpen.mockReturnValue(
        new Promise<string>((r) => {
          resolveOpen = r;
        })
      );
      mockMonitoringFetchStats.mockResolvedValue(TEST_STATS);

      const promise = useAppStore.getState().connectMonitoring(TEST_SSH_CONFIG);
      expect(useAppStore.getState().monitoringLoading).toBe(true);

      resolveOpen!("session-123");
      await promise;
      expect(useAppStore.getState().monitoringLoading).toBe(false);
    });
  });

  describe("connectMonitoring — session-based (push)", () => {
    const SESSION_CONFIG = { _sessionBased: true, _sessionId: "sess-abc" };

    it("sets session and clears loading on successful open", async () => {
      mockSessionMonitoringOpen.mockResolvedValue(undefined);

      await useAppStore.getState().connectMonitoring(SESSION_CONFIG);

      const state = useAppStore.getState();
      expect(state.monitoringSessionId).toBe("sess-abc");
      expect(state.monitoringHost).toBe("sess-abc");
      expect(state.monitoringLoading).toBe(false);
      expect(mockOnSessionMonitoringStats).toHaveBeenCalledTimes(1);
    });

    it("unlistens the stats listener when session_monitoring_open fails (no leak)", async () => {
      mockSessionMonitoringOpen.mockRejectedValue(new Error("open refused"));

      await useAppStore.getState().connectMonitoring(SESSION_CONFIG);

      // The event listener was attached before the failing open, so it must be
      // detached in the catch — otherwise a dangling listener could later update
      // the wrong host (audit G5).
      expect(mockOnSessionMonitoringStats).toHaveBeenCalledTimes(1);
      expect(mockUnlisten).toHaveBeenCalledTimes(1);

      const state = useAppStore.getState();
      expect(state.monitoringSessionId).toBeNull();
      expect(state.monitoringLoading).toBe(false);
      expect(state.monitoringError).toBe("open refused");
    });

    it("does not re-invoke the leaked listener on a later disconnect", async () => {
      mockSessionMonitoringOpen.mockRejectedValue(new Error("open refused"));

      await useAppStore.getState().connectMonitoring(SESSION_CONFIG);
      expect(mockUnlisten).toHaveBeenCalledTimes(1);

      // A subsequent disconnect must not call the (already-detached) listener again,
      // proving _monitoringUnlisten was nulled in the catch.
      await useAppStore.getState().disconnectMonitoring();
      expect(mockUnlisten).toHaveBeenCalledTimes(1);
    });
  });

  describe("disconnectMonitoring", () => {
    it("clears all monitoring state", async () => {
      mockMonitoringClose.mockResolvedValue(undefined);

      // Set up connected state
      useAppStore.setState({
        monitoringSessionId: "session-123",
        monitoringHost: "pi@pi.local:22",
        monitoringStats: TEST_STATS,
        monitoringError: null,
      });

      await useAppStore.getState().disconnectMonitoring();

      const state = useAppStore.getState();
      expect(state.monitoringSessionId).toBeNull();
      expect(state.monitoringHost).toBeNull();
      expect(state.monitoringStats).toBeNull();
      expect(state.monitoringError).toBeNull();
    });

    it("clears state even if close command fails", async () => {
      mockMonitoringClose.mockRejectedValue(new Error("network down"));

      useAppStore.setState({
        monitoringSessionId: "session-123",
        monitoringHost: "pi@pi.local:22",
        monitoringStats: TEST_STATS,
      });

      await useAppStore.getState().disconnectMonitoring();

      const state = useAppStore.getState();
      expect(state.monitoringSessionId).toBeNull();
      expect(state.monitoringHost).toBeNull();
      expect(state.monitoringStats).toBeNull();
    });

    it("does not call monitoringClose when no session exists", async () => {
      await useAppStore.getState().disconnectMonitoring();
      expect(mockMonitoringClose).not.toHaveBeenCalled();
    });
  });

  describe("refreshMonitoring", () => {
    it("does NOT toggle monitoringLoading", async () => {
      mockMonitoringFetchStats.mockResolvedValue(TEST_STATS);

      useAppStore.setState({
        monitoringSessionId: "session-123",
        monitoringLoading: false,
      });

      const loadingStates: boolean[] = [];
      const unsub = useAppStore.subscribe((state) => {
        loadingStates.push(state.monitoringLoading);
      });

      await useAppStore.getState().refreshMonitoring();

      unsub();
      // monitoringLoading should never have been set to true during refresh
      expect(loadingStates.every((v) => v === false)).toBe(true);
    });

    it("updates stats on success", async () => {
      const updatedStats = { ...TEST_STATS, cpuUsagePercent: 75.0 };
      mockMonitoringFetchStats.mockResolvedValue(updatedStats);

      useAppStore.setState({
        monitoringSessionId: "session-123",
        monitoringStats: TEST_STATS,
      });

      await useAppStore.getState().refreshMonitoring();

      expect(useAppStore.getState().monitoringStats).toEqual(updatedStats);
      expect(useAppStore.getState().monitoringError).toBeNull();
    });

    it("sets error on failure", async () => {
      mockMonitoringFetchStats.mockRejectedValue(new Error("timeout"));

      useAppStore.setState({
        monitoringSessionId: "session-123",
        monitoringStats: TEST_STATS,
      });

      await useAppStore.getState().refreshMonitoring();

      expect(useAppStore.getState().monitoringError).toBe("timeout");
    });

    it("no-ops when not connected", async () => {
      await useAppStore.getState().refreshMonitoring();
      expect(mockMonitoringFetchStats).not.toHaveBeenCalled();
    });

    it("updates the stats cache with fresh stats", async () => {
      const updatedStats = { ...TEST_STATS, cpuUsagePercent: 80.0 };
      mockMonitoringFetchStats.mockResolvedValue(updatedStats);

      useAppStore.setState({
        monitoringSessionId: "session-123",
        monitoringHost: "pi@pi.local:22",
        monitoringStats: TEST_STATS,
      });

      await useAppStore.getState().refreshMonitoring();

      expect(useAppStore.getState().monitoringStatsCache["pi@pi.local:22"]).toEqual(updatedStats);
    });
  });

  // Audit gap G10: the first sample reports CPU 0% (no prior delta), so the
  // status bar shows a priming indicator until the second sample. The store
  // tracks progress via monitoringSampleCount.
  describe("monitoringSampleCount (CPU priming)", () => {
    it("is 1 after the first SSH connect fetch", async () => {
      mockMonitoringOpen.mockResolvedValue("session-123");
      mockMonitoringFetchStats.mockResolvedValue(TEST_STATS);

      await useAppStore.getState().connectMonitoring(TEST_SSH_CONFIG);

      expect(useAppStore.getState().monitoringSampleCount).toBe(1);
    });

    it("increments to 2 after a subsequent refresh", async () => {
      mockMonitoringOpen.mockResolvedValue("session-123");
      mockMonitoringFetchStats.mockResolvedValue(TEST_STATS);
      await useAppStore.getState().connectMonitoring(TEST_SSH_CONFIG);

      mockMonitoringFetchStats.mockResolvedValue({ ...TEST_STATS, cpuUsagePercent: 40 });
      await useAppStore.getState().refreshMonitoring();

      expect(useAppStore.getState().monitoringSampleCount).toBe(2);
    });

    it("resets to 0 on disconnect", async () => {
      mockMonitoringClose.mockResolvedValue(undefined);
      useAppStore.setState({
        monitoringSessionId: "session-123",
        monitoringHost: "pi@pi.local:22",
        monitoringStats: TEST_STATS,
        monitoringSampleCount: 5,
      });

      await useAppStore.getState().disconnectMonitoring();

      expect(useAppStore.getState().monitoringSampleCount).toBe(0);
    });

    it("resets to 0 at the start of a fresh connect", async () => {
      // Simulate a stale counter from a previous session.
      useAppStore.setState({ monitoringSampleCount: 7 });
      mockMonitoringOpen.mockResolvedValue("session-456");
      mockMonitoringFetchStats.mockResolvedValue(TEST_STATS);

      await useAppStore.getState().connectMonitoring(TEST_SSH_CONFIG);

      // Reset to 0, then +1 for the initial fetch = 1.
      expect(useAppStore.getState().monitoringSampleCount).toBe(1);
    });
  });

  describe("stats cache", () => {
    it("disconnectMonitoring saves stats to cache keyed by host", async () => {
      mockMonitoringClose.mockResolvedValue(undefined);

      useAppStore.setState({
        monitoringSessionId: "session-123",
        monitoringHost: "pi@pi.local:22",
        monitoringStats: TEST_STATS,
      });

      await useAppStore.getState().disconnectMonitoring();

      expect(useAppStore.getState().monitoringStatsCache["pi@pi.local:22"]).toEqual(TEST_STATS);
    });

    it("disconnectMonitoring does not update cache when there are no stats", async () => {
      mockMonitoringClose.mockResolvedValue(undefined);

      useAppStore.setState({
        monitoringSessionId: "session-123",
        monitoringHost: "pi@pi.local:22",
        monitoringStats: null,
        monitoringStatsCache: {},
      });

      await useAppStore.getState().disconnectMonitoring();

      expect(useAppStore.getState().monitoringStatsCache).toEqual({});
    });

    it("connectMonitoring pre-populates stats from cache on reconnect", async () => {
      mockMonitoringOpen.mockResolvedValue("session-456");
      mockMonitoringFetchStats.mockResolvedValue(TEST_STATS);

      useAppStore.setState({
        monitoringStatsCache: { "pi@pi.local:22": TEST_STATS },
      });

      let capturedStats: SystemStats | null = null;
      let capturedHost: string | null = null;
      const unsub = useAppStore.subscribe((state) => {
        if (state.monitoringLoading && state.monitoringStats !== null) {
          capturedStats = state.monitoringStats;
          capturedHost = state.monitoringHost;
        }
      });

      await useAppStore.getState().connectMonitoring(TEST_SSH_CONFIG);
      unsub();

      // Stats and host should have been set from cache while loading
      expect(capturedStats).toEqual(TEST_STATS);
      expect(capturedHost).toBe("pi@pi.local:22");
    });

    it("connectMonitoring starts with null stats when no cache entry exists", async () => {
      mockMonitoringOpen.mockResolvedValue("session-789");
      mockMonitoringFetchStats.mockResolvedValue(TEST_STATS);

      let statsWhileLoading: SystemStats | null | undefined = undefined;
      const unsub = useAppStore.subscribe((state) => {
        if (state.monitoringLoading && statsWhileLoading === undefined) {
          statsWhileLoading = state.monitoringStats;
        }
      });

      await useAppStore.getState().connectMonitoring(TEST_SSH_CONFIG);
      unsub();

      expect(statsWhileLoading).toBeNull();
    });

    it("connectMonitoring updates cache after successful connect", async () => {
      mockMonitoringOpen.mockResolvedValue("session-123");
      mockMonitoringFetchStats.mockResolvedValue(TEST_STATS);

      await useAppStore.getState().connectMonitoring(TEST_SSH_CONFIG);

      expect(useAppStore.getState().monitoringStatsCache["pi@pi.local:22"]).toEqual(TEST_STATS);
    });
  });

  // Audit gap G9: a stale monitoringError must not linger across hosts. The
  // store clears it on every successful stat update and exposes an explicit
  // clearMonitoringError() so the status bar can reset it when switching hosts.
  describe("clearMonitoringError (G9)", () => {
    it("clears a lingering monitoringError", () => {
      useAppStore.setState({ monitoringError: "stale error from previous host" });

      useAppStore.getState().clearMonitoringError();

      expect(useAppStore.getState().monitoringError).toBeNull();
    });

    it("is a no-op when there is no error", () => {
      useAppStore.setState({ monitoringError: null });

      useAppStore.getState().clearMonitoringError();

      expect(useAppStore.getState().monitoringError).toBeNull();
    });

    it("refreshMonitoring success clears a pre-existing error (does not linger)", async () => {
      mockMonitoringFetchStats.mockResolvedValue(TEST_STATS);

      useAppStore.setState({
        monitoringSessionId: "session-123",
        monitoringHost: "pi@pi.local:22",
        monitoringStats: TEST_STATS,
        monitoringError: "old timeout error",
      });

      await useAppStore.getState().refreshMonitoring();

      expect(useAppStore.getState().monitoringError).toBeNull();
    });

    it("connectMonitoring start clears a stale error before connecting", async () => {
      mockMonitoringOpen.mockResolvedValue("session-123");
      mockMonitoringFetchStats.mockResolvedValue(TEST_STATS);

      useAppStore.setState({ monitoringError: "error from a previous host" });

      let errorWhileLoading: string | null | undefined = undefined;
      const unsub = useAppStore.subscribe((state) => {
        if (state.monitoringLoading && errorWhileLoading === undefined) {
          errorWhileLoading = state.monitoringError;
        }
      });

      await useAppStore.getState().connectMonitoring(TEST_SSH_CONFIG);
      unsub();

      expect(errorWhileLoading).toBeNull();
    });
  });

  // Audit gap G8: cancelling the password prompt during auto-connect must leave
  // a visible "not connected" affordance instead of silently returning. The
  // store tracks this via monitoringCancelled.
  describe("monitoringCancelled (G8)", () => {
    it("defaults to false", () => {
      expect(useAppStore.getState().monitoringCancelled).toBe(false);
    });

    it("setMonitoringCancelled toggles the flag", () => {
      useAppStore.getState().setMonitoringCancelled(true);
      expect(useAppStore.getState().monitoringCancelled).toBe(true);

      useAppStore.getState().setMonitoringCancelled(false);
      expect(useAppStore.getState().monitoringCancelled).toBe(false);
    });

    it("connectMonitoring start clears a stale cancelled flag", async () => {
      mockMonitoringOpen.mockResolvedValue("session-123");
      mockMonitoringFetchStats.mockResolvedValue(TEST_STATS);

      useAppStore.setState({ monitoringCancelled: true });

      await useAppStore.getState().connectMonitoring(TEST_SSH_CONFIG);

      expect(useAppStore.getState().monitoringCancelled).toBe(false);
    });

    it("disconnectMonitoring clears the cancelled flag", async () => {
      mockMonitoringClose.mockResolvedValue(undefined);

      useAppStore.setState({
        monitoringSessionId: "session-123",
        monitoringHost: "pi@pi.local:22",
        monitoringStats: TEST_STATS,
        monitoringCancelled: true,
      });

      await useAppStore.getState().disconnectMonitoring();

      expect(useAppStore.getState().monitoringCancelled).toBe(false);
    });
  });

  // Issue #1229 (audit gap G1): a mid-stream drop must surface as an explicit
  // "stale" status so frozen stats are not shown as live.
  describe("monitoringStatus (Stale — G1)", () => {
    it("defaults to null when nothing is monitored", () => {
      expect(useAppStore.getState().monitoringStatus).toBeNull();
    });

    it("is 'live' after a successful SSH connect", async () => {
      mockMonitoringOpen.mockResolvedValue("session-123");
      mockMonitoringFetchStats.mockResolvedValue(TEST_STATS);

      await useAppStore.getState().connectMonitoring(TEST_SSH_CONFIG);

      expect(useAppStore.getState().monitoringStatus).toBe("live");
    });

    it("flips to 'stale' when an SSH refresh poll fails", async () => {
      mockMonitoringFetchStats.mockRejectedValue(new Error("timeout"));
      useAppStore.setState({
        monitoringSessionId: "session-123",
        monitoringHost: "pi@pi.local:22",
        monitoringStats: TEST_STATS,
        monitoringStatus: "live",
      });

      await useAppStore.getState().refreshMonitoring();

      expect(useAppStore.getState().monitoringStatus).toBe("stale");
    });

    it("recovers to 'live' when a later SSH refresh poll succeeds", async () => {
      useAppStore.setState({
        monitoringSessionId: "session-123",
        monitoringHost: "pi@pi.local:22",
        monitoringStats: TEST_STATS,
        monitoringStatus: "stale",
      });
      mockMonitoringFetchStats.mockResolvedValue(TEST_STATS);

      await useAppStore.getState().refreshMonitoring();

      expect(useAppStore.getState().monitoringStatus).toBe("live");
    });

    it("is 'live' after a session-based open, then follows status push events", async () => {
      mockSessionMonitoringOpen.mockResolvedValue(undefined);

      await useAppStore.getState().connectMonitoring({
        _sessionBased: true,
        _sessionId: "sess-abc",
      });
      expect(useAppStore.getState().monitoringStatus).toBe("live");
      expect(mockOnSessionMonitoringStatus).toHaveBeenCalledTimes(1);
      expect(capturedStatusCallback).not.toBeNull();

      // A mid-stream drop pushes "stale" for the active session.
      capturedStatusCallback?.("sess-abc", "stale" as MonitorStatus);
      expect(useAppStore.getState().monitoringStatus).toBe("stale");

      // Recovery pushes "live" again.
      capturedStatusCallback?.("sess-abc", "live" as MonitorStatus);
      expect(useAppStore.getState().monitoringStatus).toBe("live");
    });

    it("ignores status events for a different session", async () => {
      mockSessionMonitoringOpen.mockResolvedValue(undefined);

      await useAppStore.getState().connectMonitoring({
        _sessionBased: true,
        _sessionId: "sess-abc",
      });

      capturedStatusCallback?.("some-other-session", "stale" as MonitorStatus);

      // Unrelated session must not change our status.
      expect(useAppStore.getState().monitoringStatus).toBe("live");
    });

    it("resets to null on disconnect", async () => {
      mockMonitoringClose.mockResolvedValue(undefined);
      useAppStore.setState({
        monitoringSessionId: "session-123",
        monitoringHost: "pi@pi.local:22",
        monitoringStats: TEST_STATS,
        monitoringStatus: "stale",
      });

      await useAppStore.getState().disconnectMonitoring();

      expect(useAppStore.getState().monitoringStatus).toBeNull();
    });
  });
});
