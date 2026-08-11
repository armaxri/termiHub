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
import { composeRenderTree, toMinimalNode, type LayoutView } from "./layoutBridge";
import { extractTabContent, useAppStore } from "./appStore";

const LOCAL_CONFIG: ConnectionConfig = { type: "local", config: { shell: "zsh" } };

/** Every tab currently in the active panel tree, flattened. */
function allTabs(): TerminalTab[] {
  return getAllLeaves(useAppStore.getState().rootPanel).flatMap((l) => l.tabs);
}

/** The projected (multi-group) view of the current tree — a single active group
 * holding the current panel tree (#2283 slice C). */
function currentView(): LayoutView {
  const { rootPanel, activePanelId } = useAppStore.getState();
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
    const id = useAppStore.getState().addTab("Shell", "local", LOCAL_CONFIG);
    const tab = allTabs().find((t) => t.id === id)!;
    // The map entry equals the in-tree tab projected to content (no panelId/isActive).
    expect(useAppStore.getState().tabContent[id]).toEqual(extractTabContent(tab));
    expect(useAppStore.getState().tabContent[id]).not.toHaveProperty("panelId");
    expect(useAppStore.getState().tabContent[id]).not.toHaveProperty("isActive");
  });

  it("renameTab mirrors the new title into the map, in sync with the tree", () => {
    const id = useAppStore.getState().addTab("Shell", "local", LOCAL_CONFIG);
    useAppStore.getState().renameTab(id, "Renamed");
    expect(useAppStore.getState().tabContent[id].title).toBe("Renamed");
    const tab = allTabs().find((t) => t.id === id)!;
    expect(useAppStore.getState().tabContent[id]).toEqual(extractTabContent(tab));
  });

  it("setTabSessionId mirrors the session id into the map, in sync with the tree", () => {
    const id = useAppStore.getState().addTab("Shell", "local", LOCAL_CONFIG);
    useAppStore.getState().setTabSessionId(id, "sess-42");
    expect(useAppStore.getState().tabContent[id].sessionId).toBe("sess-42");
    const tab = allTabs().find((t) => t.id === id)!;
    expect(useAppStore.getState().tabContent[id]).toEqual(extractTabContent(tab));
  });

  it("clearPendingScrollbackReplay mirrors the cleared flag into the map", () => {
    const id = useAppStore.getState().addTab("Shell", "local", LOCAL_CONFIG);
    // Seed the flag on both the tree and the map, then clear it.
    useAppStore.setState((s) => ({
      rootPanel: {
        ...s.rootPanel,
        tabs: (s.rootPanel as Extract<PanelNode, { type: "leaf" }>).tabs.map((t) =>
          t.id === id ? { ...t, pendingScrollbackReplay: true } : t
        ),
      } as PanelNode,
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
    const id = useAppStore.getState().addTab("Shell", "local", LOCAL_CONFIG);
    const panelId = allTabs().find((t) => t.id === id)!.panelId;
    expect(useAppStore.getState().tabContent[id]).toBeDefined();
    useAppStore.getState().closeTab(id, panelId);
    expect(useAppStore.getState().tabContent[id]).toBeUndefined();
  });

  it("render parity: composing from the map equals composing from the in-tree tab", () => {
    // A mix of a terminal tab (mapped) and an editor tab (not mapped → fallback).
    useAppStore.getState().addTab("Shell", "local", LOCAL_CONFIG);
    useAppStore.getState().openScratchEditorTab("Notes", "notes.md", "hello");
    useAppStore.getState().addTab("Shell 2", "local", LOCAL_CONFIG);

    const { rootPanel, tabContent } = useAppStore.getState();
    const view = currentView();

    const fromTree = composeRenderTree(view, rootPanel);
    const fromMap = composeRenderTree(view, rootPanel, tabContent);
    // Sourcing content from the map is byte-identical to sourcing it from the tree.
    expect(fromMap).toEqual(fromTree);
    // ...and identical to the authoritative tree itself (structure + content).
    expect(fromMap).toEqual(rootPanel);
  });

  it("render parity holds after rename + session update", () => {
    const id = useAppStore.getState().addTab("Shell", "local", LOCAL_CONFIG);
    useAppStore.getState().renameTab(id, "Renamed");
    useAppStore.getState().setTabSessionId(id, "sess-7");

    const { rootPanel, tabContent } = useAppStore.getState();
    const view = currentView();
    expect(composeRenderTree(view, rootPanel, tabContent)).toEqual(
      composeRenderTree(view, rootPanel)
    );
    expect(composeRenderTree(view, rootPanel, tabContent)).toEqual(rootPanel);
  });
});
