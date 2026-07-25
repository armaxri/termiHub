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
import type { TransferEntry } from "@/types/transfer";
import type { TransferState } from "@/types/connection";

/** Seed one live terminal tab (with a backend session id) and return its ids. */
function seedLiveTab(sessionId: string): { tabId: string; panelId: string } {
  useAppStore.getState().addTab("bash", "local");
  const leaf = getAllLeaves(useAppStore.getState().rootPanel)[0];
  const tabId = leaf.tabs[0].id;
  useAppStore.getState().setTabSessionId(tabId, sessionId);
  return { tabId, panelId: leaf.id };
}

function transfer(overrides: Partial<TransferEntry> = {}): TransferEntry {
  return {
    id: "t1",
    sessionId: "sess-1",
    direction: "download",
    name: "file.txt",
    state: "active",
    transferred: 10,
    totalBytes: 100,
    percent: 10,
    speedBytesPerSec: null,
    updatedAt: 0,
    ...overrides,
  };
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

describe("appStore — transfer-queue ownership follows a moved tab (#1951)", () => {
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
    it("carries the tab's transfer rows in the hand-off and drops them from the source", async () => {
      const { tabId, panelId } = seedLiveTab("sess-1");
      useAppStore.getState().addTransfer(transfer({ id: "t1", sessionId: "sess-1" }));
      useAppStore.getState().addTransfer(transfer({ id: "t2", sessionId: "sess-1", name: "b.txt" }));
      // An unrelated transfer on another session must NOT be carried.
      useAppStore.getState().addTransfer(transfer({ id: "t3", sessionId: "sess-other" }));

      await useAppStore.getState().moveTabToWindow(tabId, panelId, { kind: "new" });

      const record = openWindow.mock.calls[0][0] as TabHandoffRecord;
      const carriedIds = (record.tab.transfers ?? []).map((t) => t.id).sort();
      expect(carriedIds).toEqual(["t1", "t2"]);

      // The moved rows left the source queue; the unrelated row stayed.
      const queue = useAppStore.getState().transferQueue;
      expect(queue["t1"]).toBeUndefined();
      expect(queue["t2"]).toBeUndefined();
      expect(queue["t3"]).toBeDefined();
    });

    it("marks the moved session released so a later broadcast event does not re-adopt it", async () => {
      const { tabId, panelId } = seedLiveTab("sess-1");
      useAppStore.getState().addTransfer(transfer({ id: "t1", sessionId: "sess-1" }));

      await useAppStore.getState().moveTabToWindow(tabId, panelId, { kind: "new" });

      expect(useAppStore.getState().releasedTransferSessions).toContain("sess-1");

      // A progress event that keeps broadcasting after the move must be ignored.
      useAppStore
        .getState()
        .applyTransferProgressToQueue(liveTransfer({ transferId: "t1", sessionId: "sess-1" }));
      expect(useAppStore.getState().transferQueue["t1"]).toBeUndefined();

      // The transient in-flight map is likewise suppressed for the moved session.
      useAppStore.getState().applyTransferProgress(liveTransfer({ transferId: "t1", sessionId: "sess-1" }));
      expect(useAppStore.getState().transfers["t1"]).toBeUndefined();
    });

    it("removes the moved session's transient in-flight rows from the source", async () => {
      const { tabId, panelId } = seedLiveTab("sess-1");
      useAppStore.getState().applyTransferProgress(liveTransfer({ transferId: "t1", sessionId: "sess-1" }));
      useAppStore
        .getState()
        .applyTransferProgress(liveTransfer({ transferId: "keep", sessionId: "sess-other" }));
      expect(useAppStore.getState().transfers["t1"]).toBeDefined();

      await useAppStore.getState().moveTabToWindow(tabId, panelId, { kind: "new" });

      expect(useAppStore.getState().transfers["t1"]).toBeUndefined();
      expect(useAppStore.getState().transfers["keep"]).toBeDefined();
    });

    it("carries transfers on an SFTP sidebar session bound to the tab via owningTabId", async () => {
      const { tabId, panelId } = seedLiveTab("term-1");
      // SFTP sidebar runs on a separate session id, bound to the tab.
      useAppStore.setState({
        sftpSessions: { "sftp-1": { hostLabel: "alice@host:22", owningTabId: tabId } },
      });
      useAppStore.getState().addTransfer(transfer({ id: "t1", sessionId: "sftp-1" }));

      await useAppStore.getState().moveTabToWindow(tabId, panelId, { kind: "new" });

      const record = openWindow.mock.calls[0][0] as TabHandoffRecord;
      expect((record.tab.transfers ?? []).map((t) => t.id)).toEqual(["t1"]);
      expect(useAppStore.getState().transferQueue["t1"]).toBeUndefined();
      expect(useAppStore.getState().releasedTransferSessions).toContain("sftp-1");
    });

    it("attaches no transfers field when the tab has none, but still releases the session", async () => {
      const { tabId, panelId } = seedLiveTab("sess-1");

      await useAppStore.getState().moveTabToWindow(tabId, panelId, { kind: "new" });

      const record = openWindow.mock.calls[0][0] as TabHandoffRecord;
      expect(record.tab.transfers).toBeUndefined();
      // The session left this window, so a transfer that starts on it later
      // (in the destination) must not be adopted here from a broadcast event.
      expect(useAppStore.getState().releasedTransferSessions).toEqual(["sess-1"]);
    });
  });

  describe("destination side — hydrateHandoffTab", () => {
    it("seeds carried transfers into this window's queue and un-releases the session", () => {
      // Simulate the destination window having previously released this session.
      useAppStore.setState({ releasedTransferSessions: ["sess-1"] });
      const record: TabHandoffRecord = {
        tab: {
          sessionId: "sess-1",
          title: "moved",
          connectionType: "ssh",
          contentType: "terminal",
          config: { type: "ssh", config: {} } as never,
          transfers: [transfer({ id: "t1", sessionId: "sess-1" })],
        },
      };

      useAppStore.getState().hydrateHandoffTab(record);

      expect(useAppStore.getState().transferQueue["t1"]).toMatchObject({ id: "t1", state: "active" });
      expect(useAppStore.getState().releasedTransferSessions).not.toContain("sess-1");
    });

    it("does not clobber a row a broadcast event already advanced in this window", () => {
      // Destination already saw a fresher progress event for the same id.
      useAppStore.getState().addTransfer(transfer({ id: "t1", sessionId: "sess-1", transferred: 90 }));
      const record: TabHandoffRecord = {
        tab: {
          sessionId: "sess-1",
          title: "moved",
          connectionType: "ssh",
          contentType: "terminal",
          config: { type: "ssh", config: {} } as never,
          transfers: [transfer({ id: "t1", sessionId: "sess-1", transferred: 10 })],
        },
      };

      useAppStore.getState().hydrateHandoffTab(record);

      // The existing (further-along) row wins over the carried snapshot.
      expect(useAppStore.getState().transferQueue["t1"].transferred).toBe(90);
    });
  });

  describe("round trip and re-ownership", () => {
    it("lets the destination fold live progress after hydrate", () => {
      const record: TabHandoffRecord = {
        tab: {
          sessionId: "sess-1",
          title: "moved",
          connectionType: "ssh",
          contentType: "terminal",
          config: { type: "ssh", config: {} } as never,
          transfers: [transfer({ id: "t1", sessionId: "sess-1", transferred: 10 })],
        },
      };
      useAppStore.getState().hydrateHandoffTab(record);

      useAppStore
        .getState()
        .applyTransferProgressToQueue(liveTransfer({ transferId: "t1", sessionId: "sess-1", transferred: 55 }));

      expect(useAppStore.getState().transferQueue["t1"].transferred).toBe(55);
    });

    it("un-releases a session when a new local transfer is seeded for it", () => {
      useAppStore.setState({ releasedTransferSessions: ["sess-1"] });

      useAppStore.getState().seedTransferQueue({
        id: "new-1",
        sessionId: "sess-1",
        direction: "upload",
        name: "up.txt",
      });

      expect(useAppStore.getState().releasedTransferSessions).not.toContain("sess-1");
      expect(useAppStore.getState().transferQueue["new-1"]).toBeDefined();
    });
  });

  describe("whole-window move — moveWindowSessionsToWindow", () => {
    it("carries each tab's transfers to the destination", async () => {
      const { tabId } = seedLiveTab("sess-1");
      // Add a second live tab in a fresh panel/leaf.
      useAppStore.getState().addTab("bash", "local");
      const leaves = getAllLeaves(useAppStore.getState().rootPanel);
      const secondTab = leaves.flatMap((l) => l.tabs).find((t) => t.id !== tabId)!;
      useAppStore.getState().setTabSessionId(secondTab.id, "sess-2");

      useAppStore.getState().addTransfer(transfer({ id: "t1", sessionId: "sess-1" }));
      useAppStore.getState().addTransfer(transfer({ id: "t2", sessionId: "sess-2", name: "b.txt" }));

      await useAppStore.getState().moveWindowSessionsToWindow({ kind: "new" });

      // First tab seeds the new window; the rest are queued via sendHandoffToWindow.
      const firstRecord = openWindow.mock.calls[0][0] as TabHandoffRecord;
      const restRecords = sendHandoffToWindow.mock.calls.map((c) => c[1] as TabHandoffRecord);
      const carried = [firstRecord, ...restRecords].flatMap((r) => r.tab.transfers ?? []);
      expect(carried.map((t) => t.id).sort()).toEqual(["t1", "t2"]);
    });
  });
});
