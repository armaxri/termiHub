import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock the toast hub so we can assert the aggregate restore summary without real DOM toasts.
const toastSuccess = vi.fn((_message: unknown, _opts?: unknown) => undefined);
const toastError = vi.fn((_message: unknown, _opts?: unknown) => undefined);
const toastInfo = vi.fn((_message: unknown, _opts?: unknown) => undefined);
vi.mock("@/components/ui", () => ({
  toast: {
    success: (message: unknown, opts?: unknown) =>
      opts === undefined ? toastSuccess(message) : toastSuccess(message, opts),
    error: (message: unknown, opts?: unknown) =>
      opts === undefined ? toastError(message) : toastError(message, opts),
    info: (message: unknown, opts?: unknown) =>
      opts === undefined ? toastInfo(message) : toastInfo(message, opts),
    loading: vi.fn(() => "toast-id"),
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
  // Teardown-on-restore (GAP G1) closes/detaches prior live sessions best-effort.
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
import { setupRestoreCohortRegion } from "@/test/restoreCohortHarness";
import { loadLastSession } from "@/services/lastSessionApi";

setupConnectionsRegion();
setupSettingsRegion();
setupAgentsRegion();
const restore = setupRestoreCohortRegion();
import { getAllLeaves } from "@/utils/panelTree";
import type { LastSession } from "@/types/lastSession";
import { layoutState } from "@/test/layoutState";

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
  return getAllLeaves(layoutState().rootPanel)
    .flatMap((l) => l.tabs)
    .map((t) => t.id);
}

describe("partial-restore summary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoad.mockResolvedValue(null);
    useAppStore.setState({ defaultShell: "bash" });
    seedSettings({ restoreLastSessionOnStartup: true });
    seedConnectionsRegion({ connections: [] });
  });

  it("raises one info summary reflecting M/K when some restored tabs fail", async () => {
    mockLoad.mockResolvedValue(threeLocalTabsSession());

    const restored = await useAppStore.getState().restoreLastSession();
    expect(restored).toBe(true);

    const ids = restoredTabIds();
    expect(ids).toHaveLength(3);

    // No summary until every tab in the cohort has settled.
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(toastInfo).not.toHaveBeenCalled();

    // Two connect, one fails.
    useAppStore.getState().setTabSessionId(ids[0], "sess-a");
    useAppStore.getState().setTabSessionId(ids[1], "sess-b");
    expect(toastInfo).not.toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();

    useAppStore.getState().setTerminalDisconnectWithError(ids[2], "connection refused");
    await restore.flush();

    // Exactly one aggregate summary, and it is the partial (info) variant.
    expect(toastInfo).toHaveBeenCalledTimes(1);
    expect(toastSuccess).not.toHaveBeenCalled();
    const msg = String(toastInfo.mock.calls[0][0]);
    expect(msg).toContain("2"); // restored count (M - K)
    expect(msg).toContain("3"); // total
    expect(msg).toContain("1"); // failed count
  });

  it("raises one success summary when every restored tab connects", async () => {
    mockLoad.mockResolvedValue(threeLocalTabsSession());

    await useAppStore.getState().restoreLastSession();
    const ids = restoredTabIds();

    useAppStore.getState().setTabSessionId(ids[0], "sess-a");
    useAppStore.getState().setTabSessionId(ids[1], "sess-b");
    useAppStore.getState().setTabSessionId(ids[2], "sess-c");
    await restore.flush();

    expect(toastSuccess).toHaveBeenCalledTimes(1);
    expect(toastInfo).not.toHaveBeenCalled();
    expect(String(toastSuccess.mock.calls[0][0])).toContain("3");
  });

  it("raises nothing further once the cohort has settled (steady state)", async () => {
    mockLoad.mockResolvedValue(threeLocalTabsSession());

    await useAppStore.getState().restoreLastSession();
    const ids = restoredTabIds();

    ids.forEach((id, i) => useAppStore.getState().setTabSessionId(id, `sess-${i}`));
    await restore.flush();
    expect(toastSuccess).toHaveBeenCalledTimes(1);

    // Later reconnect churn on the same tabs must not re-fire a summary: the region
    // ignores a settle for a tab that is not pending in any cohort.
    useAppStore.getState().setTerminalDisconnectWithError(ids[0], "later drop");
    useAppStore.getState().setTabSessionId(ids[0], "sess-0b");
    await restore.flush();

    expect(toastSuccess).toHaveBeenCalledTimes(1);
    expect(toastInfo).not.toHaveBeenCalled();
  });

  it("does not summarize session-id changes that are outside a restore cohort", async () => {
    // A plain manual tab, no restore cohort registered.
    seedConnectionsRegion({ connections: [] });
    useAppStore.getState().addTab("Shell", "local", { type: "local", config: { shell: "bash" } });
    const id = restoredTabIds()[0];

    useAppStore.getState().setTabSessionId(id, "sess-manual");
    useAppStore.getState().setTerminalDisconnectWithError(id, "boom");
    await restore.flush();

    expect(toastSuccess).not.toHaveBeenCalled();
    expect(toastInfo).not.toHaveBeenCalled();
  });
});
