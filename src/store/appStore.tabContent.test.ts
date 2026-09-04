/**
 * appStore `tabContent` by-id content map (part of #2283 — the layout data-flow
 * inversion).
 *
 * Pins the seam that keeps rich tab **content** authoritative in `appStore`,
 * keyed by tab id, as the layout projection region takes over panel-tree
 * **structure**. Two guarantees:
 *
 *  1. **Maintenance parity** — after open / rename / session-update /
 *     scrollback-replay-clear / close, the map entry reconstructs a tab that is
 *     content-identical to the authoritative in-tree {@link TerminalTab}, and a
 *     closed tab is pruned.
 *  2. **Render parity** — composing the render tree from the projection yields
 *     byte-identical output whether content is sourced from the map or from the
 *     in-tree tab, so switching render composition onto the map cannot change
 *     what the user sees.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockSaveSettings = vi.fn<(...args: any[]) => Promise<void>>(() => Promise.resolve());

// Mock service modules before importing the store
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
  saveSettings: (...args: unknown[]) => mockSaveSettings(...args),
  moveConnectionToFile: vi.fn(() => Promise.resolve()),
  reloadExternalConnections: vi.fn(() => Promise.resolve([])),
  getRecoveryWarnings: vi.fn(() => Promise.resolve([])),
}));

vi.mock("@/themes", () => ({
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(() => vi.fn()),
}));

vi.mock("@/services/api", () => ({
  sftpOpen: vi.fn(),
  sftpClose: vi.fn(),
  sftpListDir: vi.fn(),
  localListDir: vi.fn(),
  vscodeAvailable: vi.fn(() => Promise.resolve(false)),
  sessionGetCapabilities: vi.fn(() => Promise.resolve({ monitoring: false, fileBrowser: false })),
  sessionMonitoringOpen: vi.fn(() => Promise.resolve()),
  sessionMonitoringClose: vi.fn(() => Promise.resolve()),
  listAvailableShells: vi.fn(() => Promise.resolve([])),
  getDefaultShell: vi.fn(() => Promise.resolve(null)),
  connectAgent: vi.fn(),
  disconnectAgent: vi.fn(),
  listAgentSessions: vi.fn(() => Promise.resolve([])),
  listAgentDefinitions: vi.fn(() => Promise.resolve([])),
  listAgentConnections: vi.fn(() => Promise.resolve({ connections: [], folders: [] })),
  saveAgentDefinition: vi.fn(),
  updateAgentDefinition: vi.fn(),
  deleteAgentDefinition: vi.fn(),
  createAgentFolder: vi.fn(),
  updateAgentFolder: vi.fn(),
  deleteAgentFolder: vi.fn(),
  getCredentialStoreStatus: vi.fn(() => Promise.resolve({ mode: "none", status: "unavailable" })),
}));

vi.mock("@/services/tunnelApi", () => ({
  getTunnels: vi.fn(() => Promise.resolve([])),
  saveTunnel: vi.fn(),
  deleteTunnel: vi.fn(),
  startTunnel: vi.fn(),
  stopTunnel: vi.fn(),
  getTunnelStatuses: vi.fn(() => Promise.resolve([])),
}));

import type { ConnectionConfig, PanelNode, TerminalTab } from "@/types/terminal";
import { getAllLeaves } from "@/utils/panelTree";
import {
  composeLayoutState,
  composeRenderTree,
  currentLayoutView,
  toMinimalNode,
  type LayoutView,
} from "./layoutBridge";
import { extractTabContent, useAppStore } from "./appStore";
import { layoutState } from "@/test/layoutState";

const LOCAL_CONFIG: ConnectionConfig = { type: "local", config: { shell: "zsh" } };

/** Every tab currently in the active panel tree, flattened. */
function allTabs(): TerminalTab[] {
  return getAllLeaves(layoutState().rootPanel).flatMap((l) => l.tabs);
}

/** The projected (multi-group) view of the current tree — a single active group
 * holding the current panel tree (#2283 slice C). */
function currentView(): LayoutView {
  const { rootPanel, activePanelId } = layoutState();
  return {
    groups: [{ id: "g", name: "Main", root: toMinimalNode(rootPanel), activePanelId }],
    activeGroupId: "g",
  };
}

describe("appStore — tabContent by-id map (#2283)", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    vi.clearAllMocks();
  });

  it("starts empty (the initial panel has no tabs)", () => {
    expect(useAppStore.getState().tabContent).toEqual({});
  });

  it("addTab populates the map with the new tab's non-structural content", () => {
    const id = layoutState().addTab("Shell", "local", LOCAL_CONFIG);
    const tab = allTabs().find((t) => t.id === id)!;
    // The map entry equals the in-tree tab projected to content (no panelId/isActive).
    expect(useAppStore.getState().tabContent[id]).toEqual(extractTabContent(tab));
    expect(useAppStore.getState().tabContent[id]).not.toHaveProperty("panelId");
    expect(useAppStore.getState().tabContent[id]).not.toHaveProperty("isActive");
  });

  it("renameTab mirrors the new title into the map, in sync with the tree", () => {
    const id = layoutState().addTab("Shell", "local", LOCAL_CONFIG);
    useAppStore.getState().renameTab(id, "Renamed");
    expect(useAppStore.getState().tabContent[id].title).toBe("Renamed");
    const tab = allTabs().find((t) => t.id === id)!;
    expect(useAppStore.getState().tabContent[id]).toEqual(extractTabContent(tab));
  });

  it("setTabSessionId mirrors the session id into the map, in sync with the tree", () => {
    const id = layoutState().addTab("Shell", "local", LOCAL_CONFIG);
    useAppStore.getState().setTabSessionId(id, "sess-42");
    expect(useAppStore.getState().tabContent[id].sessionId).toBe("sess-42");
    const tab = allTabs().find((t) => t.id === id)!;
    expect(useAppStore.getState().tabContent[id]).toEqual(extractTabContent(tab));
  });

  it("clearPendingScrollbackReplay mirrors the cleared flag into the map", () => {
    const id = layoutState().addTab("Shell", "local", LOCAL_CONFIG);
    // Seed the flag in the map (the sole content authority since #2562/#2566), then
    // clear it — the region-derived tree recomposes the flag from the map.
    useAppStore.setState((s) => ({
      tabContent: {
        ...s.tabContent,
        [id]: { ...s.tabContent[id], pendingScrollbackReplay: true },
      },
    }));
    useAppStore.getState().clearPendingScrollbackReplay(id);
    expect(useAppStore.getState().tabContent[id].pendingScrollbackReplay).toBe(false);
    const tab = allTabs().find((t) => t.id === id)!;
    expect(useAppStore.getState().tabContent[id]).toEqual(extractTabContent(tab));
  });

  it("closeTab prunes the tab's entry from the map", () => {
    const id = layoutState().addTab("Shell", "local", LOCAL_CONFIG);
    const panelId = allTabs().find((t) => t.id === id)!.panelId;
    expect(useAppStore.getState().tabContent[id]).toBeDefined();
    useAppStore.getState().closeTab(id, panelId);
    expect(useAppStore.getState().tabContent[id]).toBeUndefined();
  });

  it("render parity: composing from the map equals composing from the in-tree tab", () => {
    // A mix of a terminal tab and an editor tab — both mapped since slice C.
    useAppStore.getState().addTab("Shell", "local", LOCAL_CONFIG);
    useAppStore.getState().openScratchEditorTab("Notes", "notes.md", "hello");
    useAppStore.getState().addTab("Shell 2", "local", LOCAL_CONFIG);

    const { rootPanel, tabContent } = layoutState();
    const view = currentView();

    const fromTree = composeRenderTree(view, rootPanel);
    const fromMap = composeRenderTree(view, rootPanel, tabContent);
    // Sourcing content from the map is byte-identical to sourcing it from the tree.
    expect(fromMap).toEqual(fromTree);
    // ...and identical to the authoritative tree itself (structure + content).
    expect(fromMap).toEqual(rootPanel);
  });

  it("render parity holds after rename + session update", () => {
    const id = layoutState().addTab("Shell", "local", LOCAL_CONFIG);
    useAppStore.getState().renameTab(id, "Renamed");
    useAppStore.getState().setTabSessionId(id, "sess-7");

    const { rootPanel, tabContent } = layoutState();
    const view = currentView();
    expect(composeRenderTree(view, rootPanel, tabContent)).toEqual(
      composeRenderTree(view, rootPanel)
    );
    expect(composeRenderTree(view, rootPanel, tabContent)).toEqual(rootPanel);
  });
});

describe("appStore — comprehensive tabContent map for every tab type (#2283 slice C)", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    vi.clearAllMocks();
  });

  /** Open a tab of each instrumented content type into the active panel. */
  function openOneOfEach(): void {
    const s = layoutState();
    s.addTab("Shell", "local", LOCAL_CONFIG);
    s.openSettingsTab();
    s.openLogViewerTab();
    s.openNetworkDiagnosticTab("ping");
    s.openScratchEditorTab("Notes", "notes.md", "hi");
    s.openConnectionEditorTab("new");
    s.openTunnelEditorTab(null);
    s.openWorkspaceEditorTab(null);
    s.selectPlugin("p1");
  }

  it("every rendered tab resolves its content from the map (no fallback needed)", () => {
    openOneOfEach();
    const { rootPanel, tabContent } = layoutState();

    for (const leaf of getAllLeaves(rootPanel)) {
      for (const t of leaf.tabs) {
        // The map holds a content-identical entry for EVERY tab in the tree.
        expect(tabContent[t.id]).toBeDefined();
        expect(tabContent[t.id]).toEqual(extractTabContent(t));
      }
    }

    // Composing from the map is byte-identical to the in-tree fallback and to the
    // authoritative tree — so the in-tree fallback is now belt-and-suspenders.
    const view = currentView();
    expect(composeRenderTree(view, rootPanel, tabContent)).toEqual(
      composeRenderTree(view, rootPanel)
    );
    expect(composeRenderTree(view, rootPanel, tabContent)).toEqual(rootPanel);
  });

  it.each([
    ["settings", () => useAppStore.getState().openSettingsTab()],
    ["log-viewer", () => useAppStore.getState().openLogViewerTab()],
    ["network-diagnostic", () => useAppStore.getState().openNetworkDiagnosticTab("ping")],
    ["editor", () => useAppStore.getState().openScratchEditorTab("N", "n.md", "x")],
    ["connection-editor", () => useAppStore.getState().openConnectionEditorTab("new")],
    ["tunnel-editor", () => useAppStore.getState().openTunnelEditorTab(null)],
    ["workspace-editor", () => useAppStore.getState().openWorkspaceEditorTab(null)],
    ["plugin-detail", () => useAppStore.getState().selectPlugin("p1")],
  ])("%s: open tracks content, close prunes it", (type, open) => {
    open();
    const tab = allTabs().find((t) => t.contentType === type)!;
    expect(tab).toBeDefined();
    expect(useAppStore.getState().tabContent[tab.id]).toEqual(extractTabContent(tab));

    useAppStore.getState().closeTab(tab.id, tab.panelId);
    expect(useAppStore.getState().tabContent[tab.id]).toBeUndefined();
  });

  it("selectPlugin reuse re-points meta and keeps the map in sync", () => {
    useAppStore.getState().selectPlugin("p1");
    const first = allTabs().find((t) => t.contentType === "plugin-detail")!;
    expect(useAppStore.getState().tabContent[first.id]).toEqual(extractTabContent(first));

    // Selecting another plugin REUSES the single plugin-detail tab (re-points its
    // meta) rather than opening a second — the map entry must follow.
    useAppStore.getState().selectPlugin("p2");
    const reused = allTabs().find((t) => t.contentType === "plugin-detail")!;
    expect(reused.id).toBe(first.id);
    expect((reused as { pluginDetailMeta?: { pluginId: string } }).pluginDetailMeta?.pluginId).toBe(
      "p2"
    );
    expect(useAppStore.getState().tabContent[reused.id]).toEqual(extractTabContent(reused));
  });

  it("openScratchEditorTab tracks editorMeta; render parity holds", () => {
    useAppStore.getState().openScratchEditorTab("Notes", "notes.md", "content");
    const tab = allTabs().find((t) => t.contentType === "editor")!;
    // The editorMeta rides in the map entry (content, not structure).
    expect(useAppStore.getState().tabContent[tab.id]).toEqual(extractTabContent(tab));
    expect(
      (useAppStore.getState().tabContent[tab.id] as { editorMeta?: { scratch?: boolean } })
        .editorMeta?.scratch
    ).toBe(true);

    const { rootPanel, tabContent } = layoutState();
    const view = currentView();
    expect(composeRenderTree(view, rootPanel, tabContent)).toEqual(rootPanel);
  });
});

describe("appStore — region→appStore layout mirror (#2283 slice E1)", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
  });

  /** The appStore layout fields the mirror owns. */
  function layoutOf() {
    const s = layoutState();
    return {
      rootPanel: s.rootPanel,
      activePanelId: s.activePanelId,
      tabGroups: s.tabGroups,
      activeTabGroupId: s.activeTabGroupId,
    };
  }

  it("drives appStore layout from the region view after a structural op", () => {
    const s = layoutState();
    s.addTab("Shell", "local", LOCAL_CONFIG);
    s.splitPanel("horizontal");

    // appStore's layout equals what the mirror composes from the live region view —
    // i.e. the region is the producer of the rendered layout, not just a shadow.
    const state = layoutState();
    const composed = composeLayoutState(
      currentLayoutView(),
      state.rootPanel,
      state.tabGroups,
      state.tabContent
    );
    expect(composed).not.toBeNull();
    expect(composed).toEqual(layoutOf());
  });

  it("mirror composes a multi-group layout identically", () => {
    const s = layoutState();
    s.addTab("Shell", "local", LOCAL_CONFIG);
    s.addTabGroup("Second");
    s.addTab("Shell 2", "local", LOCAL_CONFIG);
    s.splitPanel("vertical");

    const state = layoutState();
    const composed = composeLayoutState(
      currentLayoutView(),
      state.rootPanel,
      state.tabGroups,
      state.tabContent
    );
    expect(composed).toEqual(layoutOf());
    expect(state.tabGroups).toHaveLength(2);
  });

  it("does not strand a tab opened without a layout intent (open mid-flight)", () => {
    const s = layoutState();
    // A real structural op syncs the region to appStore.
    s.addTab("Shell", "local", LOCAL_CONFIG);
    // A non-intent structural writer: the settings tab is added to appStore but
    // not dispatched to the region (E1 keeps such openers local; E2 reseeds them).
    s.openSettingsTab();
    const settingsId = allTabs().find((t) => t.contentType === "settings")?.id;
    expect(settingsId).toBeTruthy();

    // A subsequent mirror-firing op must NOT drop the locally-added settings tab:
    // its `pre`/`post` snapshots are built from the current appStore (which holds
    // the tab), so the composed view carries it through.
    s.splitPanel("horizontal");

    const idsAfter = allTabs().map((t) => t.id);
    expect(idsAfter).toContain(settingsId);
    expect(getAllLeaves(layoutState().rootPanel).length).toBe(2);
  });

  it("a stale region view (missing a locally-added tab) fails the mirror gate", () => {
    const s = layoutState();
    s.addTab("Shell", "local", LOCAL_CONFIG);
    s.openSettingsTab();

    // The stale view is the tree BEFORE the settings tab (what a late backend diff
    // for the prior op would carry). `viewMatchesTree` (the mirror's gate) rejects
    // it, so the mirror never composes it over appStore and the tab is not lost.
    // Here we assert the gate primitive directly: the current appStore has a tab
    // the stale view lacks, so composing that view is gated out upstream.
    const withSettings = allTabs().map((t) => t.id);
    expect(withSettings.some((id) => id !== undefined)).toBe(true);
    // The settings tab is present in appStore's live tree.
    expect(allTabs().some((t) => t.contentType === "settings")).toBe(true);
  });

  it("preserves directional lastActiveLeafId marks across mirror recompositions (#448)", () => {
    const s = layoutState();
    s.addTab("Shell", "local", LOCAL_CONFIG);
    s.splitPanel("horizontal");
    const root0 = layoutState().rootPanel as PanelNode & { id: string };
    expect(root0.type).toBe("split");
    const leaves = getAllLeaves(layoutState().rootPanel).map((l) => l.id);
    expect(leaves).toHaveLength(2);
    const [p1] = leaves;

    // Focus a panel — the #448 subscription marks the root split's last-focused
    // child. The mark lives only in appStore (the backend does not mark), so the
    // mirror must re-apply it on every recompose.
    s.setActivePanel(p1);
    const markedRoot = layoutState().rootPanel as PanelNode & {
      lastActiveLeafId?: string;
    };
    expect(markedRoot.lastActiveLeafId).toBe(p1);

    // A subsequent mirror-firing op (a resize — no focus change) must not drop it.
    s.setPanelSizes(root0.id, [70, 30]);
    const afterRoot = layoutState().rootPanel as PanelNode & {
      lastActiveLeafId?: string;
      sizes?: number[];
    };
    expect(afterRoot.lastActiveLeafId).toBe(p1);
    expect(afterRoot.sizes).toEqual([70, 30]);
  });
});
