/**
 * Regression test for GAP G5 from the workspace save/restore audit (#1146).
 *
 * During (and right after) a restore/launch, a manual tab action or an in-flight
 * per-tab connect mutates `rootPanel`/`tabGroups` and fires the App auto-save
 * subscription → `scheduleLastSessionSave`. Because `saveLastSession` recaptures
 * the WHOLE live tree, a save landing while some tabs are still connecting /
 * agent-error persists that degraded snapshot over the previously-good session.
 *
 * The fix adds a `restoreInProgress` flag: while it is true,
 * `scheduleLastSessionSave` is a no-op, so a mid-restore snapshot cannot
 * overwrite the good last-session file. Once the restore cohort settles (a short
 * settle window), the flag clears and auto-saves resume.
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

vi.mock("@/services/api", () => ({
  sftpOpen: vi.fn(),
  sftpClose: vi.fn(),
  sftpListDir: vi.fn(),
  localListDir: vi.fn(),
  vscodeAvailable: vi.fn(() => Promise.resolve(false)),
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
import { saveLastSession, loadLastSession } from "@/services/lastSessionApi";
import type { LastSession } from "@/types/lastSession";

setupConnectionsRegion();
setupSettingsRegion();
setupAgentsRegion();

const mockSave = vi.mocked(saveLastSession);
const mockLoad = vi.mocked(loadLastSession);

describe("appStore — auto-save mid-restore guard (GAP G5, #1146)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoad.mockResolvedValue(null);
    useAppStore.setState({
      defaultShell: "bash",
      restoreInProgress: false,
    });
    seedSettings({ restoreLastSessionOnStartup: true });
    seedConnectionsRegion({ connections: [] });
    // Open a fresh local terminal so there is real content to capture.
    useAppStore.getState().addTab("Shell", "local", { type: "local", config: { shell: "bash" } });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("skips scheduling an auto-save while restoreInProgress is true", async () => {
    vi.useFakeTimers();
    useAppStore.setState({ restoreInProgress: true });

    // A layout change fires this while a restore is settling.
    useAppStore.getState().scheduleLastSessionSave();

    // Flush any debounce timer — nothing should have been scheduled.
    await vi.runAllTimersAsync();

    expect(mockSave).not.toHaveBeenCalled();
  });

  it("resumes auto-save once restoreInProgress clears", async () => {
    vi.useFakeTimers();
    useAppStore.setState({ restoreInProgress: true });
    useAppStore.getState().scheduleLastSessionSave();
    await vi.runAllTimersAsync();
    expect(mockSave).not.toHaveBeenCalled();

    // The restore cohort settles and clears the flag.
    useAppStore.setState({ restoreInProgress: false });
    useAppStore.getState().scheduleLastSessionSave();
    await vi.runAllTimersAsync();

    expect(mockSave).toHaveBeenCalledTimes(1);
    const payload = mockSave.mock.calls[0][0] as LastSession;
    expect(payload.tabGroups.length).toBeGreaterThan(0);
  });

  it("holds restoreInProgress during a restore and clears it after the settle window", async () => {
    vi.useFakeTimers();
    mockLoad.mockResolvedValue({
      version: "1",
      activeGroupIndex: 0,
      tabGroups: [
        {
          name: "Restored",
          layout: {
            type: "leaf",
            tabs: [
              { inlineConfig: { type: "local", config: { shell: "bash" } }, title: "Shell A" },
            ],
          },
        },
      ],
    });

    const restore = useAppStore.getState().restoreLastSession();
    await vi.advanceTimersByTimeAsync(0);
    // The store mutation from the restore has landed; the guard must be up so
    // the App auto-save subscription that just fired is a no-op.
    expect(useAppStore.getState().restoreInProgress).toBe(true);

    await restore;
    // Still guarded immediately after restore resolves (tabs are still settling).
    expect(useAppStore.getState().restoreInProgress).toBe(true);

    // A save scheduled during the settle window is dropped.
    useAppStore.getState().scheduleLastSessionSave();
    await vi.advanceTimersByTimeAsync(0);
    expect(mockSave).not.toHaveBeenCalled();

    // After the settle window elapses the guard clears and saves resume.
    await vi.runAllTimersAsync();
    expect(useAppStore.getState().restoreInProgress).toBe(false);

    useAppStore.getState().scheduleLastSessionSave();
    await vi.runAllTimersAsync();
    expect(mockSave).toHaveBeenCalled();
  });
});
