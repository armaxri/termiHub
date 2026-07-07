import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/services/storage", () => ({
  loadConnections: vi.fn(() =>
    Promise.resolve({ connections: [], folders: [], agents: [], externalErrors: [] })
  ),
  persistConnection: vi.fn(() => Promise.resolve("persisted-id")),
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
  sftpClose: vi.fn(() => Promise.resolve()),
  sftpListDir: vi.fn(() => Promise.resolve([])),
  sftpRealpath: vi.fn(() => Promise.resolve("/home/alice")),
  localListDir: vi.fn(),
  vscodeAvailable: vi.fn(() => Promise.resolve(false)),
}));

import { useAppStore, _resetSftpListSeq } from "./appStore";
import { sftpOpen, sftpClose } from "@/services/api";
import { findLeaf } from "@/utils/panelTree";
import type { LeafPanel } from "@/types/terminal";

const SAMPLE_CONFIG = { host: "example.com", port: 22, username: "alice", password: "pw" };

/**
 * Create a tab via the store and return its generated id, so tests can wire an
 * SFTP session's `owningTabId` to a genuinely-existing tab in the panel tree.
 */
function addTabAndGetId(title: string): string {
  useAppStore.getState().addTab(title, "ssh");
  const state = useAppStore.getState();
  const leaf = findLeaf(state.rootPanel, state.activePanelId!) as LeafPanel;
  return leaf.tabs[leaf.tabs.length - 1].id;
}

describe("appStore — keyed SFTP session map (S1/L1)", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    _resetSftpListSeq();
    vi.clearAllMocks();
    vi.mocked(sftpClose).mockResolvedValue(undefined);
  });

  describe("closeTab closes owned SFTP sessions (the L1 leak fix)", () => {
    it("closes and drops every session owned by the closed tab, leaving others", () => {
      const tabA = addTabAndGetId("Tab A");
      const tabB = addTabAndGetId("Tab B");

      useAppStore.setState({
        sftpSessions: {
          "sess-a": { hostLabel: "alice@a:22", owningTabId: tabA },
          "sess-b": { hostLabel: "bob@b:22", owningTabId: tabB },
        },
      });

      const panelId = useAppStore.getState().activePanelId!;
      useAppStore.getState().closeTab(tabA, panelId);

      expect(sftpClose).toHaveBeenCalledWith("sess-a");
      expect(sftpClose).not.toHaveBeenCalledWith("sess-b");

      const sessions = useAppStore.getState().sftpSessions;
      expect(sessions["sess-a"]).toBeUndefined();
      expect(sessions["sess-b"]).toEqual({ hostLabel: "bob@b:22", owningTabId: tabB });
    });

    it("clears the active browser fields when the closed tab owns the active session", () => {
      const tabA = addTabAndGetId("Tab A");

      useAppStore.setState({
        sftpSessionId: "sess-a",
        sftpConnectedHost: "alice@a:22",
        sftpStatus: "connected",
        sftpSessions: { "sess-a": { hostLabel: "alice@a:22", owningTabId: tabA } },
      });

      const panelId = useAppStore.getState().activePanelId!;
      useAppStore.getState().closeTab(tabA, panelId);

      expect(sftpClose).toHaveBeenCalledWith("sess-a");
      const state = useAppStore.getState();
      expect(state.sftpSessionId).toBeNull();
      expect(state.sftpConnectedHost).toBeNull();
      expect(state.sftpStatus).toBe("idle");
      expect(state.sftpSessions["sess-a"]).toBeUndefined();
    });

    it("leaves SFTP state untouched when the closed tab owns no session", () => {
      const tabA = addTabAndGetId("Tab A");
      const tabB = addTabAndGetId("Tab B");

      useAppStore.setState({
        sftpSessions: { "sess-b": { hostLabel: "bob@b:22", owningTabId: tabB } },
      });

      const panelId = useAppStore.getState().activePanelId!;
      useAppStore.getState().closeTab(tabA, panelId);

      expect(sftpClose).not.toHaveBeenCalled();
      expect(useAppStore.getState().sftpSessions["sess-b"]).toBeDefined();
    });
  });

  describe("connectSftp registration (host switch)", () => {
    it("registers the new session keyed by its UUID with hostLabel + owningTabId", async () => {
      const tabA = addTabAndGetId("Tab A");
      vi.mocked(sftpOpen).mockResolvedValue("sess-a");

      await useAppStore.getState().connectSftp(SAMPLE_CONFIG, tabA);

      const sessions = useAppStore.getState().sftpSessions;
      expect(sessions["sess-a"]).toEqual({
        hostLabel: "alice@example.com:22",
        owningTabId: tabA,
      });
      expect(useAppStore.getState().sftpSessionId).toBe("sess-a");
    });

    it("does NOT silently drop or close a still-owned previous session on host switch", async () => {
      const tabA = addTabAndGetId("Tab A");
      const tabB = addTabAndGetId("Tab B");

      // tabA already has a live SFTP session and is the active browser.
      useAppStore.setState({
        sftpSessionId: "sess-a",
        sftpConnectedHost: "alice@a:22",
        sftpStatus: "connected",
        sftpSessions: { "sess-a": { hostLabel: "alice@a:22", owningTabId: tabA } },
      });

      // Switch the browser to tabB, connecting a second session.
      vi.mocked(sftpOpen).mockResolvedValue("sess-b");
      await useAppStore.getState().connectSftp(SAMPLE_CONFIG, tabB);

      // The still-owned previous session must survive (tabA is still open).
      expect(sftpClose).not.toHaveBeenCalledWith("sess-a");
      const sessions = useAppStore.getState().sftpSessions;
      expect(sessions["sess-a"]).toEqual({ hostLabel: "alice@a:22", owningTabId: tabA });
      expect(sessions["sess-b"]).toEqual({
        hostLabel: "alice@example.com:22",
        owningTabId: tabB,
      });
      expect(useAppStore.getState().sftpSessionId).toBe("sess-b");
    });

    it("closes the previous active session when its owning tab is gone (orphan cleanup)", async () => {
      const tabB = addTabAndGetId("Tab B");

      // Active session owned by a tab that no longer exists in the tree.
      useAppStore.setState({
        sftpSessionId: "sess-gone",
        sftpConnectedHost: "ghost@g:22",
        sftpStatus: "connected",
        sftpSessions: { "sess-gone": { hostLabel: "ghost@g:22", owningTabId: "tab-gone" } },
      });

      vi.mocked(sftpOpen).mockResolvedValue("sess-b");
      await useAppStore.getState().connectSftp(SAMPLE_CONFIG, tabB);

      expect(sftpClose).toHaveBeenCalledWith("sess-gone");
      const sessions = useAppStore.getState().sftpSessions;
      expect(sessions["sess-gone"]).toBeUndefined();
      expect(sessions["sess-b"]).toBeDefined();
    });
  });

  describe("closeSftpSession action", () => {
    it("calls sftpClose(id) and drops the entry", async () => {
      const tabA = addTabAndGetId("Tab A");
      useAppStore.setState({
        sftpSessions: {
          "sess-a": { hostLabel: "alice@a:22", owningTabId: tabA },
          "sess-b": { hostLabel: "bob@b:22", owningTabId: "tab-gone" },
        },
      });

      await useAppStore.getState().closeSftpSession("sess-b");

      expect(sftpClose).toHaveBeenCalledWith("sess-b");
      const sessions = useAppStore.getState().sftpSessions;
      expect(sessions["sess-b"]).toBeUndefined();
      expect(sessions["sess-a"]).toBeDefined();
    });

    it("clears the active browser fields when the killed session is the active one", async () => {
      useAppStore.setState({
        sftpSessionId: "sess-a",
        sftpConnectedHost: "alice@a:22",
        sftpStatus: "connected",
        sftpSessions: { "sess-a": { hostLabel: "alice@a:22", owningTabId: "tab-gone" } },
      });

      await useAppStore.getState().closeSftpSession("sess-a");

      const state = useAppStore.getState();
      expect(state.sftpSessionId).toBeNull();
      expect(state.sftpConnectedHost).toBeNull();
      expect(state.sftpStatus).toBe("idle");
      expect(state.sftpSessions["sess-a"]).toBeUndefined();
    });
  });
});
