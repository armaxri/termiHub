import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * TFE-005 — error / rejection / guard-branch coverage for the actions that
 * REMAIN defined directly in `appStore.ts` (the deferred tab/panel-tree layout
 * ops + session-lifecycle core + workspace launch/restore + last-session save).
 *
 * The audit flagged `appStore.ts` at ~66% branch coverage: roughly a third of
 * its error/rejection paths were untested. These tests drive `useAppStore`
 * directly, mock the service boundary, and pin the previously-dark branches:
 * API/backend rejections, optimistic-rollback paths, and the "unknown id /
 * empty / no-active-tab" guards that used to `return` (or `return state`)
 * silently. Actions that already live in `src/store/slices/*` are intentionally
 * out of scope (they carry their own coverage) — everything here is still in
 * `appStore.ts`.
 */

// ── Service-boundary mocks ──────────────────────────────────────────────────

const {
  mockStartPersistentSession,
  mockStopPersistentSession,
  mockAttachPersistentTab,
  mockAdoptPersistentSession,
  mockCloseTerminal,
  mockReleaseSession,
  mockOpenWindow,
  mockSendHandoffToWindow,
} = vi.hoisted(() => ({
  mockStartPersistentSession: vi.fn().mockResolvedValue("mock-session-id"),
  mockStopPersistentSession: vi.fn().mockResolvedValue(undefined),
  mockAttachPersistentTab: vi.fn().mockResolvedValue(1),
  mockAdoptPersistentSession: vi.fn().mockResolvedValue(undefined),
  mockCloseTerminal: vi.fn().mockResolvedValue(undefined),
  mockReleaseSession: vi.fn().mockResolvedValue(undefined),
  mockOpenWindow: vi.fn().mockResolvedValue("window-2"),
  mockSendHandoffToWindow: vi.fn().mockResolvedValue(undefined),
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
  startPersistentSession: mockStartPersistentSession,
  stopPersistentSession: mockStopPersistentSession,
  attachPersistentTab: mockAttachPersistentTab,
  adoptPersistentSession: mockAdoptPersistentSession,
  closeTerminal: mockCloseTerminal,
  detachPersistentTab: vi.fn(() => Promise.resolve()),
  releaseSession: mockReleaseSession,
  claimSession: vi.fn(() => Promise.resolve()),
  listSessionOwners: vi.fn(() => Promise.resolve({})),
  openWindow: mockOpenWindow,
  sendHandoffToWindow: mockSendHandoffToWindow,
  takePendingHandoffs: vi.fn(() => Promise.resolve([])),
  reportWindowLayout: vi.fn(() => Promise.resolve()),
  collectWindowLayouts: vi.fn(() => Promise.resolve([])),
  takePendingWindowRestore: vi.fn(() => Promise.resolve(null)),
}));

vi.mock("@/services/workspaceApi", () => ({
  getWorkspaces: vi.fn(() => Promise.resolve([])),
  loadWorkspace: vi.fn(() => Promise.resolve({})),
  saveWorkspace: vi.fn(() => Promise.resolve()),
  deleteWorkspace: vi.fn(() => Promise.resolve()),
  duplicateWorkspace: vi.fn(() => Promise.resolve("")),
}));

vi.mock("@/services/lastSessionApi", () => ({
  saveLastSession: vi.fn(() => Promise.resolve()),
  loadLastSession: vi.fn(() => Promise.resolve(null)),
  clearLastSession: vi.fn(() => Promise.resolve()),
}));

// The restore-mode decision now lives in core, reached over IPC. Mirror the
// mocked async decision boundary used by the sibling last-session tests.
vi.mock("@/utils/restoreMode", () => ({
  resolveRestoreMode: vi.fn(async () => "ask"),
  summarizeLastSession: vi.fn(async () => ({ tabCount: 0, tabs: [] })),
  filterSessionBySelection: vi.fn(async (session: unknown) => session),
}));

vi.mock("@/components/ui", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    loading: vi.fn(() => "toast-id"),
    promise: vi.fn(),
    dismiss: vi.fn(),
  },
}));

import { useAppStore } from "./appStore";
import { layoutState, seedLayoutState } from "@/test/layoutState";
import { setupConnectionsRegion, seedConnectionsRegion } from "@/test/connectionsHarness";
import { setupSettingsRegion } from "@/test/settingsRegionTestHarness";
import { setupAgentsRegion } from "@/test/agentsRegionTestHarness";
import { getAllLeaves } from "@/utils/panelTree";
import { toast } from "@/components/ui";
import { saveWorkspace as apiSaveWorkspace } from "@/services/workspaceApi";
import { saveLastSession as apiSaveLastSession } from "@/services/lastSessionApi";
import { loadLastSession as apiLoadLastSession } from "@/services/lastSessionApi";
import { clearLastSession as apiClearLastSession } from "@/services/lastSessionApi";
import type { SavedConnection } from "@/types/connection";
import type { PersistentSessionEntry } from "@/types/connection";
import type { AgentDefinitionInfo } from "@/services/api";
import type { LeafPanel, PanelNode, TabGroup } from "@/types/terminal";

setupConnectionsRegion();
setupSettingsRegion();
setupAgentsRegion();

const mockToast = vi.mocked(toast);

function makeConnection(overrides: Partial<SavedConnection> = {}): SavedConnection {
  return {
    id: "conn-1",
    name: "Test Connection",
    config: { type: "local", config: { shell: "bash" } },
    folderId: null,
    ...overrides,
  };
}

function makeAgentDef(overrides: Partial<AgentDefinitionInfo> = {}): AgentDefinitionInfo {
  return {
    id: "def-1",
    name: "Persistent Shell",
    sessionType: "shell",
    config: { shell: "/bin/bash" },
    persistent: true,
    folderId: null,
    ...overrides,
  };
}

/** The single leaf id of the default single-panel layout. */
function activeLeafId(): string {
  return getAllLeaves(layoutState().rootPanel)[0].id;
}

/** A two-leaf horizontal split, so structural ops have a real tree to prune. */
function makeTwoLeafRoot(): { root: PanelNode; leftId: string; rightId: string } {
  const leftId = "leaf-left";
  const rightId = "leaf-right";
  const root: PanelNode = {
    type: "split",
    id: "split-root",
    direction: "horizontal",
    sizes: [50, 50],
    children: [
      { type: "leaf", id: leftId, tabs: [], activeTabId: null } as LeafPanel,
      { type: "leaf", id: rightId, tabs: [], activeTabId: null } as LeafPanel,
    ],
  };
  return { root, leftId, rightId };
}

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState());
  vi.clearAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// Session lifecycle — non-agent persistent sessions
// ─────────────────────────────────────────────────────────────────────────────

describe("appStore — startPersistentSession error/guard branches", () => {
  it("is a no-op when the connection id is unknown (no api call, no entry)", async () => {
    await useAppStore.getState().startPersistentSession("does-not-exist");

    expect(mockStartPersistentSession).not.toHaveBeenCalled();
    expect(useAppStore.getState().persistentSessions["does-not-exist"]).toBeUndefined();
  });

  it("sets 'starting' synchronously, then 'error' with the message on API rejection", async () => {
    seedConnectionsRegion({ connections: [makeConnection({ id: "conn-1" })] });
    let stateDuringCall: PersistentSessionEntry | undefined;
    mockStartPersistentSession.mockImplementationOnce(async () => {
      stateDuringCall = useAppStore.getState().persistentSessions["conn-1"];
      throw new Error("connection refused");
    });

    await useAppStore.getState().startPersistentSession("conn-1");

    expect(stateDuringCall?.state).toBe("starting");
    const entry = useAppStore.getState().persistentSessions["conn-1"];
    expect(entry?.state).toBe("error");
    expect(entry?.errorMessage).toBe("connection refused");
  });

  it("uses String(err) when a non-Error value is thrown", async () => {
    seedConnectionsRegion({ connections: [makeConnection({ id: "conn-1" })] });
    mockStartPersistentSession.mockRejectedValueOnce("plain string failure");

    await useAppStore.getState().startPersistentSession("conn-1");

    const entry = useAppStore.getState().persistentSessions["conn-1"];
    expect(entry?.state).toBe("error");
    expect(entry?.errorMessage).toBe("plain string failure");
  });
});

describe("appStore — attachPersistentSession error/guard branches", () => {
  it("returns early (no tab opened) when no entry exists for the connection", async () => {
    seedConnectionsRegion({ connections: [makeConnection({ id: "conn-1" })] });
    const before = getAllLeaves(layoutState().rootPanel).flatMap((l) => l.tabs).length;

    await useAppStore.getState().attachPersistentSession("conn-1", activeLeafId());

    const after = getAllLeaves(layoutState().rootPanel).flatMap((l) => l.tabs).length;
    expect(after).toBe(before);
    expect(mockAttachPersistentTab).not.toHaveBeenCalled();
  });

  it("returns early when the entry has no sessionId yet", async () => {
    seedConnectionsRegion({ connections: [makeConnection({ id: "conn-1" })] });
    useAppStore.setState({
      persistentSessions: {
        "conn-1": {
          connectionId: "conn-1",
          sessionId: null,
          state: "starting",
          attachedTabIds: [],
        },
      },
    });

    await useAppStore.getState().attachPersistentSession("conn-1", activeLeafId());

    expect(mockAttachPersistentTab).not.toHaveBeenCalled();
  });

  it("logs and leaves attachedTabIds unchanged when attachPersistentTab rejects", async () => {
    seedConnectionsRegion({ connections: [makeConnection({ id: "conn-1" })] });
    useAppStore.setState({
      persistentSessions: {
        "conn-1": {
          connectionId: "conn-1",
          sessionId: "sess-1",
          state: "running",
          attachedTabIds: [],
        },
      },
    });
    mockAttachPersistentTab.mockRejectedValueOnce(new Error("attach failed"));

    await useAppStore.getState().attachPersistentSession("conn-1", activeLeafId());

    // The optimistic tab was still opened, but the failed attach must not record
    // it as attached to the persistent session.
    expect(useAppStore.getState().persistentSessions["conn-1"].attachedTabIds).toEqual([]);
  });
});

describe("appStore — stopPersistentSession error branch", () => {
  it("keeps the 'stopping' state (logs only) when the stop API rejects", async () => {
    useAppStore.setState({
      persistentSessions: {
        "conn-1": {
          connectionId: "conn-1",
          sessionId: "sess-1",
          state: "running",
          attachedTabIds: [],
        },
      },
    });
    mockStopPersistentSession.mockRejectedValueOnce(new Error("stop failed"));

    await useAppStore.getState().stopPersistentSession("conn-1");

    expect(mockStopPersistentSession).toHaveBeenCalledWith("conn-1");
    expect(useAppStore.getState().persistentSessions["conn-1"].state).toBe("stopping");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Session lifecycle — agent persistent sessions
// ─────────────────────────────────────────────────────────────────────────────

const AGENT_ID = "agent-1";
const AGENT_CONN_ID = `${AGENT_ID}:def-1`;

describe("appStore — attachAgentPersistentSession failure rollback", () => {
  it("closes the just-opened tab when attachPersistentTab rejects", async () => {
    useAppStore.setState({
      persistentSessions: {
        [AGENT_CONN_ID]: {
          connectionId: AGENT_CONN_ID,
          sessionId: "agent-sess-1",
          state: "running",
          attachedTabIds: [],
        } satisfies PersistentSessionEntry,
      },
    });
    const before = getAllLeaves(layoutState().rootPanel).flatMap((l) => l.tabs).length;
    mockAttachPersistentTab.mockRejectedValueOnce(new Error("gone"));

    await useAppStore
      .getState()
      .attachAgentPersistentSession(AGENT_ID, makeAgentDef(), activeLeafId());

    const after = getAllLeaves(layoutState().rootPanel).flatMap((l) => l.tabs).length;
    expect(after).toBe(before);
  });
});

describe("appStore — adoptAndAttachAgentPersistentSession guards", () => {
  it("delegates straight to attach (no adopt call) when already mapped to the same session", async () => {
    useAppStore.setState({
      persistentSessions: {
        [AGENT_CONN_ID]: {
          connectionId: AGENT_CONN_ID,
          sessionId: "agent-sess-1",
          state: "running",
          attachedTabIds: [],
        },
      },
    });

    await useAppStore
      .getState()
      .adoptAndAttachAgentPersistentSession(
        AGENT_ID,
        makeAgentDef(),
        "agent-sess-1",
        activeLeafId()
      );

    expect(mockAdoptPersistentSession).not.toHaveBeenCalled();
    expect(mockAttachPersistentTab).toHaveBeenCalledTimes(1);
  });

  it("skips (no adopt, no attach) when a different session is already mapped", async () => {
    useAppStore.setState({
      persistentSessions: {
        [AGENT_CONN_ID]: {
          connectionId: AGENT_CONN_ID,
          sessionId: "other-session",
          state: "running",
          attachedTabIds: [],
        },
      },
    });

    await useAppStore
      .getState()
      .adoptAndAttachAgentPersistentSession(
        AGENT_ID,
        makeAgentDef(),
        "agent-sess-1",
        activeLeafId()
      );

    expect(mockAdoptPersistentSession).not.toHaveBeenCalled();
    expect(mockAttachPersistentTab).not.toHaveBeenCalled();
  });

  it("returns without seeding an entry when the adopt API rejects", async () => {
    mockAdoptPersistentSession.mockRejectedValueOnce(new Error("adopt failed"));

    await useAppStore
      .getState()
      .adoptAndAttachAgentPersistentSession(
        AGENT_ID,
        makeAgentDef(),
        "agent-sess-1",
        activeLeafId()
      );

    expect(mockAdoptPersistentSession).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().persistentSessions[AGENT_CONN_ID]).toBeUndefined();
    expect(mockAttachPersistentTab).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Multi-window session moves
// ─────────────────────────────────────────────────────────────────────────────

describe("appStore — moveTabToWindow error/guard branches", () => {
  it("is a no-op when the tab cannot be found in the source panel", async () => {
    await useAppStore.getState().moveTabToWindow("no-such-tab", "no-such-panel", { kind: "new" });

    expect(mockOpenWindow).not.toHaveBeenCalled();
  });

  it("clears the moving flag and keeps the tab when the hand-off rejects", async () => {
    const tabId = useAppStore.getState().addTab("bash", "local");
    const panelId = activeLeafId();
    useAppStore.getState().setTabSessionId(tabId, "sess-move-1");
    mockOpenWindow.mockRejectedValueOnce(new Error("window spawn failed"));

    await useAppStore.getState().moveTabToWindow(tabId, panelId, { kind: "new" });

    // Hand-off failed → the moving flag must be released so a later close still
    // tears the session down, and the tab must remain in the source window.
    expect(useAppStore.getState().movingSessionIds).not.toContain("sess-move-1");
    const stillPresent = getAllLeaves(layoutState().rootPanel)
      .flatMap((l) => l.tabs)
      .some((t) => t.id === tabId);
    expect(stillPresent).toBe(true);
  });
});

describe("appStore — moveWindowSessionsToWindow error/guard branches", () => {
  it("returns early when the window has no live sessions", async () => {
    await useAppStore.getState().moveWindowSessionsToWindow({ kind: "new" });

    expect(mockOpenWindow).not.toHaveBeenCalled();
  });

  it("clears moving flags and rethrows when the hand-off rejects", async () => {
    const tabId = useAppStore.getState().addTab("bash", "local");
    useAppStore.getState().setTabSessionId(tabId, "sess-win-1");
    mockOpenWindow.mockRejectedValueOnce(new Error("spawn failed"));

    await expect(
      useAppStore.getState().moveWindowSessionsToWindow({ kind: "new" })
    ).rejects.toThrow("spawn failed");

    expect(useAppStore.getState().movingSessionIds).not.toContain("sess-win-1");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tab / panel-tree layout guards
// ─────────────────────────────────────────────────────────────────────────────

describe("appStore — moveTab guards", () => {
  it("is a no-op when source and destination panels are identical", () => {
    const tabId = useAppStore.getState().addTab("bash", "local");
    const panelId = activeLeafId();
    const before = layoutState().rootPanel;

    useAppStore.getState().moveTab(tabId, panelId, panelId, 0);

    expect(layoutState().rootPanel).toEqual(before);
  });

  it("is a no-op when the source panel does not exist", () => {
    const tabId = useAppStore.getState().addTab("bash", "local");
    const before = layoutState().rootPanel;

    useAppStore.getState().moveTab(tabId, "ghost-panel", activeLeafId(), 0);

    expect(layoutState().rootPanel).toEqual(before);
  });

  it("is a no-op when the tab is not in the source panel", () => {
    useAppStore.getState().addTab("bash", "local");
    const panelId = activeLeafId();
    const before = layoutState().rootPanel;

    useAppStore.getState().moveTab("ghost-tab", panelId, panelId, 0);

    expect(layoutState().rootPanel).toEqual(before);
  });
});

describe("appStore — moveTabToGroup guards", () => {
  it("is a no-op when the source panel does not exist", () => {
    const tabId = useAppStore.getState().addTab("bash", "local");
    const mainGroup = layoutState().tabGroups[0].id;
    const otherGroup = useAppStore.getState().addTabGroup("Other");
    // Switch back so the active (source) group is the one holding the tab and the
    // `targetGroupId === activeTabGroupId` early-return guard is not the one hit.
    useAppStore.getState().setActiveTabGroup(mainGroup);
    const before = layoutState().rootPanel;

    useAppStore.getState().moveTabToGroup(tabId, "ghost-panel", otherGroup);

    expect(layoutState().rootPanel).toEqual(before);
  });

  it("is a no-op when the tab is not in the source panel", () => {
    useAppStore.getState().addTab("bash", "local");
    const panelId = activeLeafId();
    const otherGroup = useAppStore.getState().addTabGroup("Other");
    useAppStore.getState().setActiveTabGroup(layoutState().tabGroups[0].id);
    const before = layoutState().rootPanel;

    useAppStore.getState().moveTabToGroup("ghost-tab", panelId, otherGroup);

    expect(layoutState().rootPanel).toEqual(before);
  });

  it("is a no-op when the target group id is unknown", () => {
    const tabId = useAppStore.getState().addTab("bash", "local");
    const panelId = activeLeafId();
    const before = layoutState().rootPanel;

    useAppStore.getState().moveTabToGroup(tabId, panelId, "ghost-group");

    expect(layoutState().rootPanel).toEqual(before);
  });
});

describe("appStore — splitPanel / removePanel guards", () => {
  it("splitPanel is a no-op when there is no active panel", () => {
    // A layout with a live tree but no active panel exercises the `!targetId`
    // guard inside the reducer.
    const { root, leftId } = makeTwoLeafRoot();
    const group: TabGroup = {
      id: "g-1",
      name: "Main",
      rootPanel: root,
      activePanelId: leftId,
    };
    seedLayoutState({ rootPanel: root, tabGroups: [group], activeTabGroupId: "g-1" });
    useAppStore.setState({ layoutView: { ...useAppStore.getState().layoutView } });
    // Force activePanelId to null via a direct compose seed.
    seedLayoutState({ rootPanel: root, activePanelId: null, tabGroups: [group] });
    const before = layoutState().rootPanel;

    useAppStore.getState().splitPanel("horizontal");

    expect(layoutState().rootPanel).toEqual(before);
  });

  it("removePanel is a no-op on a single-leaf layout", () => {
    const before = layoutState().rootPanel;

    useAppStore.getState().removePanel(activeLeafId());

    expect(layoutState().rootPanel).toEqual(before);
  });

  it("removePanel is a no-op when the panel id is unknown (multi-leaf layout)", () => {
    const { root, leftId } = makeTwoLeafRoot();
    const group: TabGroup = { id: "g-1", name: "Main", rootPanel: root, activePanelId: leftId };
    seedLayoutState({ rootPanel: root, tabGroups: [group], activeTabGroupId: "g-1" });
    const before = layoutState().rootPanel;

    useAppStore.getState().removePanel("ghost-panel");

    expect(layoutState().rootPanel).toEqual(before);
  });
});

describe("appStore — splitPanelWithTab guards and edge-drop path", () => {
  it("center-drop is a no-op when the source panel is missing", () => {
    const { root, leftId } = makeTwoLeafRoot();
    const group: TabGroup = { id: "g-1", name: "Main", rootPanel: root, activePanelId: leftId };
    seedLayoutState({ rootPanel: root, tabGroups: [group], activeTabGroupId: "g-1" });
    const before = layoutState().rootPanel;

    useAppStore.getState().splitPanelWithTab("ghost-tab", "ghost-panel", leftId, "center");

    expect(layoutState().rootPanel).toEqual(before);
  });

  it("edge-drop splits the target into a new panel carrying the moved tab", () => {
    // Two leaves, a tab in the left leaf; drop it onto the right leaf's edge.
    const tabId = useAppStore.getState().addTab("bash", "local");
    const sourceId = activeLeafId();
    useAppStore.getState().splitPanel("horizontal");
    const leaves = getAllLeaves(layoutState().rootPanel);
    const targetId = leaves.find((l) => l.id !== sourceId)!.id;

    useAppStore.getState().splitPanelWithTab(tabId, sourceId, targetId, "right");

    // The moved tab now lives in a freshly-split leaf and is the active panel.
    const movedLeaf = getAllLeaves(layoutState().rootPanel).find((l) =>
      l.tabs.some((t) => t.id === tabId)
    );
    expect(movedLeaf).toBeDefined();
    expect(layoutState().activePanelId).toBe(movedLeaf!.id);
  });

  it("edge-drop is a no-op when the tab is not in the source panel", () => {
    const { root, leftId, rightId } = makeTwoLeafRoot();
    const group: TabGroup = { id: "g-1", name: "Main", rootPanel: root, activePanelId: leftId };
    seedLayoutState({ rootPanel: root, tabGroups: [group], activeTabGroupId: "g-1" });
    const before = layoutState().rootPanel;

    useAppStore.getState().splitPanelWithTab("ghost-tab", leftId, rightId, "right");

    expect(layoutState().rootPanel).toEqual(before);
  });
});

describe("appStore — setActiveTabGroup unknown-group guard", () => {
  it("is a no-op when the group id is unknown", () => {
    const originalActive = layoutState().activeTabGroupId;

    useAppStore.getState().setActiveTabGroup("ghost-group");

    expect(layoutState().activeTabGroupId).toBe(originalActive);
  });
});

describe("appStore — closeTab cleanup branches", () => {
  it("removes the closed tab from a persistent session's attachedTabIds", () => {
    const tabId = useAppStore.getState().addTab("bash", "local");
    const panelId = activeLeafId();
    useAppStore.setState({
      persistentSessions: {
        "conn-1": {
          connectionId: "conn-1",
          sessionId: "sess-1",
          state: "running",
          attachedTabIds: [tabId],
        },
      },
    });

    useAppStore.getState().closeTab(tabId, panelId);

    expect(useAppStore.getState().persistentSessions["conn-1"].attachedTabIds).toEqual([]);
  });

  it("prunes the emptied leaf and repoints focus when closing the last tab of a non-sole panel", () => {
    // Left leaf holds one tab; closing it empties the leaf, which must be pruned
    // (multi-leaf tree) and focus repointed to the survivor.
    const tabId = "tab-a";
    const leftId = "leaf-left";
    const rightId = "leaf-right";
    const root: PanelNode = {
      type: "split",
      id: "split-root",
      direction: "horizontal",
      sizes: [50, 50],
      children: [
        {
          type: "leaf",
          id: leftId,
          tabs: [
            {
              id: tabId,
              title: "A",
              connectionType: "local",
              config: { type: "local", config: {} },
              panelId: leftId,
              isActive: true,
              contentType: "terminal",
            },
          ],
          activeTabId: tabId,
        } as LeafPanel,
        { type: "leaf", id: rightId, tabs: [], activeTabId: null } as LeafPanel,
      ],
    };
    const group: TabGroup = { id: "g-1", name: "Main", rootPanel: root, activePanelId: leftId };
    seedLayoutState({
      rootPanel: root,
      tabGroups: [group],
      activeTabGroupId: "g-1",
      activePanelId: leftId,
    });

    useAppStore.getState().closeTab(tabId, leftId);

    const leaves = getAllLeaves(layoutState().rootPanel);
    expect(leaves.some((l) => l.id === leftId)).toBe(false);
    expect(layoutState().activePanelId).toBe(rightId);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Workspace + last-session save/restore error paths
// ─────────────────────────────────────────────────────────────────────────────

describe("appStore — saveCurrentAsWorkspace", () => {
  it("saves only the active group under 'active' scope with a windows[] slice", async () => {
    await useAppStore.getState().saveCurrentAsWorkspace("Just Active", "active", undefined);

    expect(apiSaveWorkspace).toHaveBeenCalledTimes(1);
    const def = vi.mocked(apiSaveWorkspace).mock.calls[0][0] as {
      tabGroups: unknown[];
      name: string;
    };
    expect(def.tabGroups).toHaveLength(1);
    expect(def.name).toBe("Just Active");
    expect(useAppStore.getState().activeWorkspaceName).toBe("Just Active");
  });

  it("rethrows and does not record the active name when the save API rejects", async () => {
    vi.mocked(apiSaveWorkspace).mockRejectedValueOnce(new Error("disk full"));

    await expect(
      useAppStore.getState().saveCurrentAsWorkspace("Broken", "all", undefined)
    ).rejects.toThrow("disk full");

    expect(useAppStore.getState().activeWorkspaceName).not.toBe("Broken");
  });
});

describe("appStore — saveLastSession / clearLastSession error branches", () => {
  it("surfaces a stable-id error toast when the save API rejects", async () => {
    vi.mocked(apiSaveLastSession).mockRejectedValueOnce(new Error("write failed"));

    await useAppStore.getState().saveLastSession();

    expect(mockToast.error).toHaveBeenCalledTimes(1);
    expect(mockToast.error.mock.calls[0][0]).toMatch(/save session/i);
    expect(mockToast.error.mock.calls[0][1]).toMatchObject({ id: "last-session-save-error" });
  });

  it("surfaces an error toast when clearing the saved session rejects", async () => {
    vi.mocked(apiClearLastSession).mockRejectedValueOnce(new Error("clear failed"));

    await useAppStore.getState().clearLastSession();

    expect(mockToast.error).toHaveBeenCalledTimes(1);
    expect(mockToast.error.mock.calls[0][0]).toMatch(/saved session/i);
  });
});

describe("appStore — promptRestore error branch", () => {
  it("surfaces an error toast when loading the last session for the prompt fails", async () => {
    vi.mocked(apiLoadLastSession).mockRejectedValueOnce(new Error("corrupt"));

    await useAppStore.getState().promptRestore();

    expect(useAppStore.getState().restorePrompt).toBeNull();
    expect(mockToast.error).toHaveBeenCalledTimes(1);
    expect(mockToast.error.mock.calls[0][0]).toMatch(/previous session/i);
  });
});
