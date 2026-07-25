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

// Untyped mocks so their call signatures accept any args (the spread wrappers
// below forward `unknown[]`) and their resolved values are set per-test.
const openWindow = vi.fn();
const sendHandoffToWindow = vi.fn();
const claimSession = vi.fn();
const releaseSession = vi.fn();
const takePendingHandoffs = vi.fn();

vi.mock("@/services/api", () => ({
  sftpOpen: vi.fn(),
  sftpClose: vi.fn(),
  sftpListDir: vi.fn(),
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

  describe("openNewWindow (top-level New Window command #1902)", () => {
    it("opens an empty window with no hand-off record", async () => {
      await useAppStore.getState().openNewWindow();
      expect(openWindow).toHaveBeenCalledTimes(1);
      // No hand-off: the new window boots into the empty-window CTA state.
      expect(openWindow.mock.calls[0][0]).toBeUndefined();
    });

    it("does not throw when window creation fails", async () => {
      openWindow.mockRejectedValueOnce(new Error("no backend"));
      await expect(useAppStore.getState().openNewWindow()).resolves.toBeUndefined();
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

  // #1939: every window claims the sessions it renders, so the Open Connections
  // owning-window badge (#1926) covers every session — not only moved ones.
  describe("ownership claim lifecycle (#1939)", () => {
    it("claims ownership when a tab gains a session (normal open, not a hand-off)", () => {
      seedLiveTab("sess-open");
      // A normally-opened session is claimed for this window, so its badge shows.
      expect(claimSession).toHaveBeenCalledWith("sess-open");
      expect(releaseSession).not.toHaveBeenCalled();
    });

    it("releases ownership when a tab's session is cleared", () => {
      const { tabId } = seedLiveTab("sess-clear");
      claimSession.mockClear();

      useAppStore.getState().setTabSessionId(tabId, null);

      expect(releaseSession).toHaveBeenCalledWith("sess-clear");
      // Clearing does not claim anything new.
      expect(claimSession).not.toHaveBeenCalled();
    });

    it("releases the superseded session and claims the new one on reconnect", () => {
      const { tabId } = seedLiveTab("sess-old");
      claimSession.mockClear();
      releaseSession.mockClear();

      useAppStore.getState().setTabSessionId(tabId, "sess-new");

      expect(releaseSession).toHaveBeenCalledWith("sess-old");
      expect(claimSession).toHaveBeenCalledWith("sess-new");
    });

    it("releases ownership when a live tab is closed", () => {
      const { tabId, panelId } = seedLiveTab("sess-close");
      releaseSession.mockClear();

      useAppStore.getState().closeTab(tabId, panelId);

      expect(releaseSession).toHaveBeenCalledWith("sess-close");
    });

    it("does not release a session mid-move (handshake: destination grants first)", async () => {
      const { tabId, panelId } = seedLiveTab("sess-move");
      releaseSession.mockClear();

      // A move marks the session as moving, then removes the source tab via the
      // move path (not closeTab). The destination window has already claimed, so
      // the source must not release the session out from under it.
      await useAppStore.getState().moveTabToWindow(tabId, panelId, { kind: "new" });

      expect(useAppStore.getState().isSessionMoving("sess-move")).toBe(true);
      expect(releaseSession).not.toHaveBeenCalled();
    });

    it("skips release for a mid-move session even if its tab session is cleared", () => {
      const { tabId } = seedLiveTab("sess-guard");
      useAppStore.setState((s) => ({ movingSessionIds: [...s.movingSessionIds, "sess-guard"] }));
      releaseSession.mockClear();

      // A source Terminal unmount that clears the session id must not release a
      // session that is being adopted by another window.
      useAppStore.getState().setTabSessionId(tabId, null);

      expect(releaseSession).not.toHaveBeenCalled();
    });
  });
});
