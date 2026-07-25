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

const openWindow = vi.fn(() => Promise.resolve("win-1"));
const sendHandoffToWindow = vi.fn(() => Promise.resolve());
const claimSession = vi.fn(() => Promise.resolve(null));
const takePendingHandoffs = vi.fn(() => Promise.resolve([]));

vi.mock("@/services/api", () => ({
  sftpOpen: vi.fn(),
  sftpClose: vi.fn(),
  sftpListDir: vi.fn(),
  localListDir: vi.fn(),
  vscodeAvailable: vi.fn(() => Promise.resolve(false)),
  openWindow: (...args: unknown[]) => openWindow(...args),
  sendHandoffToWindow: (...args: unknown[]) => sendHandoffToWindow(...args),
  claimSession: (...args: unknown[]) => claimSession(...args),
  takePendingHandoffs: (...args: unknown[]) => takePendingHandoffs(...args),
}));

import { useAppStore } from "./appStore";
import { getAllLeaves } from "@/utils/panelTree";
import type { TabHandoffRecord } from "@/types/window";

/** Seed one live terminal tab (with a backend session id) and return its ids. */
function seedLiveTab(sessionId: string): { tabId: string; panelId: string } {
  useAppStore.getState().addTab("bash", "local");
  const leaf = getAllLeaves(useAppStore.getState().rootPanel)[0];
  const tabId = leaf.tabs[0].id;
  useAppStore.getState().setTabSessionId(tabId, sessionId);
  return { tabId, panelId: leaf.id };
}

describe("appStore — multi-window re-parenting seam (#1900)", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    openWindow.mockClear();
    sendHandoffToWindow.mockClear();
    claimSession.mockClear();
    takePendingHandoffs.mockClear();
    takePendingHandoffs.mockResolvedValue([]);
  });

  describe("moveTabToWindow → new window", () => {
    it("opens a window with a hand-off record and removes the tab from the source", async () => {
      const { tabId, panelId } = seedLiveTab("sess-1");

      await useAppStore.getState().moveTabToWindow(tabId, panelId, { kind: "new" });

      // Handed off to a brand-new window with the session anchored.
      expect(openWindow).toHaveBeenCalledTimes(1);
      const record = openWindow.mock.calls[0][0] as TabHandoffRecord;
      expect(record.tab.sessionId).toBe("sess-1");
      expect(record.tab.contentType).toBe("terminal");

      // Removed from the source window's tree.
      const tabs = getAllLeaves(useAppStore.getState().rootPanel).flatMap((l) => l.tabs);
      expect(tabs).toHaveLength(0);
    });

    it("marks the session as moving so the source view does not kill it", async () => {
      const { tabId, panelId } = seedLiveTab("sess-keep");

      await useAppStore.getState().moveTabToWindow(tabId, panelId, { kind: "new" });

      // The moving flag is what the source Terminal's unmount consults to skip
      // closeTerminal — the backend session must survive the move.
      expect(useAppStore.getState().isSessionMoving("sess-keep")).toBe(true);
    });
  });

  describe("moveTabToWindow → existing window", () => {
    it("queues a hand-off for the target window and removes the tab", async () => {
      const { tabId, panelId } = seedLiveTab("sess-2");

      await useAppStore
        .getState()
        .moveTabToWindow(tabId, panelId, { kind: "existing", label: "win-3" });

      expect(sendHandoffToWindow).toHaveBeenCalledTimes(1);
      expect(sendHandoffToWindow.mock.calls[0][0]).toBe("win-3");
      expect(openWindow).not.toHaveBeenCalled();

      const tabs = getAllLeaves(useAppStore.getState().rootPanel).flatMap((l) => l.tabs);
      expect(tabs).toHaveLength(0);
    });
  });

  describe("hydrateHandoffTab (destination side)", () => {
    it("adds the handed-off tab and flags it for scrollback replay", () => {
      const record: TabHandoffRecord = {
        tab: {
          sessionId: "sess-9",
          title: "moved",
          connectionType: "local",
          contentType: "terminal",
          config: { type: "shell", config: {} },
        },
      };

      useAppStore.getState().hydrateHandoffTab(record);

      const tabs = getAllLeaves(useAppStore.getState().rootPanel).flatMap((l) => l.tabs);
      expect(tabs).toHaveLength(1);
      expect(tabs[0].sessionId).toBe("sess-9");
      expect(tabs[0].title).toBe("moved");
      // The fresh xterm repaints history from the ring buffer on attach.
      expect(tabs[0].pendingScrollbackReplay).toBe(true);
    });
  });

  describe("receivePendingHandoffs (boot / nudge drain)", () => {
    it("claims ownership and hydrates each queued record", async () => {
      takePendingHandoffs.mockResolvedValue([
        {
          tab: {
            sessionId: "sess-drain",
            title: "drained",
            connectionType: "local",
            contentType: "terminal",
            config: { type: "shell", config: {} },
          },
        },
      ]);

      await useAppStore.getState().receivePendingHandoffs();

      expect(claimSession).toHaveBeenCalledWith("sess-drain");
      const tabs = getAllLeaves(useAppStore.getState().rootPanel).flatMap((l) => l.tabs);
      expect(tabs.some((t) => t.sessionId === "sess-drain")).toBe(true);
    });
  });
});
