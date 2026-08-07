import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock service modules before importing the store.
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

const openWindow = vi.fn();
const sendHandoffToWindow = vi.fn();
const claimSession = vi.fn();
const releaseSession = vi.fn();
const takePendingHandoffs = vi.fn();

vi.mock("@/services/api", () => ({
  sftpOpen: vi.fn(),
  sftpClose: vi.fn(() => Promise.resolve()),
  sftpListDir: vi.fn(() => Promise.resolve([])),
  localListDir: vi.fn(),
  vscodeAvailable: vi.fn(() => Promise.resolve(false)),
  openWindow: (...args: unknown[]) => openWindow(...args),
  sendHandoffToWindow: (...args: unknown[]) => sendHandoffToWindow(...args),
  claimSession: (...args: unknown[]) => claimSession(...args),
  releaseSession: (...args: unknown[]) => releaseSession(...args),
  takePendingHandoffs: (...args: unknown[]) => takePendingHandoffs(...args),
}));

import { useAppStore } from "./appStore";
import { getAllLeaves } from "@/utils/panelTree";
import type { TabHandoffRecord } from "@/types/window";
import type { TransferState } from "@/types/connection";

/**
 * Transfer-Queue ownership across a window move (#2229, region-authoritative).
 *
 * The persistent Transfer Queue lives in the shared, authoritative `transfers`
 * region since #2229, so it is **no longer carried** across the window boundary —
 * every window already sees the same rows. These tests cover what remains
 * per-window: the tab hand-off still releases the moved session's **transient**
 * `transfers` map rows (#1951 / #1964), and hydrate un-releases the session so the
 * destination resumes folding its live progress into the transient map.
 */

/** Seed one live terminal tab (with a backend session id) and return its ids. */
function seedLiveTab(sessionId: string): { tabId: string; panelId: string } {
  useAppStore.getState().addTab("bash", "local");
  const leaf = getAllLeaves(useAppStore.getState().rootPanel)[0];
  const tabId = leaf.tabs[0].id;
  useAppStore.getState().setTabSessionId(tabId, sessionId);
  return { tabId, panelId: leaf.id };
}

function liveTransfer(overrides: Partial<TransferState> = {}): TransferState {
  return {
    transferId: "t1",
    sessionId: "sess-1",
    direction: "download",
    fileName: "file.txt",
    transferred: 10,
    total: 100,
    phase: "transferring",
    ...overrides,
  };
}

describe("appStore — transient transfer ownership follows a moved tab (#1951 / #2229)", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    openWindow.mockReset();
    sendHandoffToWindow.mockReset();
    claimSession.mockReset();
    releaseSession.mockReset();
    takePendingHandoffs.mockReset();
    openWindow.mockResolvedValue("win-1");
    sendHandoffToWindow.mockResolvedValue(undefined);
    claimSession.mockResolvedValue(null);
    releaseSession.mockResolvedValue(true);
    takePendingHandoffs.mockResolvedValue([]);
  });

  describe("source side — moveTabToWindow", () => {
    it("carries no queue rows in the hand-off record (the region is shared)", async () => {
      const { tabId, panelId } = seedLiveTab("sess-1");

      await useAppStore.getState().moveTabToWindow(tabId, panelId, { kind: "new" });

      const record = openWindow.mock.calls[0][0] as TabHandoffRecord;
      // The `transfers` field was removed from the hand-off envelope entirely.
      expect((record.tab as { transfers?: unknown }).transfers).toBeUndefined();
    });

    it("releases the moved session and suppresses its transient rows from a later event", async () => {
      const { tabId, panelId } = seedLiveTab("sess-1");

      await useAppStore.getState().moveTabToWindow(tabId, panelId, { kind: "new" });

      expect(useAppStore.getState().releasedTransferSessions).toContain("sess-1");

      // The transient in-flight map is suppressed for the moved session.
      useAppStore
        .getState()
        .applyTransferProgress(liveTransfer({ transferId: "t1", sessionId: "sess-1" }));
      expect(useAppStore.getState().transfers["t1"]).toBeUndefined();
    });

    it("removes the moved session's transient in-flight rows from the source", async () => {
      const { tabId, panelId } = seedLiveTab("sess-1");
      useAppStore
        .getState()
        .applyTransferProgress(liveTransfer({ transferId: "t1", sessionId: "sess-1" }));
      useAppStore
        .getState()
        .applyTransferProgress(liveTransfer({ transferId: "keep", sessionId: "sess-other" }));
      expect(useAppStore.getState().transfers["t1"]).toBeDefined();

      await useAppStore.getState().moveTabToWindow(tabId, panelId, { kind: "new" });

      expect(useAppStore.getState().transfers["t1"]).toBeUndefined();
      expect(useAppStore.getState().transfers["keep"]).toBeDefined();
    });

    it("still releases the session when the tab has no transfers", async () => {
      const { tabId, panelId } = seedLiveTab("sess-1");

      await useAppStore.getState().moveTabToWindow(tabId, panelId, { kind: "new" });

      const record = openWindow.mock.calls[0][0] as TabHandoffRecord;
      expect((record.tab as { transfers?: unknown }).transfers).toBeUndefined();
      // The session left this window, so a transfer that starts on it later
      // (in the destination) must not be adopted here from a broadcast event.
      expect(useAppStore.getState().releasedTransferSessions).toEqual(["sess-1"]);
    });
  });

  describe("destination side — hydrateHandoffTab", () => {
    it("un-releases the moved session so the transient map resumes folding", () => {
      // Simulate the destination window having previously released this session.
      useAppStore.setState({ releasedTransferSessions: ["sess-1"] });
      const record: TabHandoffRecord = {
        tab: {
          sessionId: "sess-1",
          title: "moved",
          connectionType: "ssh",
          contentType: "terminal",
          config: { type: "ssh", config: {} } as never,
        },
      };

      useAppStore.getState().hydrateHandoffTab(record);

      expect(useAppStore.getState().releasedTransferSessions).not.toContain("sess-1");

      // A live progress event for the un-released session now folds again.
      useAppStore
        .getState()
        .applyTransferProgress(liveTransfer({ transferId: "t1", sessionId: "sess-1" }));
      expect(useAppStore.getState().transfers["t1"]).toBeDefined();
    });
  });

  describe("whole-window move — moveWindowSessionsToWindow", () => {
    it("builds a record per tab without carrying any queue rows", async () => {
      const { tabId } = seedLiveTab("sess-1");
      // Add a second live tab in a fresh panel/leaf.
      useAppStore.getState().addTab("bash", "local");
      const leaves = getAllLeaves(useAppStore.getState().rootPanel);
      const secondTab = leaves.flatMap((l) => l.tabs).find((t) => t.id !== tabId)!;
      useAppStore.getState().setTabSessionId(secondTab.id, "sess-2");

      await useAppStore.getState().moveWindowSessionsToWindow({ kind: "new" });

      const firstRecord = openWindow.mock.calls[0][0] as TabHandoffRecord;
      const restRecords = sendHandoffToWindow.mock.calls.map((c) => c[1] as TabHandoffRecord);
      for (const r of [firstRecord, ...restRecords]) {
        expect((r.tab as { transfers?: unknown }).transfers).toBeUndefined();
      }
    });
  });
});
