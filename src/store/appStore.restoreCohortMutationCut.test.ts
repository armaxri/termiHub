/**
 * Restore-cohort intents drive the authoritative region (#2206).
 *
 * Since the reducer removal the `appStore` `beginRestoreCohort` / `settleRestoreTab`
 * actions are thin dispatchers of the `restore.beginCohort` / `restore.settleTab`
 * intents, and the `restore-cohort@<clientId>` region (a faithful in-memory port of
 * the Rust `RestoreCohortStore`) is the sole source of truth.
 *
 * These tests prove the intents the actions dispatch reconstruct the expected
 * region: the settled summary + captured failed-tab set, the in-flight cohort, the
 * bulk-retry follow-up, and that the region — not the frontend — is the sole guard
 * that ignores a stray settle.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const toastSuccess = vi.fn((_m: unknown, _o?: unknown) => undefined);
const toastError = vi.fn((_m: unknown, _o?: unknown) => undefined);
const toastInfo = vi.fn((_m: unknown, _o?: unknown) => undefined);
vi.mock("@/components/ui", () => ({
  toast: {
    success: (m: unknown, o?: unknown) => (o === undefined ? toastSuccess(m) : toastSuccess(m, o)),
    error: (m: unknown, o?: unknown) => (o === undefined ? toastError(m) : toastError(m, o)),
    info: (m: unknown, o?: unknown) => (o === undefined ? toastInfo(m) : toastInfo(m, o)),
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

setupConnectionsRegion();
setupSettingsRegion();
setupAgentsRegion();
const restore = setupRestoreCohortRegion();

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState());
  vi.clearAllMocks();
  mockLoad.mockResolvedValue(null);
  useAppStore.setState({ defaultShell: "bash" });
  seedSettings({ restoreLastSessionOnStartup: true });
  seedConnectionsRegion({ connections: [] });
});

describe("restore-cohort intents drive the authoritative region", () => {
  it("a partial restore reproduces the settled region + captured failed set", async () => {
    mockLoad.mockResolvedValue(threeLocalTabsSession());
    await useAppStore.getState().restoreLastSession();
    const ids = restoredTabIds();
    expect(ids).toHaveLength(3);

    useAppStore.getState().setTabSessionId(ids[0], "sess-a");
    useAppStore.getState().setTabSessionId(ids[1], "sess-b");
    useAppStore.getState().setTerminalDisconnectWithError(ids[2], "connection refused");
    await restore.flush();

    // The intent stream: one begin, then one settle per tab.
    expect(restore.transport().kinds()).toEqual([
      "restore.beginCohort",
      "restore.settleTab",
      "restore.settleTab",
      "restore.settleTab",
    ]);

    const region = restore.transport().onlyRegionView();
    // The cohort settled and the projected summary reflects the outcome.
    expect(region.cohort).toBeNull();
    expect(region.settlement).toMatchObject({ total: 3, restored: 2, failed: 1 });
    expect(region.settlement?.retryTabIds).toEqual([ids[2]]);
    expect(region.failedTabIds).toEqual([ids[2]]);
  });

  it("a full success reproduces a zero-failure settlement", async () => {
    mockLoad.mockResolvedValue(threeLocalTabsSession());
    await useAppStore.getState().restoreLastSession();
    const ids = restoredTabIds();

    ids.forEach((id, i) => useAppStore.getState().setTabSessionId(id, `sess-${i}`));
    await restore.flush();

    const region = restore.transport().onlyRegionView();
    expect(region.settlement).toMatchObject({ total: 3, restored: 3, failed: 0 });
    expect(region.settlement?.retryTabIds).toEqual([]);
    expect(region.failedTabIds).toEqual([]);
  });

  it("mirrors the in-flight cohort before it settles", async () => {
    mockLoad.mockResolvedValue(threeLocalTabsSession());
    await useAppStore.getState().restoreLastSession();
    const ids = restoredTabIds();

    // Settle only one tab — the cohort is still in flight.
    useAppStore.getState().setTabSessionId(ids[0], "sess-a");
    await restore.flush();

    const region = restore.transport().onlyRegionView();
    expect(region.settlement).toBeNull();
    expect(region.cohort).not.toBeNull();
    expect(region.cohort?.total).toBe(3);
    expect(region.cohort?.pending).toEqual([ids[1], ids[2]]);
    expect(region.cohort?.failed).toBe(0);
  });

  it("bulk-retry reconnect dispatches a fresh cohort + settle", async () => {
    mockLoad.mockResolvedValue(threeLocalTabsSession());
    await useAppStore.getState().restoreLastSession();
    const ids = restoredTabIds();
    useAppStore.getState().setTabSessionId(ids[0], "sess-a");
    useAppStore.getState().setTabSessionId(ids[1], "sess-b");
    useAppStore.getState().setTerminalDisconnectWithError(ids[2], "refused");
    await restore.flush();
    const before = restore.transport().dispatched.length;

    useAppStore.getState().reconnectFailedRestoreTabs();
    useAppStore.getState().setTabSessionId(ids[2], "sess-c-retry");
    await restore.flush();

    // A fresh beginCohort covering the retried tab, then its settle.
    expect(restore.transport().kinds().slice(before)).toEqual([
      "restore.beginCohort",
      "restore.settleTab",
    ]);
    const region = restore.transport().onlyRegionView();
    expect(region.settlement).toMatchObject({ total: 1, restored: 1, failed: 0 });
    expect(region.failedTabIds).toEqual([]);
  });

  it("the region is the sole guard: a stray settle is dispatched but ignored", async () => {
    mockLoad.mockResolvedValue(threeLocalTabsSession());
    await useAppStore.getState().restoreLastSession();
    const ids = restoredTabIds();
    ids.forEach((id, i) => useAppStore.getState().setTabSessionId(id, `sess-${i}`));
    await restore.flush();
    const settledSeq = restore.transport().onlyRegionView().settlement?.seq;
    const before = restore.transport().dispatched.length;

    // The cohort has settled — a later settle on the same tab is dispatched
    // unconditionally, but the region ignores a non-pending settle: no new
    // settlement, so no fresh summary.
    useAppStore.getState().setTerminalDisconnectWithError(ids[0], "later drop");
    await restore.flush();

    expect(restore.transport().dispatched.length).toBeGreaterThan(before);
    expect(restore.transport().kinds().slice(before)).toContain("restore.settleTab");
    const region = restore.transport().onlyRegionView();
    expect(region.cohort).toBeNull();
    expect(region.settlement?.seq).toBe(settledSeq);
  });
});
