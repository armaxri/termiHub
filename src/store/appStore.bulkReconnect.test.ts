import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock the toast hub so we can assert the aggregate restore/reconnect feedback
// without real DOM toasts. Mirrors appStore.restoreSummary.test.ts.
const toastSuccess = vi.fn((_message: unknown, _opts?: unknown) => undefined);
const toastError = vi.fn((_message: unknown, _opts?: unknown) => undefined);
const toastInfo = vi.fn((_message: unknown, _opts?: unknown) => undefined);
const toastLoading = vi.fn((_message: unknown, _opts?: unknown) => "toast-id");
vi.mock("@/components/ui", () => ({
  toast: {
    success: (message: unknown, opts?: unknown) =>
      opts === undefined ? toastSuccess(message) : toastSuccess(message, opts),
    error: (message: unknown, opts?: unknown) =>
      opts === undefined ? toastError(message) : toastError(message, opts),
    info: (message: unknown, opts?: unknown) =>
      opts === undefined ? toastInfo(message) : toastInfo(message, opts),
    loading: (message: unknown, opts?: unknown) =>
      opts === undefined ? toastLoading(message) : toastLoading(message, opts),
    dismiss: vi.fn(),
  },
}));

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

vi.mock("@/services/api", () => ({
  sftpOpen: vi.fn(),
  sftpClose: vi.fn(),
  sftpListDir: vi.fn(),
  localListDir: vi.fn(),
  vscodeAvailable: vi.fn(() => Promise.resolve(false)),
  closeTerminal: vi.fn(() => Promise.resolve()),
  detachPersistentTab: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/services/lastSessionApi", () => ({
  saveLastSession: vi.fn(() => Promise.resolve()),
  loadLastSession: vi.fn(() => Promise.resolve(null)),
  clearLastSession: vi.fn(() => Promise.resolve()),
}));

import { useAppStore } from "./appStore";
import { setupConnectionsRegion, seedConnectionsRegion } from "@/test/connectionsHarness";
import { setupSettingsRegion, seedSettings } from "@/test/settingsRegionTestHarness";
import { setupAgentsRegion } from "@/test/agentsRegionTestHarness";
import { loadLastSession } from "@/services/lastSessionApi";
import { getAllLeaves } from "@/utils/panelTree";
import type { LastSession } from "@/types/lastSession";

const mockLoad = vi.mocked(loadLastSession);

/** A three-tab session that all resolve to plain local terminals. */
function threeLocalTabsSession(): LastSession {
  return {
    version: "1",
    activeGroupIndex: 0,
    tabGroups: [
      {
        name: "Restored",
        layout: {
          type: "leaf",
          tabs: [
            { inlineConfig: { type: "local", config: { shell: "bash" } }, title: "Shell A" },
            { inlineConfig: { type: "local", config: { shell: "bash" } }, title: "Shell B" },
            { inlineConfig: { type: "local", config: { shell: "bash" } }, title: "Shell C" },
          ],
        },
      },
    ],
  };
}

function restoredTabIds(): string[] {
  return getAllLeaves(useAppStore.getState().rootPanel)
    .flatMap((l) => l.tabs)
    .map((t) => t.id);
}

function tabById(id: string) {
  return getAllLeaves(useAppStore.getState().rootPanel)
    .flatMap((l) => l.tabs)
    .find((t) => t.id === id);
}

/**
 * Restore three tabs and settle two connected + one failed, leaving one failed
 * tab captured for the bulk-reconnect control. Returns the tab ids.
 */
async function restoreWithOneFailure(): Promise<string[]> {
  mockLoad.mockResolvedValue(threeLocalTabsSession());
  await useAppStore.getState().restoreLastSession();
  const ids = restoredTabIds();
  useAppStore.getState().setTabSessionId(ids[0], "sess-a");
  useAppStore.getState().setTabSessionId(ids[1], "sess-b");
  useAppStore.getState().setTerminalDisconnectWithError(ids[2], "connection refused");
  return ids;
}

setupConnectionsRegion();
setupSettingsRegion();
setupAgentsRegion();

describe("bulk reconnect of failed restore tabs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoad.mockResolvedValue(null);
    useAppStore.setState({
      defaultShell: "bash",
      restoreCohort: null,
      failedRestoreTabIds: [],
      terminalConnecting: {},
      terminalDisconnectErrors: {},
      terminalRetryCounters: {},
    });
    seedSettings({ restoreLastSessionOnStartup: true });
    seedConnectionsRegion({ connections: [] });
  });

  it("captures the failed tab ids from a settled partial-restore cohort", async () => {
    const ids = await restoreWithOneFailure();

    // The partial summary fired and the failed terminal tab is remembered.
    expect(toastInfo).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().failedRestoreTabIds).toEqual([ids[2]]);
    // Action affordance is attached to the summary toast so it can be triggered.
    const opts = toastInfo.mock.calls[0][1] as { action?: { label: string; onClick: () => void } };
    expect(opts?.action).toBeDefined();
    expect(typeof opts.action?.onClick).toBe("function");
  });

  it("re-drives ONLY the failed tab of the cohort, not the already-connected ones", async () => {
    const ids = await restoreWithOneFailure();
    vi.clearAllMocks();

    useAppStore.getState().reconnectFailedRestoreTabs();

    // A fresh cohort covers exactly the previously-failed tab.
    const cohort = useAppStore.getState().restoreCohort;
    expect(cohort).not.toBeNull();
    expect([...(cohort?.pending ?? [])]).toEqual([ids[2]]);
    expect(cohort?.total).toBe(1);

    // The failed tab is being re-driven: its disconnect error is cleared and it
    // is marked connecting again.
    expect(useAppStore.getState().terminalConnecting[ids[2]]).toBe(true);
    expect(useAppStore.getState().terminalDisconnectErrors[ids[2]]).toBeUndefined();

    // The already-connected tabs are untouched: not connecting, sessions intact.
    expect(useAppStore.getState().terminalConnecting[ids[0]]).toBeUndefined();
    expect(useAppStore.getState().terminalConnecting[ids[1]]).toBeUndefined();
    expect(tabById(ids[0])?.sessionId).toBe("sess-a");
    expect(tabById(ids[1])?.sessionId).toBe("sess-b");

    // The captured failed set is consumed by the retry.
    expect(useAppStore.getState().failedRestoreTabIds).toEqual([]);
  });

  it("re-summarizes as a success when the bulk retry connects all failed tabs", async () => {
    const ids = await restoreWithOneFailure();
    vi.clearAllMocks();

    useAppStore.getState().reconnectFailedRestoreTabs();
    // Pending feedback for the bulk retry.
    expect(toastLoading).toHaveBeenCalledTimes(1);

    // The retried tab connects.
    useAppStore.getState().setTabSessionId(ids[2], "sess-c-retry");

    expect(toastSuccess).toHaveBeenCalledTimes(1);
    expect(String(toastSuccess.mock.calls[0][0])).toContain("1");
    // No failed tabs remain to retry.
    expect(useAppStore.getState().failedRestoreTabIds).toEqual([]);
    expect(useAppStore.getState().restoreCohort).toBeNull();
  });

  it("re-summarizes as a partial when the bulk retry still fails, keeping the tab retryable", async () => {
    const ids = await restoreWithOneFailure();
    vi.clearAllMocks();

    useAppStore.getState().reconnectFailedRestoreTabs();

    // The retried tab fails again.
    useAppStore.getState().setTerminalDisconnectWithError(ids[2], "still refused");

    // A partial summary fires again and the tab is still remembered for retry.
    expect(toastInfo).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().failedRestoreTabIds).toEqual([ids[2]]);
    expect(useAppStore.getState().restoreCohort).toBeNull();
  });

  it("is a no-op when there are no failed tabs to reconnect", () => {
    useAppStore.setState({ failedRestoreTabIds: [], restoreCohort: null });
    useAppStore.getState().reconnectFailedRestoreTabs();

    expect(useAppStore.getState().restoreCohort).toBeNull();
    expect(toastLoading).not.toHaveBeenCalled();
    expect(toastInfo).not.toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it("ignores captured tab ids that no longer exist in the tree", async () => {
    await restoreWithOneFailure();
    // Simulate the failed tab having been closed since the restore settled.
    useAppStore.setState({ failedRestoreTabIds: ["ghost-tab-id"] });
    vi.clearAllMocks();

    useAppStore.getState().reconnectFailedRestoreTabs();

    // Nothing live to re-drive → no cohort, no pending toast.
    expect(useAppStore.getState().restoreCohort).toBeNull();
    expect(toastLoading).not.toHaveBeenCalled();
    expect(useAppStore.getState().failedRestoreTabIds).toEqual([]);
  });
});
