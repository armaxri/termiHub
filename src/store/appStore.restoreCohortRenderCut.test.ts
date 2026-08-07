/**
 * Restore-cohort summary rendering from the authoritative region (#2206).
 *
 * Since the reducer removal the aggregate restore/launch summary toast is fired
 * once per new projected settlement `seq` from the `restore-cohort@<clientId>`
 * region — there is no local reducer path any more.
 *
 * These tests prove:
 * - a partial restore fires exactly one partial (info) summary from the projection,
 *   asynchronously (after the settle round-trips), with the bulk-retry action
 *   attached from the live-filtered projected retry set;
 * - a full success fires exactly one success summary;
 * - when the region is unreachable (every dispatch rejected), no toast fires and
 *   the failure is logged (the authoritative model has no local fallback).
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

const mockLoad = vi.mocked(loadLastSession);

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

describe("restore-cohort summary — fires from the authoritative region", () => {
  it("fires the partial summary from the projected settlement, once, asynchronously", async () => {
    mockLoad.mockResolvedValue(threeLocalTabsSession());
    await useAppStore.getState().restoreLastSession();
    const ids = restoredTabIds();

    useAppStore.getState().setTabSessionId(ids[0], "sess-a");
    useAppStore.getState().setTabSessionId(ids[1], "sess-b");
    useAppStore.getState().setTerminalDisconnectWithError(ids[2], "connection refused");

    // Not fired synchronously — the toast waits for the projected settlement.
    expect(toastInfo).not.toHaveBeenCalled();

    await restore.flush();

    // Exactly one aggregate partial summary, sourced from the projected region.
    expect(toastInfo).toHaveBeenCalledTimes(1);
    expect(toastSuccess).not.toHaveBeenCalled();
    const msg = String(toastInfo.mock.calls[0][0]);
    expect(msg).toContain("2");
    expect(msg).toContain("3");
    expect(msg).toContain("1");
    // The bulk-retry action is attached from the projected retry set (live-filtered).
    const opts = toastInfo.mock.calls[0][1] as { action?: { label: string; onClick: () => void } };
    expect(opts?.action?.label).toBe("Reconnect failed tabs");
    expect(restore.transport().onlyRegionView().failedTabIds).toEqual([ids[2]]);
  });

  it("fires the success summary from the projection when every tab connects", async () => {
    mockLoad.mockResolvedValue(threeLocalTabsSession());
    await useAppStore.getState().restoreLastSession();
    const ids = restoredTabIds();

    ids.forEach((id, i) => useAppStore.getState().setTabSessionId(id, `sess-${i}`));
    expect(toastSuccess).not.toHaveBeenCalled();

    await restore.flush();

    expect(toastSuccess).toHaveBeenCalledTimes(1);
    expect(toastInfo).not.toHaveBeenCalled();
    expect(String(toastSuccess.mock.calls[0][0])).toContain("3");
  });

  it("fires no toast when the region is unreachable (every dispatch rejected)", async () => {
    restore.transport().rejectDispatch = true;
    mockLoad.mockResolvedValue(threeLocalTabsSession());
    await useAppStore.getState().restoreLastSession();
    const ids = restoredTabIds();

    useAppStore.getState().setTabSessionId(ids[0], "sess-a");
    useAppStore.getState().setTabSessionId(ids[1], "sess-b");
    useAppStore.getState().setTerminalDisconnectWithError(ids[2], "refused");

    await restore.flush();

    // The rejected mirror never advances the region — with no local fallback, no
    // summary fires (the failure is logged to the LogViewer instead).
    expect(toastInfo).not.toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();
  });
});
