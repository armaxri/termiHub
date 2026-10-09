/**
 * Regression tests for #4313 (audit-2026-10 FES2-002 / FES2-007): per-tab and
 * per-session state must be torn down when a tab leaves a window — whether it is
 * closed or moved to another window — and when a tab's session is replaced.
 *
 * - FES2-002: `moveTabToWindow` used to strip the tab from the source tree
 *   without any of `closeTab`'s teardown, leaking every per-tab map entry, the
 *   session-lifecycle record, broadcast membership and the persistent-session
 *   attachment for a tab id that no longer exists in any window.
 * - FES2-007: the session-keyed `sessionCapabilities` / `sessionHighlighting`
 *   maps were never pruned, so they grew with every connect / reconnect.
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

vi.mock("@/themes", () => ({
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(() => vi.fn()),
}));

const openWindow = vi.fn();
const sendHandoffToWindow = vi.fn();
const claimSession = vi.fn();
const releaseSession = vi.fn();

vi.mock("@/services/api", () => ({
  sftpOpen: vi.fn(),
  sftpClose: vi.fn(),
  sftpListDir: vi.fn(),
  localListDir: vi.fn(),
  vscodeAvailable: vi.fn(() => Promise.resolve(false)),
  sessionGetCapabilities: vi.fn(() => Promise.resolve({ monitoring: false, fileBrowser: false })),
  openWindow: (...args: unknown[]) => openWindow(...args),
  sendHandoffToWindow: (...args: unknown[]) => sendHandoffToWindow(...args),
  claimSession: (...args: unknown[]) => claimSession(...args),
  releaseSession: (...args: unknown[]) => releaseSession(...args),
}));

const mirrorSessionIntent = vi.fn();

vi.mock("./sessionBridge", async () => {
  const actual = await vi.importActual<typeof import("./sessionBridge")>("./sessionBridge");
  return {
    ...actual,
    mirrorSessionIntent: (...args: Parameters<typeof actual.mirrorSessionIntent>) => {
      mirrorSessionIntent(...args);
      return actual.mirrorSessionIntent(...args);
    },
  };
});

import { useAppStore, type AppState } from "./appStore";
import { currentBroadcastView, ensureBroadcastSubscribed } from "./broadcastBridge";
import { installBroadcastHarness } from "@/test/broadcastHarness";
import { seedLayoutState, layoutState } from "@/test/layoutState";
import { getAllLeaves } from "@/utils/panelTree";
import type { LeafPanel, TerminalTab } from "@/types/terminal";
import type { TabHandoffRecord } from "@/types/window";

/**
 * Every per-tab `Record<tabId, …>` map in the store, listed independently of the
 * production helper so a map dropped from the helper fails here.
 */
const PER_TAB_MAPS = [
  "tabCwds",
  "tabHorizontalScrolling",
  "editorDirtyTabs",
  "tabColors",
  "tabTerminalOptions",
  "terminalSearchVisible",
  "terminalSpawnErrors",
  "terminalSpawnErrorKinds",
  "terminalRetryCounters",
  "terminalConnectDeadline",
  "terminalViewMode",
  "terminalReattaching",
  "terminalReconnectPrompt",
  "terminalAutoRetryCount",
  "terminalWaitingForAgent",
  "terminalForceFreshReconnect",
] as const satisfies readonly (keyof AppState)[];

function makeTab(id: string, sessionId: string | null): TerminalTab {
  return {
    id,
    sessionId,
    title: id,
    connectionType: "local",
    contentType: "terminal",
    config: { type: "local", config: {} },
    panelId: "leaf-1",
    isActive: id === "moved",
  };
}

/** Seed one leaf holding the given tabs as the active tab group. */
function seedTabs(tabs: TerminalTab[]) {
  const leaf: LeafPanel = { type: "leaf", id: "leaf-1", tabs, activeTabId: tabs[0]?.id ?? null };
  seedLayoutState({ rootPanel: leaf, activePanelId: "leaf-1" });
}

/** Seed a non-empty entry for `tabId` in every per-tab map. */
function seedPerTabState(tabId: string) {
  useAppStore.setState((s) => {
    const patch: Record<string, unknown> = {};
    for (const key of PER_TAB_MAPS) {
      patch[key] = { ...(s[key] as Record<string, unknown>), [tabId]: sampleValue(key) };
    }
    return patch as Partial<AppState>;
  });
}

function sampleValue(key: (typeof PER_TAB_MAPS)[number]): unknown {
  switch (key) {
    case "tabCwds":
      return "/home/user";
    case "tabColors":
      return "#ff0000";
    case "tabTerminalOptions":
      return { fontSize: 14 };
    case "terminalSpawnErrors":
      return "boom";
    case "terminalSpawnErrorKinds":
      return "network";
    case "terminalRetryCounters":
    case "terminalAutoRetryCount":
      return 2;
    case "terminalConnectDeadline":
      return { startedAt: 1, timeoutMs: 1000 };
    case "terminalWaitingForAgent":
      return "agent-1";
    default:
      return true;
  }
}

function seedSessionState(sessionId: string) {
  useAppStore.getState().setSessionCapabilities(sessionId, { monitoring: true, fileBrowser: true });
  useAppStore.getState().setSessionHighlighting(sessionId, false);
}

function seedPersistentAttachment(tabIds: string[]) {
  useAppStore.setState({
    persistentSessions: {
      "conn-1": {
        connectionId: "conn-1",
        sessionId: "sess-moved",
        state: "running",
        attachedTabIds: tabIds,
      },
    },
  });
}

function leftoverMapsFor(tabId: string): string[] {
  const s = useAppStore.getState();
  const maps = [...PER_TAB_MAPS, "tabContent"] as const;
  return maps.filter((k) => tabId in (s[k] as Record<string, unknown>));
}

function sessionRemoveCallsFor(tabId: string): number {
  return mirrorSessionIntent.mock.calls.filter((c) => c[0] === "session.remove" && c[1] === tabId)
    .length;
}

describe("per-tab / per-session state teardown (#4313)", () => {
  let harness: ReturnType<typeof installBroadcastHarness>;

  beforeEach(async () => {
    useAppStore.setState(useAppStore.getInitialState());
    harness = installBroadcastHarness();
    await ensureBroadcastSubscribed();
    openWindow.mockReset().mockResolvedValue("win-1");
    sendHandoffToWindow.mockReset().mockResolvedValue(undefined);
    claimSession.mockReset().mockResolvedValue(null);
    releaseSession.mockReset().mockResolvedValue(true);
    mirrorSessionIntent.mockClear();
  });

  afterEach(() => {
    harness.teardown();
  });

  describe("moveTabToWindow (FES2-002)", () => {
    beforeEach(() => {
      seedTabs([makeTab("moved", "sess-moved"), makeTab("stay", "sess-stay")]);
      seedPerTabState("moved");
      seedPerTabState("stay");
    });

    it("leaves no per-tab map entry for the moved tab in the source window", async () => {
      expect(leftoverMapsFor("moved").length).toBeGreaterThan(0);

      await useAppStore.getState().moveTabToWindow("moved", "leaf-1", { kind: "new" });

      expect(leftoverMapsFor("moved")).toEqual([]);
    });

    it("keeps the per-tab entries of tabs that stay in the source window", async () => {
      await useAppStore.getState().moveTabToWindow("moved", "leaf-1", { kind: "new" });

      expect(leftoverMapsFor("stay")).toEqual([...PER_TAB_MAPS, "tabContent"]);
    });

    it("drops the moved tab's session-lifecycle record", async () => {
      await useAppStore.getState().moveTabToWindow("moved", "leaf-1", { kind: "new" });

      expect(sessionRemoveCallsFor("moved")).toBe(1);
      expect(sessionRemoveCallsFor("stay")).toBe(0);
    });

    it("removes the moved tab from persistent attachedTabIds", async () => {
      seedPersistentAttachment(["moved", "stay"]);

      await useAppStore.getState().moveTabToWindow("moved", "leaf-1", { kind: "new" });

      expect(useAppStore.getState().persistentSessions["conn-1"].attachedTabIds).toEqual(["stay"]);
    });

    it("ends broadcast when the moved tab was the broadcast source", async () => {
      useAppStore.getState().startBroadcast("all", "moved", ["stay"]);

      await useAppStore.getState().moveTabToWindow("moved", "leaf-1", { kind: "new" });

      const v = currentBroadcastView();
      expect(v.active).toBe(false);
      expect(v.targetTabIds).not.toContain("moved");
    });

    it("drops the moved tab from the broadcast targets when it was a target", async () => {
      useAppStore.getState().startBroadcast("all", "stay", ["moved"]);

      await useAppStore.getState().moveTabToWindow("moved", "leaf-1", { kind: "new" });

      const v = currentBroadcastView();
      expect(v.active).toBe(true);
      expect(v.sourceTabId).toBe("stay");
      expect(v.targetTabIds).not.toContain("moved");
    });

    it("drops the moved session's session-keyed entries from the source window", async () => {
      seedSessionState("sess-moved");
      seedSessionState("sess-stay");

      await useAppStore.getState().moveTabToWindow("moved", "leaf-1", { kind: "new" });

      const s = useAppStore.getState();
      expect(s.sessionCapabilities["sess-moved"]).toBeUndefined();
      expect(s.sessionHighlighting["sess-moved"]).toBeUndefined();
      expect(s.sessionCapabilities["sess-stay"]).toBeDefined();
      expect(s.sessionHighlighting["sess-stay"]).toBe(false);
    });

    it("keeps what the destination needs: the session stays alive and owned elsewhere", async () => {
      await useAppStore.getState().moveTabToWindow("moved", "leaf-1", { kind: "new" });

      // The hand-off record still carries the live session for the destination.
      const record = openWindow.mock.calls[0][0] as TabHandoffRecord;
      expect(record.tab.sessionId).toBe("sess-moved");
      // The source neither releases ownership nor un-marks the move — the
      // destination window adopts the still-running session.
      expect(releaseSession).not.toHaveBeenCalled();
      expect(useAppStore.getState().isSessionMoving("sess-moved")).toBe(true);
    });

    it("does not tear anything down when the hand-off fails", async () => {
      openWindow.mockRejectedValueOnce(new Error("no window"));

      await useAppStore.getState().moveTabToWindow("moved", "leaf-1", { kind: "new" });

      expect(leftoverMapsFor("moved")).toEqual([...PER_TAB_MAPS, "tabContent"]);
      expect(sessionRemoveCallsFor("moved")).toBe(0);
    });

    it("a tab that later reuses the moved id inherits no stale state", async () => {
      await useAppStore.getState().moveTabToWindow("moved", "leaf-1", { kind: "new" });

      const tabs = getAllLeaves(layoutState().rootPanel).flatMap((l) => l.tabs);
      seedTabs([...tabs, makeTab("moved", null)]);

      const s = useAppStore.getState();
      for (const key of PER_TAB_MAPS) {
        expect((s[key] as Record<string, unknown>)["moved"]).toBeUndefined();
      }
    });
  });

  describe("closeTab (FES2-007)", () => {
    it("drops the closed tab's session-keyed entries", () => {
      seedTabs([makeTab("a", "sess-a"), makeTab("b", "sess-b")]);
      seedSessionState("sess-a");
      seedSessionState("sess-b");

      useAppStore.getState().closeTab("a", "leaf-1");

      const s = useAppStore.getState();
      expect(s.sessionCapabilities["sess-a"]).toBeUndefined();
      expect(s.sessionHighlighting["sess-a"]).toBeUndefined();
      expect(s.sessionCapabilities["sess-b"]).toBeDefined();
      expect(s.sessionHighlighting["sess-b"]).toBe(false);
    });

    it("keeps session-keyed entries another open tab still shows", () => {
      seedTabs([makeTab("a", "sess-shared"), makeTab("b", "sess-shared")]);
      seedSessionState("sess-shared");

      useAppStore.getState().closeTab("a", "leaf-1");

      const s = useAppStore.getState();
      expect(s.sessionCapabilities["sess-shared"]).toBeDefined();
      expect(s.sessionHighlighting["sess-shared"]).toBe(false);
    });

    it("a reused tab id inherits no stale per-tab state", () => {
      seedTabs([makeTab("a", null), makeTab("b", null)]);
      seedPerTabState("a");

      useAppStore.getState().closeTab("a", "leaf-1");
      seedTabs([makeTab("b", null), makeTab("a", null)]);

      expect(leftoverMapsFor("a")).toEqual(["tabContent"]);
      const s = useAppStore.getState();
      for (const key of PER_TAB_MAPS) {
        expect((s[key] as Record<string, unknown>)["a"]).toBeUndefined();
      }
    });
  });

  describe("session replaced or cleared (FES2-007)", () => {
    beforeEach(() => {
      seedTabs([makeTab("a", "sess-old")]);
      seedSessionState("sess-old");
    });

    it("drops the superseded session's entries when the session id is replaced", () => {
      useAppStore.getState().setTabSessionId("a", "sess-new");

      const s = useAppStore.getState();
      expect(s.sessionCapabilities["sess-old"]).toBeUndefined();
      expect(s.sessionHighlighting["sess-old"]).toBeUndefined();
    });

    it("drops the ended session's entries when the session id is cleared", () => {
      useAppStore.getState().setTabSessionId("a", null);

      const s = useAppStore.getState();
      expect(s.sessionCapabilities["sess-old"]).toBeUndefined();
      expect(s.sessionHighlighting["sess-old"]).toBeUndefined();
    });

    it("keeps the entries when the same session id is re-bound", () => {
      useAppStore.getState().setTabSessionId("a", "sess-old");

      const s = useAppStore.getState();
      expect(s.sessionCapabilities["sess-old"]).toBeDefined();
      expect(s.sessionHighlighting["sess-old"]).toBe(false);
    });

    it("a later session that reuses the old id inherits no stale state", () => {
      useAppStore.getState().setTabSessionId("a", "sess-new");
      useAppStore.getState().setTabSessionId("a", "sess-old");

      const s = useAppStore.getState();
      expect(s.sessionCapabilities["sess-old"]).toBeUndefined();
      expect(s.sessionHighlighting["sess-old"]).toBeUndefined();
    });
  });
});
