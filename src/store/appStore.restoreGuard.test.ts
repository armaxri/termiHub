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
 * overwrite the good last-session file. Once the restore cohort settles — every
 * restored tab has connected or failed (#4387) — the flag clears and auto-saves
 * resume; a generous safety timeout lowers it if the settlement never arrives.
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
import { setupRestoreCohortRegion } from "@/test/restoreCohortHarness";
import { saveLastSession, loadLastSession } from "@/services/lastSessionApi";
import type { LastSession } from "@/types/lastSession";
import { getAllLeaves } from "@/utils/panelTree";
import { layoutState } from "@/test/layoutState";
import { RESTORE_GUARD_SAFETY_TIMEOUT_MS } from "./restoreHelpers";

setupConnectionsRegion();
setupSettingsRegion();
setupAgentsRegion();
const restoreRegion = setupRestoreCohortRegion();

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

  it("holds restoreInProgress during a restore and clears it by the safety timeout", async () => {
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

    // A save scheduled while the cohort is unsettled is dropped.
    useAppStore.getState().scheduleLastSessionSave();
    await vi.advanceTimersByTimeAsync(0);
    expect(mockSave).not.toHaveBeenCalled();

    // No tab ever settles here (no Terminal mounts), so the safety timeout
    // lowers the guard and saves resume.
    await vi.runAllTimersAsync();
    expect(useAppStore.getState().restoreInProgress).toBe(false);

    useAppStore.getState().scheduleLastSessionSave();
    await vi.runAllTimersAsync();
    expect(mockSave).toHaveBeenCalled();
  });
});

/** A one-tab session that resolves to a plain local terminal. */
function oneLocalTabSession(title = "Shell A"): LastSession {
  return {
    version: "1",
    activeGroupIndex: 0,
    tabGroups: [
      {
        name: "Restored",
        layout: {
          type: "leaf",
          tabs: [{ inlineConfig: { type: "local", config: { shell: "bash" } }, title }],
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

describe("restore guard follows the restore cohort (#4387)", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    vi.clearAllMocks();
    useAppStore.setState({ defaultShell: "bash", restoreInProgress: false });
    seedSettings({ restoreLastSessionOnStartup: true });
    seedConnectionsRegion({ connections: [] });
    // Only fake the timers the guard + debounce use; the region harness drains
    // its dispatch chain through setImmediate, which must stay real.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });

  afterEach(async () => {
    // Drain any guard still raised so it does not leak into the next case.
    await vi.advanceTimersByTimeAsync(RESTORE_GUARD_SAFETY_TIMEOUT_MS);
    vi.useRealTimers();
  });

  it("stays guarded while a slow tab connects and resumes exactly when it settles", async () => {
    mockLoad.mockResolvedValue(oneLocalTabSession());
    await useAppStore.getState().restoreLastSession();
    await restoreRegion.flush();
    const [tabId] = restoredTabIds();
    expect(tabId).toBeDefined();

    // 5s into a slow SSH/agent connect: well past the old fixed 2s window.
    await vi.advanceTimersByTimeAsync(5000);
    expect(useAppStore.getState().restoreInProgress).toBe(true);
    useAppStore.getState().scheduleLastSessionSave();
    await vi.advanceTimersByTimeAsync(1000);
    expect(mockSave).not.toHaveBeenCalled();

    // The tab connects: the cohort settles and the guard drops right away,
    // long before the safety timeout.
    useAppStore.getState().setTabSessionId(tabId, "sess-a");
    await restoreRegion.flush();
    expect(useAppStore.getState().restoreInProgress).toBe(false);

    useAppStore.getState().scheduleLastSessionSave();
    await vi.advanceTimersByTimeAsync(1000);
    expect(mockSave).toHaveBeenCalledTimes(1);
  });

  it("also resumes when the last tab fails to connect", async () => {
    mockLoad.mockResolvedValue(oneLocalTabSession());
    await useAppStore.getState().restoreLastSession();
    await restoreRegion.flush();
    const [tabId] = restoredTabIds();

    useAppStore.getState().setTerminalDisconnectWithError(tabId, "connection refused");
    await restoreRegion.flush();
    expect(useAppStore.getState().restoreInProgress).toBe(false);
  });

  it("lowers the guard by the safety timeout when the cohort never settles", async () => {
    mockLoad.mockResolvedValue(oneLocalTabSession());
    await useAppStore.getState().restoreLastSession();
    await restoreRegion.flush();

    await vi.advanceTimersByTimeAsync(RESTORE_GUARD_SAFETY_TIMEOUT_MS - 1);
    expect(useAppStore.getState().restoreInProgress).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(useAppStore.getState().restoreInProgress).toBe(false);
  });

  it("waits for the newest cohort when restores overlap", async () => {
    mockLoad.mockResolvedValue(oneLocalTabSession("First"));
    await useAppStore.getState().restoreLastSession();
    await restoreRegion.flush();
    const [firstTab] = restoredTabIds();

    mockLoad.mockResolvedValue(oneLocalTabSession("Second"));
    await useAppStore.getState().restoreLastSession();
    await restoreRegion.flush();
    const [secondTab] = restoredTabIds();
    expect(secondTab).not.toBe(firstTab);

    // A late connect from the superseded restore does not end the guard.
    useAppStore.getState().setTabSessionId(firstTab, "sess-old");
    await restoreRegion.flush();
    expect(useAppStore.getState().restoreInProgress).toBe(true);

    useAppStore.getState().setTabSessionId(secondTab, "sess-new");
    await restoreRegion.flush();
    expect(useAppStore.getState().restoreInProgress).toBe(false);
  });
});
