import { create } from "zustand";
import {
  TerminalTab,
  LeafPanel,
  PanelNode,
  ConnectionType,
  ConnectionConfig,
  ShellType,
  SshConfig,
  DropEdge,
  TabContentType,
  TerminalOptions,
  EditorTabMeta,
  ConnectionEditorMeta,
  EditorStatus,
  EditorActions,
} from "@/types/terminal";
import {
  SavedConnection,
  ConnectionFolder,
  FileEntry,
  ExternalConnectionSource,
  AppSettings,
  RemoteAgentDefinition,
  AgentCapabilities,
} from "@/types/connection";
import {
  loadConnections,
  persistConnection,
  removeConnection,
  persistFolder,
  removeFolder,
  getSettings,
  saveSettings as persistSettings,
  saveExternalFile,
  reloadExternalConnections as reloadExternalSources,
} from "@/services/storage";
import {
  sftpOpen,
  sftpClose,
  sftpListDir,
  localListDir,
  vscodeAvailable as checkVscode,
  monitoringOpen,
  monitoringClose,
  monitoringFetchStats,
  listAvailableShells,
  getDefaultShell,
  connectAgent as apiConnectAgent,
  disconnectAgent as apiDisconnectAgent,
  listAgentSessions,
  listAgentDefinitions,
  saveAgentDefinition,
  deleteAgentDefinition,
  AgentSessionInfo,
  AgentDefinitionInfo,
} from "@/services/api";
import { RemoteAgentConfig } from "@/types/terminal";
import { SystemStats } from "@/types/monitoring";
import {
  createLeafPanel,
  findLeaf,
  findLeafByTab,
  getAllLeaves,
  updateLeaf,
  removeLeaf,
  splitLeaf,
  simplifyTree,
  edgeToSplit,
} from "@/utils/panelTree";

export type SidebarView = "connections" | "files";

/**
 * Strip password from SSH and Remote connection configs so it is never persisted.
 */
function stripPassword(connection: SavedConnection): SavedConnection {
  if (connection.config.type === "ssh" && connection.config.config.password) {
    return {
      ...connection,
      config: {
        ...connection.config,
        config: { ...connection.config.config, password: undefined },
      },
    };
  }
  if (connection.config.type === "remote" && connection.config.config.password) {
    return {
      ...connection,
      config: {
        ...connection.config,
        config: { ...connection.config.config, password: undefined },
      },
    };
  }
  return connection;
}

/**
 * Return the external source file path that a namespaced ID belongs to, or null.
 */
function externalFilePathFromId(id: string): string | null {
  // IDs look like "ext:<filePath>::<originalId>" or "ext-root:<filePath>"
  if (id.startsWith("ext:")) {
    const rest = id.slice(4); // after "ext:"
    const sep = rest.indexOf("::");
    return sep >= 0 ? rest.slice(0, sep) : null;
  }
  if (id.startsWith("ext-root:")) {
    return id.slice(9);
  }
  return null;
}

/**
 * Strip namespace prefix from an external source so it can be persisted.
 */
function stripNamespace(source: ExternalConnectionSource): {
  name: string;
  folders: ConnectionFolder[];
  connections: SavedConnection[];
} {
  const prefix = `ext:${source.filePath}::`;
  const rootId = `ext-root:${source.filePath}`;

  const folders = source.folders
    .filter((f) => f.id !== rootId) // drop synthetic root
    .map((f) => ({
      ...f,
      id: f.id.startsWith(prefix) ? f.id.slice(prefix.length) : f.id,
      parentId:
        f.parentId === rootId
          ? null
          : f.parentId?.startsWith(prefix)
            ? f.parentId.slice(prefix.length)
            : f.parentId,
    }));

  const connections = source.connections.map((c) => ({
    ...c,
    id: c.id.startsWith(prefix) ? c.id.slice(prefix.length) : c.id,
    folderId:
      c.folderId === rootId
        ? null
        : c.folderId?.startsWith(prefix)
          ? c.folderId.slice(prefix.length)
          : c.folderId,
  }));

  return { name: source.name, folders, connections };
}

/**
 * Persist an in-memory external source back to its file.
 */
async function persistExternalSource(source: ExternalConnectionSource): Promise<void> {
  const { name, folders, connections } = stripNamespace(source);
  await saveExternalFile(source.filePath, name, folders, connections);
}

interface AppState {
  // Platform default shell (detected from backend at startup)
  defaultShell: ShellType;

  // Sidebar
  sidebarView: SidebarView;
  sidebarCollapsed: boolean;
  setSidebarView: (view: SidebarView) => void;
  toggleSidebar: () => void;

  // Password prompt
  passwordPromptOpen: boolean;
  passwordPromptHost: string;
  passwordPromptUsername: string;
  passwordPromptResolve: ((password: string | null) => void) | null;
  requestPassword: (host: string, username: string) => Promise<string | null>;
  submitPassword: (password: string) => void;
  dismissPasswordPrompt: () => void;

  // Panels & Tabs
  rootPanel: PanelNode;
  activePanelId: string | null;
  addTab: (
    title: string,
    connectionType: ConnectionType,
    config?: ConnectionConfig,
    panelId?: string,
    contentType?: TabContentType,
    terminalOptions?: TerminalOptions
  ) => void;
  openSettingsTab: () => void;
  openEditorTab: (filePath: string, isRemote: boolean, sftpSessionId?: string) => void;
  openConnectionEditorTab: (connectionId: string, folderId?: string | null) => void;
  editorDirtyTabs: Record<string, boolean>;
  setEditorDirty: (tabId: string, dirty: boolean) => void;
  closeTab: (tabId: string, panelId: string) => void;
  setActiveTab: (tabId: string, panelId: string) => void;
  moveTab: (tabId: string, fromPanelId: string, toPanelId: string, newIndex: number) => void;
  reorderTabs: (panelId: string, oldIndex: number, newIndex: number) => void;
  splitPanel: (direction?: "horizontal" | "vertical") => void;
  removePanel: (panelId: string) => void;
  setActivePanel: (panelId: string) => void;
  splitPanelWithTab: (
    tabId: string,
    fromPanelId: string,
    targetPanelId: string,
    edge: DropEdge
  ) => void;
  getAllPanels: () => LeafPanel[];

  // Connections
  folders: ConnectionFolder[];
  connections: SavedConnection[];
  externalSources: ExternalConnectionSource[];
  settings: AppSettings;
  loadFromBackend: () => Promise<void>;
  updateSettings: (settings: AppSettings) => Promise<void>;
  reloadExternalConnections: () => Promise<void>;
  toggleFolder: (folderId: string) => void;
  addConnection: (connection: SavedConnection) => void;
  updateConnection: (connection: SavedConnection) => void;
  deleteConnection: (connectionId: string) => void;
  addFolder: (folder: ConnectionFolder) => void;
  deleteFolder: (folderId: string) => void;
  duplicateConnection: (connectionId: string) => void;
  moveConnectionToFolder: (connectionId: string, folderId: string | null) => void;

  // External source mutations
  addExternalConnection: (filePath: string, connection: SavedConnection) => void;
  updateExternalConnection: (filePath: string, connection: SavedConnection) => void;
  deleteExternalConnection: (filePath: string, connectionId: string) => void;
  duplicateExternalConnection: (filePath: string, connectionId: string) => void;
  addExternalFolder: (filePath: string, folder: ConnectionFolder) => void;
  deleteExternalFolder: (filePath: string, folderId: string) => void;
  moveConnectionToExternalFolder: (connectionId: string, folderId: string) => void;

  // File browser / SFTP
  fileEntries: FileEntry[];
  currentPath: string;
  sftpSessionId: string | null;
  sftpLoading: boolean;
  sftpError: string | null;
  sftpConnectedHost: string | null;
  setCurrentPath: (path: string) => void;
  setFileEntries: (entries: FileEntry[]) => void;
  connectSftp: (config: SshConfig) => Promise<void>;
  disconnectSftp: () => Promise<void>;
  navigateSftp: (path: string) => Promise<void>;
  refreshSftp: () => Promise<void>;

  // Per-tab CWD tracking
  tabCwds: Record<string, string>;
  setTabCwd: (tabId: string, cwd: string) => void;

  // Per-tab horizontal scrolling
  tabHorizontalScrolling: Record<string, boolean>;
  setTabHorizontalScrolling: (tabId: string, enabled: boolean) => void;

  // Rename tab
  renameTab: (tabId: string, newTitle: string) => void;

  // Per-tab color
  tabColors: Record<string, string>;
  setTabColor: (tabId: string, color: string | null) => void;

  // Remote connection states
  remoteStates: Record<string, string>;
  setRemoteState: (sessionId: string, state: string) => void;

  // Remote agents
  remoteAgents: RemoteAgentDefinition[];
  agentSessions: Record<string, AgentSessionInfo[]>;
  agentDefinitions: Record<string, AgentDefinitionInfo[]>;
  addRemoteAgent: (agent: RemoteAgentDefinition) => void;
  updateRemoteAgent: (agent: RemoteAgentDefinition) => void;
  deleteRemoteAgent: (agentId: string) => void;
  toggleRemoteAgent: (agentId: string) => void;
  connectRemoteAgent: (agentId: string, password?: string) => Promise<void>;
  disconnectRemoteAgent: (agentId: string) => Promise<void>;
  setAgentConnectionState: (
    agentId: string,
    state: RemoteAgentDefinition["connectionState"]
  ) => void;
  setAgentCapabilities: (agentId: string, capabilities: AgentCapabilities) => void;
  refreshAgentSessions: (agentId: string) => Promise<void>;
  saveAgentDef: (agentId: string, definition: Record<string, unknown>) => Promise<void>;
  deleteAgentDef: (agentId: string, definitionId: string) => Promise<void>;

  // Local file browser state
  localFileEntries: FileEntry[];
  localCurrentPath: string;
  localFileLoading: boolean;
  localFileError: string | null;
  navigateLocal: (path: string) => Promise<void>;
  refreshLocal: () => Promise<void>;

  // File browser mode
  fileBrowserMode: "local" | "sftp" | "none";
  setFileBrowserMode: (mode: "local" | "sftp" | "none") => void;

  // VS Code availability
  vscodeAvailable: boolean;
  checkVscodeAvailability: () => Promise<void>;

  // Editor status bar
  editorStatus: EditorStatus | null;
  setEditorStatus: (status: EditorStatus | null) => void;
  editorActions: EditorActions | null;
  setEditorActions: (actions: EditorActions | null) => void;

  // Monitoring
  monitoringSessionId: string | null;
  monitoringHost: string | null;
  monitoringStats: SystemStats | null;
  monitoringLoading: boolean;
  monitoringError: string | null;
  connectMonitoring: (config: SshConfig) => Promise<void>;
  disconnectMonitoring: () => Promise<void>;
  refreshMonitoring: () => Promise<void>;
}

let tabCounter = 0;

function createTab(
  title: string,
  connectionType: ConnectionType,
  config: ConnectionConfig,
  panelId: string,
  contentType: TabContentType = "terminal"
): TerminalTab {
  tabCounter++;
  return {
    id: `tab-${tabCounter}`,
    sessionId: null,
    title,
    connectionType,
    contentType,
    config,
    panelId,
    isActive: true,
  };
}

/**
 * Remove a tab from a leaf panel, choosing a new active tab if needed.
 * Returns the updated leaf (may have empty tabs).
 */
function removeTabFromLeaf(leaf: LeafPanel, tabId: string): LeafPanel {
  const idx = leaf.tabs.findIndex((t) => t.id === tabId);
  if (idx === -1) return leaf;

  const tabs = leaf.tabs.filter((t) => t.id !== tabId);
  let activeTabId = leaf.activeTabId;
  if (activeTabId === tabId) {
    const newIdx = Math.min(idx, tabs.length - 1);
    activeTabId = tabs[newIdx]?.id ?? null;
  }
  if (activeTabId) {
    return {
      ...leaf,
      tabs: tabs.map((t) => ({ ...t, isActive: t.id === activeTabId })),
      activeTabId,
    };
  }
  return { ...leaf, tabs, activeTabId: null };
}

export const useAppStore = create<AppState>((set, get) => {
  const initialPanel = createLeafPanel();

  return {
    // Platform default shell — updated by loadFromBackend()
    defaultShell: "bash",

    // Sidebar
    sidebarView: "connections",
    sidebarCollapsed: false,
    setSidebarView: (view) =>
      set((state) => ({
        sidebarView: view,
        sidebarCollapsed: state.sidebarView === view && !state.sidebarCollapsed ? true : false,
      })),
    toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),

    // Password prompt
    passwordPromptOpen: false,
    passwordPromptHost: "",
    passwordPromptUsername: "",
    passwordPromptResolve: null,

    requestPassword: (host, username) => {
      return new Promise<string | null>((resolve) => {
        set({
          passwordPromptOpen: true,
          passwordPromptHost: host,
          passwordPromptUsername: username,
          passwordPromptResolve: resolve,
        });
      });
    },

    submitPassword: (password) => {
      const { passwordPromptResolve } = get();
      if (passwordPromptResolve) passwordPromptResolve(password);
      set({
        passwordPromptOpen: false,
        passwordPromptHost: "",
        passwordPromptUsername: "",
        passwordPromptResolve: null,
      });
    },

    dismissPasswordPrompt: () => {
      const { passwordPromptResolve } = get();
      if (passwordPromptResolve) passwordPromptResolve(null);
      set({
        passwordPromptOpen: false,
        passwordPromptHost: "",
        passwordPromptUsername: "",
        passwordPromptResolve: null,
      });
    },

    // Panels & Tabs
    rootPanel: initialPanel,
    activePanelId: initialPanel.id,

    getAllPanels: () => getAllLeaves(get().rootPanel),

    addTab: (title, connectionType, config, panelId, contentType, terminalOptions) =>
      set((state) => {
        const allLeaves = getAllLeaves(state.rootPanel);
        const targetPanelId = panelId ?? state.activePanelId ?? allLeaves[0]?.id;
        if (!targetPanelId) return state;

        const defaultConfig: ConnectionConfig = config ?? {
          type: "local",
          config: { shellType: state.defaultShell },
        };
        const newTab = createTab(title, connectionType, defaultConfig, targetPanelId, contentType);
        const rootPanel = updateLeaf(state.rootPanel, targetPanelId, (leaf) => {
          const tabs = leaf.tabs.map((t) => ({ ...t, isActive: false }));
          tabs.push(newTab);
          return { ...leaf, tabs, activeTabId: newTab.id };
        });
        const hsEnabled = terminalOptions?.horizontalScrolling ?? false;
        const tabColor = terminalOptions?.color;
        return {
          rootPanel,
          activePanelId: targetPanelId,
          tabHorizontalScrolling: { ...state.tabHorizontalScrolling, [newTab.id]: hsEnabled },
          ...(tabColor ? { tabColors: { ...state.tabColors, [newTab.id]: tabColor } } : {}),
        };
      }),

    openSettingsTab: () =>
      set((state) => {
        const allLeaves = getAllLeaves(state.rootPanel);

        // Look for an existing settings tab
        for (const leaf of allLeaves) {
          const existing = leaf.tabs.find((t) => t.contentType === "settings");
          if (existing) {
            // Activate the existing settings tab
            const rootPanel = updateLeaf(state.rootPanel, leaf.id, (l) => ({
              ...l,
              tabs: l.tabs.map((t) => ({ ...t, isActive: t.id === existing.id })),
              activeTabId: existing.id,
            }));
            return { rootPanel, activePanelId: leaf.id };
          }
        }

        // No existing settings tab — create one in the active panel
        const targetPanelId = state.activePanelId ?? allLeaves[0]?.id;
        if (!targetPanelId) return state;

        const dummyConfig: ConnectionConfig = { type: "local", config: { shellType: "zsh" } };
        const newTab = createTab("Settings", "local", dummyConfig, targetPanelId, "settings");
        const rootPanel = updateLeaf(state.rootPanel, targetPanelId, (leaf) => {
          const tabs = leaf.tabs.map((t) => ({ ...t, isActive: false }));
          tabs.push(newTab);
          return { ...leaf, tabs, activeTabId: newTab.id };
        });
        return { rootPanel, activePanelId: targetPanelId };
      }),

    openEditorTab: (filePath, isRemote, sftpSessionId) =>
      set((state) => {
        const allLeaves = getAllLeaves(state.rootPanel);

        // Look for an existing editor tab for this file
        for (const leaf of allLeaves) {
          const existing = leaf.tabs.find(
            (t) =>
              t.contentType === "editor" &&
              t.editorMeta?.filePath === filePath &&
              t.editorMeta?.isRemote === isRemote
          );
          if (existing) {
            const rootPanel = updateLeaf(state.rootPanel, leaf.id, (l) => ({
              ...l,
              tabs: l.tabs.map((t) => ({ ...t, isActive: t.id === existing.id })),
              activeTabId: existing.id,
            }));
            return { rootPanel, activePanelId: leaf.id };
          }
        }

        // Create new editor tab in the active panel
        const targetPanelId = state.activePanelId ?? allLeaves[0]?.id;
        if (!targetPanelId) return state;

        const fileName = filePath.split("/").pop() ?? filePath;
        const dummyConfig: ConnectionConfig = { type: "local", config: { shellType: "zsh" } };
        const editorMeta: EditorTabMeta = { filePath, isRemote, sftpSessionId };
        const newTab = createTab(fileName, "local", dummyConfig, targetPanelId, "editor");
        newTab.editorMeta = editorMeta;

        const rootPanel = updateLeaf(state.rootPanel, targetPanelId, (leaf) => {
          const tabs = leaf.tabs.map((t) => ({ ...t, isActive: false }));
          tabs.push(newTab);
          return { ...leaf, tabs, activeTabId: newTab.id };
        });
        return { rootPanel, activePanelId: targetPanelId };
      }),

    openConnectionEditorTab: (connectionId, folderId) =>
      set((state) => {
        const allLeaves = getAllLeaves(state.rootPanel);

        // Look for an existing connection-editor tab for this connection
        for (const leaf of allLeaves) {
          const existing = leaf.tabs.find(
            (t) =>
              t.contentType === "connection-editor" &&
              t.connectionEditorMeta?.connectionId === connectionId
          );
          if (existing) {
            const rootPanel = updateLeaf(state.rootPanel, leaf.id, (l) => ({
              ...l,
              tabs: l.tabs.map((t) => ({ ...t, isActive: t.id === existing.id })),
              activeTabId: existing.id,
            }));
            return { rootPanel, activePanelId: leaf.id };
          }
        }

        // Create new connection-editor tab in the active panel
        const targetPanelId = state.activePanelId ?? allLeaves[0]?.id;
        if (!targetPanelId) return state;

        // Determine tab title
        let title = "New Connection";
        if (connectionId !== "new") {
          const conn =
            state.connections.find((c) => c.id === connectionId) ??
            state.externalSources.flatMap((s) => s.connections).find((c) => c.id === connectionId);
          if (conn) {
            title = `Edit: ${conn.name}`;
          }
        }

        const dummyConfig: ConnectionConfig = { type: "local", config: { shellType: "zsh" } };
        const meta: ConnectionEditorMeta = {
          connectionId,
          folderId: folderId ?? null,
        };
        const newTab = createTab(title, "local", dummyConfig, targetPanelId, "connection-editor");
        newTab.connectionEditorMeta = meta;

        const rootPanel = updateLeaf(state.rootPanel, targetPanelId, (leaf) => {
          const tabs = leaf.tabs.map((t) => ({ ...t, isActive: false }));
          tabs.push(newTab);
          return { ...leaf, tabs, activeTabId: newTab.id };
        });
        return { rootPanel, activePanelId: targetPanelId };
      }),

    editorDirtyTabs: {},
    setEditorDirty: (tabId, dirty) =>
      set((state) => ({ editorDirtyTabs: { ...state.editorDirtyTabs, [tabId]: dirty } })),

    closeTab: (tabId, panelId) =>
      set((state) => {
        // Clean up per-tab state for the closed tab
        const { [tabId]: _removed, ...remainingCwds } = state.tabCwds;
        const { [tabId]: _removedHs, ...remainingHs } = state.tabHorizontalScrolling;
        const { [tabId]: _removedDirty, ...remainingDirty } = state.editorDirtyTabs;
        const { [tabId]: _removedColor, ...remainingColors } = state.tabColors;

        let rootPanel = updateLeaf(state.rootPanel, panelId, (leaf) =>
          removeTabFromLeaf(leaf, tabId)
        );

        // If leaf is now empty and not the sole leaf, remove it
        const allLeaves = getAllLeaves(rootPanel);
        const updatedLeaf = findLeaf(rootPanel, panelId);
        if (updatedLeaf && updatedLeaf.tabs.length === 0 && allLeaves.length > 1) {
          const removed = removeLeaf(rootPanel, panelId);
          rootPanel = removed ? simplifyTree(removed) : rootPanel;
          const newLeaves = getAllLeaves(rootPanel);
          const activePanelId =
            state.activePanelId === panelId ? (newLeaves[0]?.id ?? null) : state.activePanelId;
          return {
            rootPanel,
            activePanelId,
            tabCwds: remainingCwds,
            tabHorizontalScrolling: remainingHs,
            editorDirtyTabs: remainingDirty,
            tabColors: remainingColors,
          };
        }

        return {
          rootPanel,
          tabCwds: remainingCwds,
          tabHorizontalScrolling: remainingHs,
          editorDirtyTabs: remainingDirty,
          tabColors: remainingColors,
        };
      }),

    setActiveTab: (tabId, panelId) =>
      set((state) => ({
        rootPanel: updateLeaf(state.rootPanel, panelId, (leaf) => ({
          ...leaf,
          tabs: leaf.tabs.map((t) => ({ ...t, isActive: t.id === tabId })),
          activeTabId: tabId,
        })),
        activePanelId: panelId,
      })),

    moveTab: (tabId, fromPanelId, toPanelId, newIndex) =>
      set((state) => {
        if (fromPanelId === toPanelId) return state;

        // Find and remove tab from source
        const sourceLeaf = findLeaf(state.rootPanel, fromPanelId);
        if (!sourceLeaf) return state;
        const tab = sourceLeaf.tabs.find((t) => t.id === tabId);
        if (!tab) return state;

        const movedTab: TerminalTab = { ...tab, panelId: toPanelId, isActive: true };

        // Remove from source
        let rootPanel = updateLeaf(state.rootPanel, fromPanelId, (leaf) =>
          removeTabFromLeaf(leaf, tabId)
        );

        // Add to destination
        rootPanel = updateLeaf(rootPanel, toPanelId, (leaf) => {
          const tabs = [...leaf.tabs.map((t) => ({ ...t, isActive: false }))];
          const idx = newIndex < 0 ? tabs.length : Math.min(newIndex, tabs.length);
          tabs.splice(idx, 0, movedTab);
          return { ...leaf, tabs, activeTabId: movedTab.id };
        });

        // Clean up empty source panel
        const updatedSource = findLeaf(rootPanel, fromPanelId);
        const allLeaves = getAllLeaves(rootPanel);
        if (updatedSource && updatedSource.tabs.length === 0 && allLeaves.length > 1) {
          const removed = removeLeaf(rootPanel, fromPanelId);
          rootPanel = removed ? simplifyTree(removed) : rootPanel;
        }

        return { rootPanel, activePanelId: toPanelId };
      }),

    reorderTabs: (panelId, oldIndex, newIndex) =>
      set((state) => ({
        rootPanel: updateLeaf(state.rootPanel, panelId, (leaf) => {
          const tabs = [...leaf.tabs];
          const [moved] = tabs.splice(oldIndex, 1);
          tabs.splice(newIndex, 0, moved);
          return { ...leaf, tabs };
        }),
      })),

    splitPanel: (direction) =>
      set((state) => {
        const dir = direction ?? "horizontal";
        const targetId = state.activePanelId;
        if (!targetId) return state;

        const newLeaf = createLeafPanel();
        let rootPanel = splitLeaf(state.rootPanel, targetId, newLeaf, dir, "after");
        rootPanel = simplifyTree(rootPanel);
        return { rootPanel, activePanelId: newLeaf.id };
      }),

    removePanel: (panelId) =>
      set((state) => {
        const allLeaves = getAllLeaves(state.rootPanel);
        if (allLeaves.length <= 1) return state;

        const removed = removeLeaf(state.rootPanel, panelId);
        if (!removed) return state;
        const rootPanel = simplifyTree(removed);
        const newLeaves = getAllLeaves(rootPanel);
        const activePanelId =
          state.activePanelId === panelId ? (newLeaves[0]?.id ?? null) : state.activePanelId;
        return { rootPanel, activePanelId };
      }),

    setActivePanel: (panelId) => set({ activePanelId: panelId }),

    splitPanelWithTab: (tabId, fromPanelId, targetPanelId, edge) =>
      set((state) => {
        const splitInfo = edgeToSplit(edge);

        // Center drop: move tab to existing panel
        if (!splitInfo) {
          const sourceLeaf = findLeaf(state.rootPanel, fromPanelId);
          if (!sourceLeaf) return state;
          const tab = sourceLeaf.tabs.find((t) => t.id === tabId);
          if (!tab) return state;

          const movedTab: TerminalTab = { ...tab, panelId: targetPanelId, isActive: true };

          let rootPanel = updateLeaf(state.rootPanel, fromPanelId, (leaf) =>
            removeTabFromLeaf(leaf, tabId)
          );
          rootPanel = updateLeaf(rootPanel, targetPanelId, (leaf) => ({
            ...leaf,
            tabs: [...leaf.tabs.map((t) => ({ ...t, isActive: false })), movedTab],
            activeTabId: movedTab.id,
          }));

          // Clean up empty source
          const updatedSource = findLeaf(rootPanel, fromPanelId);
          const allLeaves = getAllLeaves(rootPanel);
          if (updatedSource && updatedSource.tabs.length === 0 && allLeaves.length > 1) {
            const removed = removeLeaf(rootPanel, fromPanelId);
            rootPanel = removed ? simplifyTree(removed) : rootPanel;
          }

          return { rootPanel, activePanelId: targetPanelId };
        }

        // Edge drop: create new panel via split
        const sourceLeaf = findLeaf(state.rootPanel, fromPanelId);
        if (!sourceLeaf) return state;
        const tab = sourceLeaf.tabs.find((t) => t.id === tabId);
        if (!tab) return state;

        const newLeaf = createLeafPanel();
        const movedTab: TerminalTab = { ...tab, panelId: newLeaf.id, isActive: true };
        newLeaf.tabs = [movedTab];
        newLeaf.activeTabId = movedTab.id;

        // Remove tab from source
        let rootPanel = updateLeaf(state.rootPanel, fromPanelId, (leaf) =>
          removeTabFromLeaf(leaf, tabId)
        );

        // Clean up empty source before splitting (unless source IS the target)
        if (fromPanelId !== targetPanelId) {
          const updatedSource = findLeaf(rootPanel, fromPanelId);
          const allLeaves = getAllLeaves(rootPanel);
          if (updatedSource && updatedSource.tabs.length === 0 && allLeaves.length > 1) {
            const removed = removeLeaf(rootPanel, fromPanelId);
            rootPanel = removed ? simplifyTree(removed) : rootPanel;
          }
        }

        // Split the target
        rootPanel = splitLeaf(
          rootPanel,
          targetPanelId,
          newLeaf,
          splitInfo.direction,
          splitInfo.position
        );
        rootPanel = simplifyTree(rootPanel);

        return { rootPanel, activePanelId: newLeaf.id };
      }),

    // Connections — initialized empty, loaded from backend on mount
    folders: [],
    connections: [],
    externalSources: [],
    settings: { version: "1", externalConnectionFiles: [] },
    loadFromBackend: async () => {
      try {
        const { connections, folders, externalSources } = await loadConnections();
        const settings = await getSettings();
        set({ connections, folders, externalSources, settings });
      } catch (err) {
        console.error("Failed to load connections from backend:", err);
      }
      // Detect platform default shell
      try {
        const shells = await listAvailableShells();
        const detectedDefault = await getDefaultShell();
        if (detectedDefault && shells.includes(detectedDefault)) {
          set({ defaultShell: detectedDefault as ShellType });
        } else if (shells.length > 0) {
          set({ defaultShell: shells[0] as ShellType });
        }
      } catch (err) {
        console.error("Failed to detect available shells:", err);
      }
      // Check VS Code availability in the background
      get().checkVscodeAvailability();
    },

    updateSettings: async (newSettings) => {
      try {
        await persistSettings(newSettings);
        set({ settings: newSettings });
      } catch (err) {
        console.error("Failed to save settings:", err);
      }
    },

    reloadExternalConnections: async () => {
      try {
        const sources = await reloadExternalSources();
        set({ externalSources: sources });
      } catch (err) {
        console.error("Failed to reload external connections:", err);
      }
    },

    toggleFolder: (folderId) => {
      set((state) => {
        const folders = state.folders.map((f) =>
          f.id === folderId ? { ...f, isExpanded: !f.isExpanded } : f
        );
        // Persist the toggled folder
        const toggled = folders.find((f) => f.id === folderId);
        if (toggled) {
          persistFolder(toggled).catch((err) =>
            console.error("Failed to persist folder toggle:", err)
          );
        }
        return { folders };
      });
    },

    addConnection: (connection) => {
      set((state) => ({ connections: [...state.connections, connection] }));
      persistConnection(stripPassword(connection)).catch((err) =>
        console.error("Failed to persist new connection:", err)
      );
    },

    updateConnection: (connection) => {
      set((state) => ({
        connections: state.connections.map((c) => (c.id === connection.id ? connection : c)),
      }));
      persistConnection(stripPassword(connection)).catch((err) =>
        console.error("Failed to persist connection update:", err)
      );
    },

    deleteConnection: (connectionId) => {
      set((state) => ({
        connections: state.connections.filter((c) => c.id !== connectionId),
      }));
      removeConnection(connectionId).catch((err) =>
        console.error("Failed to persist connection deletion:", err)
      );
    },

    addFolder: (folder) => {
      set((state) => ({ folders: [...state.folders, folder] }));
      persistFolder(folder).catch((err) => console.error("Failed to persist new folder:", err));
    },

    deleteFolder: (folderId) => {
      set((state) => {
        // Move child connections to root
        const connections = state.connections.map((c) =>
          c.folderId === folderId ? { ...c, folderId: null } : c
        );
        // Reparent child folders
        const deletedFolder = state.folders.find((f) => f.id === folderId);
        const parentId = deletedFolder?.parentId ?? null;
        const folders = state.folders
          .map((f) => (f.parentId === folderId ? { ...f, parentId } : f))
          .filter((f) => f.id !== folderId);

        // Persist moved connections
        connections
          .filter(
            (c) =>
              c.folderId === null &&
              state.connections.find((sc) => sc.id === c.id)?.folderId === folderId
          )
          .forEach((c) => {
            persistConnection(c).catch((err) =>
              console.error("Failed to persist connection move:", err)
            );
          });

        return { folders, connections };
      });
      removeFolder(folderId).catch((err) =>
        console.error("Failed to persist folder deletion:", err)
      );
    },

    duplicateConnection: (connectionId) => {
      const state = useAppStore.getState();
      const original = state.connections.find((c) => c.id === connectionId);
      if (!original) return;
      const duplicate: SavedConnection = {
        ...original,
        id: `conn-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        name: `Copy of ${original.name}`,
      };
      set((s) => ({ connections: [...s.connections, duplicate] }));
      persistConnection(stripPassword(duplicate)).catch((err) =>
        console.error("Failed to persist duplicated connection:", err)
      );
    },

    moveConnectionToFolder: (connectionId, folderId) => {
      set((state) => {
        const connections = state.connections.map((c) =>
          c.id === connectionId ? { ...c, folderId } : c
        );
        const moved = connections.find((c) => c.id === connectionId);
        if (moved) {
          persistConnection(moved).catch((err) =>
            console.error("Failed to persist connection move:", err)
          );
        }
        return { connections };
      });
    },

    // External source mutations
    addExternalConnection: (filePath, connection) => {
      set((state) => {
        const externalSources = state.externalSources.map((s) => {
          if (s.filePath !== filePath) return s;
          return { ...s, connections: [...s.connections, connection] };
        });
        const source = externalSources.find((s) => s.filePath === filePath);
        if (source)
          persistExternalSource(source).catch((err) =>
            console.error("Failed to persist external connection:", err)
          );
        return { externalSources };
      });
    },

    updateExternalConnection: (filePath, connection) => {
      set((state) => {
        const externalSources = state.externalSources.map((s) => {
          if (s.filePath !== filePath) return s;
          return {
            ...s,
            connections: s.connections.map((c) => (c.id === connection.id ? connection : c)),
          };
        });
        const source = externalSources.find((s) => s.filePath === filePath);
        if (source)
          persistExternalSource(source).catch((err) =>
            console.error("Failed to persist external connection update:", err)
          );
        return { externalSources };
      });
    },

    deleteExternalConnection: (filePath, connectionId) => {
      set((state) => {
        const externalSources = state.externalSources.map((s) => {
          if (s.filePath !== filePath) return s;
          return { ...s, connections: s.connections.filter((c) => c.id !== connectionId) };
        });
        const source = externalSources.find((s) => s.filePath === filePath);
        if (source)
          persistExternalSource(source).catch((err) =>
            console.error("Failed to persist external connection delete:", err)
          );
        return { externalSources };
      });
    },

    duplicateExternalConnection: (filePath, connectionId) => {
      const state = useAppStore.getState();
      const source = state.externalSources.find((s) => s.filePath === filePath);
      if (!source) return;
      const original = source.connections.find((c) => c.id === connectionId);
      if (!original) return;
      const prefix = `ext:${filePath}::`;
      const rawId = `conn-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const duplicate: SavedConnection = {
        ...original,
        id: `${prefix}${rawId}`,
        name: `Copy of ${original.name}`,
      };
      const newSource = { ...source, connections: [...source.connections, duplicate] };
      set((s) => ({
        externalSources: s.externalSources.map((es) => (es.filePath === filePath ? newSource : es)),
      }));
      persistExternalSource(newSource).catch((err) =>
        console.error("Failed to persist external duplicate:", err)
      );
    },

    addExternalFolder: (filePath, folder) => {
      set((state) => {
        const externalSources = state.externalSources.map((s) => {
          if (s.filePath !== filePath) return s;
          return { ...s, folders: [...s.folders, folder] };
        });
        const source = externalSources.find((s) => s.filePath === filePath);
        if (source)
          persistExternalSource(source).catch((err) =>
            console.error("Failed to persist external folder:", err)
          );
        return { externalSources };
      });
    },

    deleteExternalFolder: (filePath, folderId) => {
      set((state) => {
        const externalSources = state.externalSources.map((s) => {
          if (s.filePath !== filePath) return s;
          const rootId = `ext-root:${filePath}`;
          const deletedFolder = s.folders.find((f) => f.id === folderId);
          const parentId = deletedFolder?.parentId ?? rootId;
          const folders = s.folders
            .map((f) => (f.parentId === folderId ? { ...f, parentId } : f))
            .filter((f) => f.id !== folderId);
          const connections = s.connections.map((c) =>
            c.folderId === folderId ? { ...c, folderId: parentId } : c
          );
          return { ...s, folders, connections };
        });
        const source = externalSources.find((s) => s.filePath === filePath);
        if (source)
          persistExternalSource(source).catch((err) =>
            console.error("Failed to persist external folder delete:", err)
          );
        return { externalSources };
      });
    },

    moveConnectionToExternalFolder: (connectionId, folderId) => {
      const filePath = externalFilePathFromId(folderId);
      if (!filePath) return;

      set((state) => {
        // Check if connection is from user-owned connections
        const userConn = state.connections.find((c) => c.id === connectionId);
        if (userConn) {
          // Move user connection into external source
          const prefix = `ext:${filePath}::`;
          const extConn: SavedConnection = {
            ...userConn,
            id: `${prefix}${userConn.id}`,
            folderId,
          };
          const connections = state.connections.filter((c) => c.id !== connectionId);
          const externalSources = state.externalSources.map((s) => {
            if (s.filePath !== filePath) return s;
            return { ...s, connections: [...s.connections, extConn] };
          });
          // Persist both sides
          removeConnection(connectionId).catch((err) =>
            console.error("Failed to remove user connection:", err)
          );
          const source = externalSources.find((s) => s.filePath === filePath);
          if (source)
            persistExternalSource(source).catch((err) =>
              console.error("Failed to persist external move:", err)
            );
          return { connections, externalSources };
        }

        // Connection is already external — move within/between external sources
        const sourceFilePath = externalFilePathFromId(connectionId);
        if (!sourceFilePath) return state;

        let movedConn: SavedConnection | null = null;
        let externalSources = state.externalSources.map((s) => {
          if (s.filePath !== sourceFilePath) return s;
          const conn = s.connections.find((c) => c.id === connectionId);
          if (conn) movedConn = { ...conn };
          return { ...s, connections: s.connections.filter((c) => c.id !== connectionId) };
        });

        if (!movedConn) return state;

        if (sourceFilePath === filePath) {
          // Same file — just update folderId
          (movedConn as SavedConnection).folderId = folderId;
          externalSources = externalSources.map((s) => {
            if (s.filePath !== filePath) return s;
            return { ...s, connections: [...s.connections, movedConn!] };
          });
        } else {
          // Different file — re-namespace
          const oldPrefix = `ext:${sourceFilePath}::`;
          const newPrefix = `ext:${filePath}::`;
          let rawId = (movedConn as SavedConnection).id;
          if (rawId.startsWith(oldPrefix)) rawId = rawId.slice(oldPrefix.length);
          (movedConn as SavedConnection).id = `${newPrefix}${rawId}`;
          (movedConn as SavedConnection).folderId = folderId;
          externalSources = externalSources.map((s) => {
            if (s.filePath !== filePath) return s;
            return { ...s, connections: [...s.connections, movedConn!] };
          });
        }

        // Persist affected sources
        for (const fp of [sourceFilePath, filePath]) {
          const source = externalSources.find((s) => s.filePath === fp);
          if (source)
            persistExternalSource(source).catch((err) =>
              console.error("Failed to persist external move:", err)
            );
        }
        return { externalSources };
      });
    },

    // File browser / SFTP
    fileEntries: [],
    currentPath: "/",
    sftpSessionId: null,
    sftpLoading: false,
    sftpError: null,
    sftpConnectedHost: null,

    setCurrentPath: (path) => set({ currentPath: path }),
    setFileEntries: (entries) => set({ fileEntries: entries }),

    connectSftp: async (config: SshConfig) => {
      set({ sftpLoading: true, sftpError: null });
      try {
        const sessionId = await sftpOpen(config);
        const homePath = `/home/${config.username}`;
        let entries: FileEntry[];
        let activePath = homePath;
        try {
          entries = await sftpListDir(sessionId, homePath);
        } catch {
          // Fall back to root if home dir doesn't exist
          activePath = "/";
          entries = await sftpListDir(sessionId, "/");
        }
        set({
          sftpSessionId: sessionId,
          sftpLoading: false,
          currentPath: activePath,
          fileEntries: entries,
          sftpConnectedHost: `${config.username}@${config.host}:${config.port}`,
        });
      } catch (err) {
        set({
          sftpLoading: false,
          sftpError: err instanceof Error ? err.message : String(err),
        });
      }
    },

    disconnectSftp: async () => {
      const sessionId = useAppStore.getState().sftpSessionId;
      if (sessionId) {
        try {
          await sftpClose(sessionId);
        } catch {
          // Ignore close errors
        }
      }
      set({
        sftpSessionId: null,
        fileEntries: [],
        currentPath: "/",
        sftpError: null,
        sftpConnectedHost: null,
      });
    },

    navigateSftp: async (path: string) => {
      const sessionId = useAppStore.getState().sftpSessionId;
      if (!sessionId) return;
      set({ sftpLoading: true, sftpError: null });
      try {
        const entries = await sftpListDir(sessionId, path);
        set({ fileEntries: entries, currentPath: path, sftpLoading: false });
      } catch (err) {
        set({
          sftpLoading: false,
          sftpError: err instanceof Error ? err.message : String(err),
        });
      }
    },

    refreshSftp: async () => {
      const { sftpSessionId, currentPath } = useAppStore.getState();
      if (!sftpSessionId) return;
      set({ sftpLoading: true, sftpError: null });
      try {
        const entries = await sftpListDir(sftpSessionId, currentPath);
        set({ fileEntries: entries, sftpLoading: false });
      } catch (err) {
        set({
          sftpLoading: false,
          sftpError: err instanceof Error ? err.message : String(err),
        });
      }
    },

    // Per-tab CWD tracking
    tabCwds: {},
    setTabCwd: (tabId, cwd) => set((state) => ({ tabCwds: { ...state.tabCwds, [tabId]: cwd } })),

    // Per-tab horizontal scrolling
    tabHorizontalScrolling: {},
    setTabHorizontalScrolling: (tabId, enabled) =>
      set((state) => ({
        tabHorizontalScrolling: { ...state.tabHorizontalScrolling, [tabId]: enabled },
      })),

    // Rename tab
    renameTab: (tabId, newTitle) =>
      set((state) => {
        const leaf = findLeafByTab(state.rootPanel, tabId);
        if (!leaf) return state;
        return {
          rootPanel: updateLeaf(state.rootPanel, leaf.id, (l) => ({
            ...l,
            tabs: l.tabs.map((t) => (t.id === tabId ? { ...t, title: newTitle } : t)),
          })),
        };
      }),

    // Per-tab color
    tabColors: {},
    setTabColor: (tabId, color) =>
      set((state) => {
        if (color === null) {
          const { [tabId]: _removed, ...remaining } = state.tabColors;
          return { tabColors: remaining };
        }
        return { tabColors: { ...state.tabColors, [tabId]: color } };
      }),

    // Remote connection states
    remoteStates: {},
    setRemoteState: (sessionId, state) =>
      set((s) => ({ remoteStates: { ...s.remoteStates, [sessionId]: state } })),

    // Remote agents
    remoteAgents: [],
    agentSessions: {},
    agentDefinitions: {},

    addRemoteAgent: (agent) => {
      set((state) => ({ remoteAgents: [...state.remoteAgents, agent] }));
    },

    updateRemoteAgent: (agent) => {
      set((state) => ({
        remoteAgents: state.remoteAgents.map((a) => (a.id === agent.id ? agent : a)),
      }));
    },

    deleteRemoteAgent: (agentId) => {
      const state = get();
      // Disconnect first if connected
      const agent = state.remoteAgents.find((a) => a.id === agentId);
      if (agent && agent.connectionState !== "disconnected") {
        apiDisconnectAgent(agentId).catch(() => {});
      }
      set((s) => ({
        remoteAgents: s.remoteAgents.filter((a) => a.id !== agentId),
        agentSessions: Object.fromEntries(
          Object.entries(s.agentSessions).filter(([k]) => k !== agentId)
        ),
        agentDefinitions: Object.fromEntries(
          Object.entries(s.agentDefinitions).filter(([k]) => k !== agentId)
        ),
      }));
    },

    toggleRemoteAgent: (agentId) => {
      set((state) => ({
        remoteAgents: state.remoteAgents.map((a) =>
          a.id === agentId ? { ...a, isExpanded: !a.isExpanded } : a
        ),
      }));
    },

    connectRemoteAgent: async (agentId, password) => {
      const state = get();
      const agent = state.remoteAgents.find((a) => a.id === agentId);
      if (!agent) return;

      set((s) => ({
        remoteAgents: s.remoteAgents.map((a) =>
          a.id === agentId ? { ...a, connectionState: "connecting" as const } : a
        ),
      }));

      try {
        const config: RemoteAgentConfig = { ...agent.config };
        if (password && config.authMethod === "password") {
          config.password = password;
        }
        const result = await apiConnectAgent(agentId, config);

        set((s) => ({
          remoteAgents: s.remoteAgents.map((a) =>
            a.id === agentId
              ? {
                  ...a,
                  connectionState: "connected" as const,
                  capabilities: result.capabilities,
                  isExpanded: true,
                }
              : a
          ),
        }));

        // Fetch sessions and definitions
        await get().refreshAgentSessions(agentId);
      } catch (err) {
        console.error(`Failed to connect agent ${agentId}:`, err);
        set((s) => ({
          remoteAgents: s.remoteAgents.map((a) =>
            a.id === agentId ? { ...a, connectionState: "disconnected" as const } : a
          ),
        }));
      }
    },

    disconnectRemoteAgent: async (agentId) => {
      try {
        await apiDisconnectAgent(agentId);
      } catch (err) {
        console.error(`Failed to disconnect agent ${agentId}:`, err);
      }
      set((s) => ({
        remoteAgents: s.remoteAgents.map((a) =>
          a.id === agentId ? { ...a, connectionState: "disconnected" as const } : a
        ),
        agentSessions: { ...s.agentSessions, [agentId]: [] },
      }));
    },

    setAgentConnectionState: (agentId, connectionState) => {
      set((state) => ({
        remoteAgents: state.remoteAgents.map((a) =>
          a.id === agentId ? { ...a, connectionState } : a
        ),
      }));
    },

    setAgentCapabilities: (agentId, capabilities) => {
      set((state) => ({
        remoteAgents: state.remoteAgents.map((a) =>
          a.id === agentId ? { ...a, capabilities } : a
        ),
      }));
    },

    refreshAgentSessions: async (agentId) => {
      try {
        const [sessions, definitions] = await Promise.all([
          listAgentSessions(agentId),
          listAgentDefinitions(agentId),
        ]);
        set((s) => ({
          agentSessions: { ...s.agentSessions, [agentId]: sessions },
          agentDefinitions: { ...s.agentDefinitions, [agentId]: definitions },
        }));
      } catch (err) {
        console.error(`Failed to refresh agent sessions for ${agentId}:`, err);
      }
    },

    saveAgentDef: async (agentId, definition) => {
      try {
        const saved = await saveAgentDefinition(agentId, definition);
        set((s) => ({
          agentDefinitions: {
            ...s.agentDefinitions,
            [agentId]: [
              ...(s.agentDefinitions[agentId] ?? []).filter((d) => d.id !== saved.id),
              saved,
            ],
          },
        }));
      } catch (err) {
        console.error(`Failed to save agent definition on ${agentId}:`, err);
      }
    },

    deleteAgentDef: async (agentId, definitionId) => {
      try {
        await deleteAgentDefinition(agentId, definitionId);
        set((s) => ({
          agentDefinitions: {
            ...s.agentDefinitions,
            [agentId]: (s.agentDefinitions[agentId] ?? []).filter((d) => d.id !== definitionId),
          },
        }));
      } catch (err) {
        console.error(`Failed to delete agent definition on ${agentId}:`, err);
      }
    },

    // Local file browser state
    localFileEntries: [],
    localCurrentPath: "/",
    localFileLoading: false,
    localFileError: null,

    navigateLocal: async (path: string) => {
      set({ localFileLoading: true, localFileError: null });
      try {
        const entries = await localListDir(path);
        set({ localFileEntries: entries, localCurrentPath: path, localFileLoading: false });
      } catch (err) {
        set({
          localFileLoading: false,
          localFileError: err instanceof Error ? err.message : String(err),
        });
      }
    },

    refreshLocal: async () => {
      const { localCurrentPath } = useAppStore.getState();
      set({ localFileLoading: true, localFileError: null });
      try {
        const entries = await localListDir(localCurrentPath);
        set({ localFileEntries: entries, localFileLoading: false });
      } catch (err) {
        set({
          localFileLoading: false,
          localFileError: err instanceof Error ? err.message : String(err),
        });
      }
    },

    // File browser mode
    fileBrowserMode: "none",
    setFileBrowserMode: (mode) => set({ fileBrowserMode: mode }),

    // VS Code availability
    vscodeAvailable: false,
    checkVscodeAvailability: async () => {
      try {
        const available = await checkVscode();
        set({ vscodeAvailable: available });
      } catch (err) {
        console.error("Failed to check VS Code availability:", err);
      }
    },

    // Editor status bar
    editorStatus: null,
    setEditorStatus: (status) => set({ editorStatus: status }),
    editorActions: null,
    setEditorActions: (actions) => set({ editorActions: actions }),

    // Monitoring
    monitoringSessionId: null,
    monitoringHost: null,
    monitoringStats: null,
    monitoringLoading: false,
    monitoringError: null,

    connectMonitoring: async (config: SshConfig) => {
      set({ monitoringLoading: true, monitoringError: null });
      try {
        const sessionId = await monitoringOpen(config);
        const stats = await monitoringFetchStats(sessionId);
        set({
          monitoringSessionId: sessionId,
          monitoringHost: `${config.username}@${config.host}:${config.port}`,
          monitoringStats: stats,
          monitoringLoading: false,
        });
      } catch (err) {
        set({
          monitoringLoading: false,
          monitoringError: err instanceof Error ? err.message : String(err),
        });
      }
    },

    disconnectMonitoring: async () => {
      const sessionId = useAppStore.getState().monitoringSessionId;
      if (sessionId) {
        try {
          await monitoringClose(sessionId);
        } catch {
          // Ignore close errors
        }
      }
      set({
        monitoringSessionId: null,
        monitoringHost: null,
        monitoringStats: null,
        monitoringError: null,
      });
    },

    refreshMonitoring: async () => {
      const { monitoringSessionId } = useAppStore.getState();
      if (!monitoringSessionId) return;
      set({ monitoringLoading: true, monitoringError: null });
      try {
        const stats = await monitoringFetchStats(monitoringSessionId);
        set({ monitoringStats: stats, monitoringLoading: false });
      } catch (err) {
        set({
          monitoringLoading: false,
          monitoringError: err instanceof Error ? err.message : String(err),
        });
      }
    },
  };
});

/**
 * Get the active tab from the current store state.
 */
export function getActiveTab(state: AppState): TerminalTab | null {
  const { activePanelId, rootPanel } = state;
  if (!activePanelId) return null;
  const leaf = findLeaf(rootPanel, activePanelId);
  if (!leaf || !leaf.activeTabId) return null;
  return leaf.tabs.find((t) => t.id === leaf.activeTabId) ?? null;
}
