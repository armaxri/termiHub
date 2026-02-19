import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock service modules before importing the store
vi.mock("@/services/storage", () => ({
  loadConnections: vi.fn(() =>
    Promise.resolve({ connections: [], folders: [], externalSources: [] })
  ),
  persistConnection: vi.fn(() => Promise.resolve()),
  removeConnection: vi.fn(() => Promise.resolve()),
  persistFolder: vi.fn(() => Promise.resolve()),
  removeFolder: vi.fn(() => Promise.resolve()),
  getSettings: vi.fn(() => Promise.resolve({ version: "1", externalConnectionFiles: [] })),
  saveSettings: vi.fn(() => Promise.resolve()),
  saveExternalFile: vi.fn(() => Promise.resolve()),
  reloadExternalConnections: vi.fn(() => Promise.resolve([])),
}));

const mockMonitoringOpen = vi.fn();
const mockMonitoringClose = vi.fn();
const mockMonitoringFetchStats = vi.fn();

vi.mock("@/services/api", () => ({
  sftpOpen: vi.fn(),
  sftpClose: vi.fn(),
  sftpListDir: vi.fn(),
  localListDir: vi.fn(),
  vscodeAvailable: vi.fn(() => Promise.resolve(false)),
  monitoringOpen: (...args: unknown[]) => mockMonitoringOpen(...args),
  monitoringClose: (...args: unknown[]) => mockMonitoringClose(...args),
  monitoringFetchStats: (...args: unknown[]) => mockMonitoringFetchStats(...args),
}));

import { useAppStore } from "./appStore";
import type { SshConfig } from "@/types/terminal";
import type { SystemStats } from "@/types/monitoring";

const TEST_SSH_CONFIG: SshConfig = {
  host: "pi.local",
  port: 22,
  username: "pi",
  authMethod: "key",
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
  });
});
