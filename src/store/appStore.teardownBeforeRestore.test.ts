/**
 * Regression tests for GAP G1 from the workspace save/restore audit (#1146).
 *
 * `launchWorkspace` and `restoreLastSession` placed the new `tabGroups` /
 * `rootPanel` with a single `set(...)` WITHOUT first tearing down the currently
 * open live sessions. Any live (non-persistent) PTY/SSH/agent session that was
 * open before the launch/restore was dropped from the store and orphaned — it
 * lingered in the Open Connections panel with no tab to reach it.
 *
 * The fix enumerates every leaf across the existing `tabGroups` (the active
 * group's live tree lives in `rootPanel`, the others in `group.rootPanel`) and
 * closes each tab's backend session BEFORE placing the new layout. Persistent
 * sessions are left running on purpose — they are re-adoptable and not orphans.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { PanelNode, TabGroup, TerminalTab } from "@/types/terminal";
import type { WorkspaceDefinition } from "@/types/workspace";
import type { LastSession } from "@/types/lastSession";

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

vi.mock("@/services/workspaceApi", () => ({
  getWorkspaces: vi.fn(() => Promise.resolve([])),
  loadWorkspace: vi.fn(),
  saveWorkspace: vi.fn(() => Promise.resolve()),
  deleteWorkspace: vi.fn(() => Promise.resolve()),
  duplicateWorkspace: vi.fn(() => Promise.resolve("")),
}));

vi.mock("@/services/lastSessionApi", () => ({
  saveLastSession: vi.fn(() => Promise.resolve()),
  loadLastSession: vi.fn(() => Promise.resolve(null)),
  clearLastSession: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/services/api", () => ({
  closeTerminal: vi.fn(() => Promise.resolve()),
  detachPersistentTab: vi.fn(() => Promise.resolve(0)),
  sftpOpen: vi.fn(),
  sftpClose: vi.fn(),
  sftpListDir: vi.fn(),
  localListDir: vi.fn(),
  vscodeAvailable: vi.fn(() => Promise.resolve(false)),
}));

vi.mock("@/components/ui", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    loading: vi.fn(),
    promise: vi.fn(),
    dismiss: vi.fn(),
  },
}));

import { useAppStore } from "./appStore";
import { setupConnectionsRegion, seedConnectionsRegion } from "@/test/connectionsHarness";
import { loadWorkspace as apiLoadWorkspace } from "@/services/workspaceApi";
import { loadLastSession as apiLoadLastSession } from "@/services/lastSessionApi";
import { closeTerminal, detachPersistentTab } from "@/services/api";

const mockLoadWorkspace = vi.mocked(apiLoadWorkspace);
const mockLoadLastSession = vi.mocked(apiLoadLastSession);
const mockCloseTerminal = vi.mocked(closeTerminal);
const mockDetachPersistentTab = vi.mocked(detachPersistentTab);

/** Recursively collect session ids from a panel tree (test-local helper). */
function collectSessionIds(node: PanelNode): string[] {
  if (node.type === "leaf") {
    return node.tabs.map((t) => t.sessionId).filter((s): s is string => s !== null);
  }
  return node.children.flatMap(collectSessionIds);
}

/** Build a leaf tab carrying a live session id. */
function liveTab(id: string, sessionId: string, extra?: Partial<TerminalTab>): TerminalTab {
  return {
    id,
    sessionId,
    title: id,
    connectionType: "local",
    contentType: "terminal",
    config: { type: "local", config: { shell: "bash" } },
    panelId: `panel-${id}`,
    isActive: true,
    ...extra,
  };
}

/** Build a single-leaf panel tree containing the given tabs. */
function leaf(panelId: string, tabs: TerminalTab[]): PanelNode {
  return {
    type: "leaf",
    id: panelId,
    tabs,
    activeTabId: tabs[0]?.id ?? null,
  };
}

/**
 * Seed the store with two live tab groups. The active group's tree is held in
 * the live `rootPanel`; the inactive group's tree is held in `group.rootPanel`,
 * mirroring how the real store carries the active vs. inactive trees.
 */
function seedTwoLiveGroups(): void {
  const activeLeaf = leaf("panel-tab-active", [liveTab("tab-active", "sess-active")]);
  const inactiveLeaf = leaf("panel-tab-inactive", [liveTab("tab-inactive", "sess-inactive")]);

  const groups: TabGroup[] = [
    {
      id: "grp-active",
      name: "Active",
      // The entry in tabGroups for the active group is stale on purpose; the
      // live tree is rootPanel below (matches captureAllTabGroups semantics).
      rootPanel: leaf("panel-stale", []),
      activePanelId: "panel-stale",
    },
    {
      id: "grp-inactive",
      name: "Inactive",
      rootPanel: inactiveLeaf,
      activePanelId: "panel-tab-inactive",
    },
  ];

  useAppStore.setState({
    remoteAgents: [],
    agentDefinitions: {},
    defaultShell: "bash",
    restoreInProgress: false,
    launchingWorkspaceId: null,
    tabGroups: groups,
    activeTabGroupId: "grp-active",
    rootPanel: activeLeaf,
    activePanelId: "panel-tab-active",
  });
  seedConnectionsRegion({ connections: [] });
}

setupConnectionsRegion();

describe("appStore — teardown live sessions before restore/launch (GAP G1, #1146)", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    vi.clearAllMocks();
    mockLoadLastSession.mockResolvedValue(null);
  });

  it("closes every existing live session before launchWorkspace places new tabs", async () => {
    seedTwoLiveGroups();

    const definition: WorkspaceDefinition = {
      id: "ws-new",
      name: "Fresh",
      tabGroups: [
        {
          name: "Group 1",
          layout: { type: "leaf", tabs: [{ inlineConfig: { type: "shell", config: {} } }] },
        },
      ],
    };
    mockLoadWorkspace.mockResolvedValueOnce(definition);

    await useAppStore.getState().launchWorkspace("ws-new");

    // Both prior live sessions (active-group + inactive-group) were torn down.
    const closed = mockCloseTerminal.mock.calls.map((c) => c[0]).sort();
    expect(closed).toEqual(["sess-active", "sess-inactive"]);

    // And the new layout actually replaced the old one afterwards.
    const state = useAppStore.getState();
    expect(state.activeWorkspaceName).toBe("Fresh");
    const remainingSessions = state.tabGroups.flatMap((g) =>
      collectSessionIds(g.id === state.activeTabGroupId ? state.rootPanel : g.rootPanel)
    );
    expect(remainingSessions).not.toContain("sess-active");
    expect(remainingSessions).not.toContain("sess-inactive");
  });

  it("closes every existing live session before restoreLastSession places new tabs", async () => {
    seedTwoLiveGroups();

    const session: LastSession = {
      version: "1",
      activeGroupIndex: 0,
      tabGroups: [
        {
          name: "Restored",
          layout: {
            type: "leaf",
            tabs: [{ inlineConfig: { type: "local", config: { shell: "bash" } }, title: "Shell" }],
          },
        },
      ],
    };
    mockLoadLastSession.mockResolvedValueOnce(session);

    const ok = await useAppStore.getState().restoreLastSession();
    expect(ok).toBe(true);

    const closed = mockCloseTerminal.mock.calls.map((c) => c[0]).sort();
    expect(closed).toEqual(["sess-active", "sess-inactive"]);
  });

  it("detaches (does not kill) persistent sessions so they can be re-adopted", async () => {
    const persistentTab = liveTab("tab-persist", "sess-persist", {
      persistentConnectionId: "conn-persist",
    });
    useAppStore.setState({
      remoteAgents: [],
      agentDefinitions: {},
      defaultShell: "bash",
      restoreInProgress: false,
      launchingWorkspaceId: null,
      tabGroups: [
        {
          id: "grp-only",
          name: "Only",
          rootPanel: leaf("panel-stale", []),
          activePanelId: "panel-stale",
        },
      ],
      activeTabGroupId: "grp-only",
      rootPanel: leaf("panel-tab-persist", [persistentTab]),
      activePanelId: "panel-tab-persist",
    });
    seedConnectionsRegion({ connections: [] });

    const definition: WorkspaceDefinition = {
      id: "ws-new",
      name: "Fresh",
      tabGroups: [
        {
          name: "Group 1",
          layout: { type: "leaf", tabs: [{ inlineConfig: { type: "shell", config: {} } }] },
        },
      ],
    };
    mockLoadWorkspace.mockResolvedValueOnce(definition);

    await useAppStore.getState().launchWorkspace("ws-new");

    // Persistent session is detached (process kept alive), not force-closed.
    expect(mockCloseTerminal).not.toHaveBeenCalledWith("sess-persist");
    expect(mockDetachPersistentTab).toHaveBeenCalledWith("sess-persist", "tab-persist");
  });

  it("is a no-op teardown when there are no live sessions to close", async () => {
    // Fresh initial state has an empty layout / no sessions.
    const definition: WorkspaceDefinition = {
      id: "ws-new",
      name: "Fresh",
      tabGroups: [
        {
          name: "Group 1",
          layout: { type: "leaf", tabs: [{ inlineConfig: { type: "shell", config: {} } }] },
        },
      ],
    };
    mockLoadWorkspace.mockResolvedValueOnce(definition);

    await useAppStore.getState().launchWorkspace("ws-new");

    expect(mockCloseTerminal).not.toHaveBeenCalled();
    expect(mockDetachPersistentTab).not.toHaveBeenCalled();
  });
});
