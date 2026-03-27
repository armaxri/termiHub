import { create } from "zustand";
import {
  TerminalTab,
  LeafPanel,
  PanelNode,
  ConnectionConfig,
  ShellType,
  DropEdge,
  TabContentType,
  TerminalOptions,
  EditorTabMeta,
  ConnectionEditorMeta,
  TunnelEditorMeta,
  WorkspaceEditorMeta,
  EditorStatus,
  EditorActions,
  TabGroup,
} from "@/types/terminal";
import {
  SavedConnection,
  ConnectionFolder,
  FileEntry,
  AppSettings,
  RemoteAgentDefinition,
  AgentCapabilities,
  LayoutConfig,
  DEFAULT_LAYOUT,
  LAYOUT_PRESETS,
  RecoveryWarning,
} from "@/types/connection";
import { CredentialStoreStatusInfo } from "@/types/credential";
import {
  loadConnections,
  persistConnection,
  removeConnection,
  moveConnectionToFile as apiMoveConnectionToFile,
  persistFolder,
  removeFolder,
  persistAgent,
  removeAgent,
  reorderAgents as persistAgentOrder,
  getSettings,
  saveSettings as persistSettings,
  reloadExternalConnections as apiReloadExternalConnections,
  getRecoveryWarnings,
} from "@/services/storage";
import {
  sftpOpen,
  sftpClose,
  sftpListDir,
  sessionListFiles,
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
  listAgentConnections,
  saveAgentDefinition,
  updateAgentDefinition as apiUpdateAgentDefinition,
  deleteAgentDefinition,
  createAgentFolder as apiCreateAgentFolder,
  updateAgentFolder as apiUpdateAgentFolder,
  deleteAgentFolder as apiDeleteAgentFolder,
  AgentSessionInfo,
  AgentDefinitionInfo,
  AgentFolderInfo,
  getCredentialStoreStatus as apiGetCredentialStoreStatus,
  getConnectionTypes,
} from "@/services/api";
import type { ConnectionTypeInfo } from "@/services/api";
import { RemoteAgentConfig } from "@/types/terminal";
import { TunnelConfig, TunnelState } from "@/types/tunnel";
import {
  getTunnels,
  saveTunnel as apiSaveTunnel,
  deleteTunnel as apiDeleteTunnel,
  startTunnel as apiStartTunnel,
  stopTunnel as apiStopTunnel,
  getTunnelStatuses,
} from "@/services/tunnelApi";
import { WorkspaceSummary, WorkspaceDefinition } from "@/types/workspace";
import {
  getWorkspaces as apiGetWorkspaces,
  loadWorkspace as apiLoadWorkspace,
  saveWorkspace as apiSaveWorkspace,
  deleteWorkspace as apiDeleteWorkspace,
  duplicateWorkspace as apiDuplicateWorkspace,
} from "@/services/workspaceApi";
import { buildTabGroupsFromWorkspace, captureAllTabGroups } from "@/utils/workspaceLayout";
import { SystemStats } from "@/types/monitoring";
import { applyTheme, onThemeChange } from "@/themes";
import { setOverrides as setKeybindingOverrides } from "@/services/keybindings";
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
  markActiveLeaf,
} from "@/utils/panelTree";

export type SidebarView = "connections" | "files" | "tunnels" | "workspaces";

/** Clipboard state for file browser copy/cut operations. */
export interface FileClipboard {
  entries: FileEntry[];
  operation: "copy" | "cut";
  sourceMode: "local" | "sftp" | "session";
  sourcePath: string;
  sftpSessionId: string | null;
  /** Terminal session ID for session-mode clipboard entries. */
  terminalSessionId?: string | null;
}

/**
 * Strip password from connection configs so it is never persisted,
 * unless `savePassword` is true (password will be routed to the backend
 * credential store).
 *
 * Works generically with any connection type that has `password` and
 * `savePassword` fields in its config.
 */
function stripPassword(connection: SavedConnection): SavedConnection {
  const cfg = connection.config.config as unknown as Record<string, unknown>;
  if (cfg.savePassword) {
    return connection; // Keep password for backend credential store routing
  }
  if (cfg.password) {
    return {
      ...connection,
      config: {
        ...connection.config,
        config: { ...cfg, password: undefined },
      } as ConnectionConfig,
    };
  }
  return connection;
}

interface AppState {
  // Connection type registry (loaded from backend at startup)
  connectionTypes: ConnectionTypeInfo[];

  // Platform default shell (detected from backend at startup)
  defaultShell: ShellType;

  // Sidebar
  sidebarView: SidebarView;
  sidebarCollapsed: boolean;
  sidebarWidth: number;
  setSidebarView: (view: SidebarView) => void;
  toggleSidebar: () => void;
  setSidebarWidth: (width: number) => void;

  // Password prompt
  passwordPromptOpen: boolean;
  passwordPromptHost: string;
  passwordPromptUsername: string;
  passwordPromptResolve: ((password: string | null) => void) | null;
  requestPassword: (host: string, username: string) => Promise<string | null>;
  submitPassword: (password: string) => void;
  dismissPasswordPrompt: () => void;

  // Tab Groups (workspace-level named panel trees)
  tabGroups: TabGroup[];
  activeTabGroupId: string;
  /** Create a new tab group and switch to it. Returns the new group ID. */
  addTabGroup: (name?: string) => string;
  closeTabGroup: (groupId: string) => void;
  renameTabGroup: (groupId: string, name: string) => void;
  setTabGroupColor: (groupId: string, color: string | null) => void;
  setActiveTabGroup: (groupId: string) => void;
  reorderTabGroups: (fromIndex: number, toIndex: number) => void;
  /** Move a tab from the active group into a different tab group. */
  moveTabToGroup: (tabId: string, fromPanelId: string, targetGroupId: string) => void;
  /** Create a new tab group and move a tab from the active group into it atomically. */
  addTabGroupWithTab: (tabId: string, fromPanelId: string) => void;

  // Tab drag state (shared across components for cross-group DnD)
  draggingTabId: string | null;
  setDraggingTabId: (id: string | null) => void;

  // Panels & Tabs
  rootPanel: PanelNode;
  activePanelId: string | null;
  addTab: (
    title: string,
    connectionType: string,
    config?: ConnectionConfig,
    panelId?: string,
    contentType?: TabContentType,
    terminalOptions?: TerminalOptions,
    sessionId?: string | null
  ) => void;
  openSettingsTab: () => void;
  openLogViewerTab: () => void;
  openEditorTab: (filePath: string, isRemote: boolean, sftpSessionId?: string) => void;
  openConnectionEditorTab: (connectionId: string, folderId?: string | null) => void;
  openAgentDefinitionEditorTab: (
    agentId: string,
    definitionId: string,
    folderId?: string | null
  ) => void;
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
  /** Update the backend session ID on a tab (called after the terminal session is created). */
  setTabSessionId: (tabId: string, sessionId: string | null) => void;

  // Connections
  folders: ConnectionFolder[];
  connections: SavedConnection[];
  settings: AppSettings;

  // Layout
  layoutConfig: LayoutConfig;
  layoutDialogOpen: boolean;
  setLayoutDialogOpen: (open: boolean) => void;
  updateLayoutConfig: (partial: Partial<LayoutConfig>) => void;
  applyLayoutPreset: (preset: "default" | "focus" | "zen") => void;

  // Shortcuts overlay
  shortcutsOverlayOpen: boolean;
  setShortcutsOverlayOpen: (open: boolean) => void;

  // Panel zoom overlay (runtime-only) — temporarily expand the active terminal tab to full view
  zoomedTabId: string | null;
  setZoomedTabId: (tabId: string | null) => void;
  /** Toggle zoom for the active terminal tab. Zooms in if nothing is zoomed; dismisses otherwise. */
  toggleZoomActiveTab: () => void;

  // Chord pending indicator
  chordPending: string | null;
  setChordPending: (pending: string | null) => void;

  // Zoom (runtime-only, not persisted) — scale factor for webview zoom
  zoomLevel: number;
  zoomIn: () => void;
  zoomOut: () => void;
  zoomReset: () => void;

  // Terminal search (runtime-only)
  terminalSearchVisible: Record<string, boolean>;
  setTerminalSearchVisible: (tabId: string, visible: boolean) => void;
  toggleTerminalSearch: (tabId: string) => void;

  // Large paste confirmation
  largePasteDialog: { open: boolean; charCount: number; onConfirm: (() => void) | null };
  showLargePasteDialog: (charCount: number, onConfirm: () => void) => void;
  closeLargePasteDialog: () => void;

  // Export/Import dialogs
  exportDialogOpen: boolean;
  setExportDialogOpen: (open: boolean) => void;
  importDialogOpen: boolean;
  importFileContent: string | undefined;
  setImportDialog: (open: boolean, content?: string) => void;

  // Recovery warnings from corrupt config files
  recoveryWarnings: RecoveryWarning[];
  recoveryDialogOpen: boolean;
  setRecoveryDialogOpen: (open: boolean) => void;

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
  moveConnectionToFile: (connectionId: string, targetSource: string | null) => Promise<void>;

  // File browser / SFTP
  fileEntries: FileEntry[];
  currentPath: string;
  sftpSessionId: string | null;
  sftpLoading: boolean;
  sftpError: string | null;
  sftpConnectedHost: string | null;
  setCurrentPath: (path: string) => void;
  setFileEntries: (entries: FileEntry[]) => void;
  connectSftp: (config: Record<string, unknown>) => Promise<void>;
  disconnectSftp: () => Promise<void>;
  navigateSftp: (path: string) => Promise<void>;
  refreshSftp: () => Promise<void>;

  // Per-tab CWD tracking
  tabCwds: Record<string, string>;
  setTabCwd: (tabId: string, cwd: string) => void;

  // Per-tab horizontal scrolling
  tabHorizontalScrolling: Record<string, boolean>;
  setTabHorizontalScrolling: (tabId: string, enabled: boolean) => void;

  // Per-tab terminal options (per-connection overrides)
  tabTerminalOptions: Record<string, TerminalOptions>;

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
  agentFolders: Record<string, AgentFolderInfo[]>;
  addRemoteAgent: (agent: RemoteAgentDefinition) => void;
  updateRemoteAgent: (agent: RemoteAgentDefinition) => void;
  deleteRemoteAgent: (agentId: string) => void;
  reorderRemoteAgents: (oldIndex: number, newIndex: number) => void;
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
  updateAgentDef: (agentId: string, params: Record<string, unknown>) => Promise<void>;
  deleteAgentDef: (agentId: string, definitionId: string) => Promise<void>;
  createAgentFolder: (agentId: string, name: string, parentId?: string | null) => Promise<void>;
  updateAgentFolder: (agentId: string, params: Record<string, unknown>) => Promise<void>;
  deleteAgentFolder: (agentId: string, folderId: string) => Promise<void>;
  toggleAgentFolder: (agentId: string, folderId: string) => void;

  // Local file browser state
  localFileEntries: FileEntry[];
  localCurrentPath: string;
  localFileLoading: boolean;
  localFileError: string | null;
  navigateLocal: (path: string) => Promise<void>;
  refreshLocal: () => Promise<void>;

  // Session-based file browser state (for remote-session tabs)
  sessionFileEntries: FileEntry[];
  sessionCurrentPath: string;
  sessionFileLoading: boolean;
  sessionFileError: string | null;
  /** Terminal session ID used for session-based file browsing. */
  sessionFileBrowserId: string | null;
  navigateSession: (sessionId: string, path: string) => Promise<void>;
  refreshSession: () => Promise<void>;
  setSessionFileBrowserId: (sessionId: string | null) => void;

  // File browser mode
  fileBrowserMode: "local" | "sftp" | "session" | "none";
  setFileBrowserMode: (mode: "local" | "sftp" | "session" | "none") => void;

  // File clipboard (copy/cut)
  fileClipboard: FileClipboard | null;
  setFileClipboard: (clipboard: FileClipboard | null) => void;

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
  connectMonitoring: (config: Record<string, unknown>) => Promise<void>;
  disconnectMonitoring: () => Promise<void>;
  refreshMonitoring: () => Promise<void>;

  // SSH Tunnels
  tunnels: TunnelConfig[];
  tunnelStates: Record<string, TunnelState>;
  loadTunnels: () => Promise<void>;
  saveTunnel: (config: TunnelConfig) => Promise<void>;
  deleteTunnel: (tunnelId: string) => Promise<void>;
  startTunnel: (tunnelId: string) => Promise<void>;
  stopTunnel: (tunnelId: string) => Promise<void>;
  updateTunnelState: (state: TunnelState) => void;
  openTunnelEditorTab: (tunnelId: string | null) => void;

  // Workspaces
  workspaces: WorkspaceSummary[];
  activeWorkspaceName: string | null;
  loadWorkspaces: () => Promise<void>;
  saveWorkspaceToBackend: (definition: WorkspaceDefinition) => Promise<void>;
  deleteWorkspaceFromBackend: (workspaceId: string) => Promise<void>;
  duplicateWorkspaceInBackend: (workspaceId: string) => Promise<void>;
  openWorkspaceEditorTab: (workspaceId: string | null) => void;
  launchWorkspace: (workspaceId: string) => Promise<void>;
  /** scope "all" captures all tab groups; "active" captures only the active group. */
  saveCurrentAsWorkspace: (
    name: string,
    scope: "all" | "active",
    description?: string
  ) => Promise<void>;

  // Credential store
  credentialStoreStatus: CredentialStoreStatusInfo | null;
  setCredentialStoreStatus: (status: CredentialStoreStatusInfo) => void;
  loadCredentialStoreStatus: () => Promise<void>;
  unlockDialogOpen: boolean;
  setUnlockDialogOpen: (open: boolean) => void;
  masterPasswordSetupOpen: boolean;
  masterPasswordSetupMode: "setup" | "change";
  openMasterPasswordSetup: (mode: "setup" | "change") => void;
  closeMasterPasswordSetup: () => void;
}

let tabCounter = 0;
let layoutPersistTimer: ReturnType<typeof setTimeout> | null = null;

function createTab(
  title: string,
  connectionType: string,
  config: ConnectionConfig,
  panelId: string,
  contentType: TabContentType = "terminal",
  sessionId: string | null = null
): TerminalTab {
  tabCounter++;
  return {
    id: `tab-${tabCounter}`,
    sessionId,
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

let groupCounter = 0;

/** Generate a unique tab group ID. */
function generateGroupId(): string {
  groupCounter++;
  return `group-${Date.now()}-${groupCounter}-${Math.random().toString(36).slice(2, 6)}`;
}

export const useAppStore = create<AppState>((set, get) => {
  const initialPanel = createLeafPanel();
  const initialGroupId = generateGroupId();
  const initialGroup: TabGroup = {
    id: initialGroupId,
    name: "Main",
    rootPanel: initialPanel,
    activePanelId: initialPanel.id,
  };

  return {
    // Connection type registry — updated by loadFromBackend()
    connectionTypes: [],

    // Platform default shell — updated by loadFromBackend()
    defaultShell: "bash",

    // Sidebar
    sidebarView: "connections",
    sidebarCollapsed: false,
    sidebarWidth: 260,
    setSidebarView: (view) =>
      set((state) => ({
        sidebarView: view,
        sidebarCollapsed: state.sidebarView === view && !state.sidebarCollapsed ? true : false,
      })),
    toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
    setSidebarWidth: (width) => set({ sidebarWidth: width }),

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

    // Tab Groups
    tabGroups: [initialGroup],
    activeTabGroupId: initialGroupId,

    addTabGroup: (name) => {
      const newGroupId = generateGroupId();
      const newPanel = createLeafPanel();
      set((state) => {
        const groupCount = state.tabGroups.length + 1;
        const newGroup: TabGroup = {
          id: newGroupId,
          name: name ?? `Group ${groupCount}`,
          rootPanel: newPanel,
          activePanelId: newPanel.id,
        };
        // Save current live state into the active group before switching
        const savedGroups = state.tabGroups.map((g) =>
          g.id === state.activeTabGroupId
            ? { ...g, rootPanel: state.rootPanel, activePanelId: state.activePanelId }
            : g
        );
        return {
          tabGroups: [...savedGroups, newGroup],
          activeTabGroupId: newGroupId,
          rootPanel: newPanel,
          activePanelId: newPanel.id,
        };
      });
      return newGroupId;
    },

    closeTabGroup: (groupId) =>
      set((state) => {
        if (state.tabGroups.length <= 1) return state;

        const newGroups = state.tabGroups.filter((g) => g.id !== groupId);

        if (groupId !== state.activeTabGroupId) {
          // Closing an inactive group — straightforward removal
          return { tabGroups: newGroups };
        }

        // Closing the active group — pick adjacent group
        const currentIdx = state.tabGroups.findIndex((g) => g.id === groupId);
        const newActiveIdx = Math.max(0, currentIdx - 1);
        const newActiveGroup = newGroups[newActiveIdx];
        return {
          tabGroups: newGroups,
          activeTabGroupId: newActiveGroup.id,
          rootPanel: newActiveGroup.rootPanel,
          activePanelId: newActiveGroup.activePanelId,
        };
      }),

    renameTabGroup: (groupId, name) =>
      set((state) => ({
        tabGroups: state.tabGroups.map((g) => (g.id === groupId ? { ...g, name } : g)),
      })),

    setTabGroupColor: (groupId, color) =>
      set((state) => ({
        tabGroups: state.tabGroups.map((g) =>
          g.id === groupId ? { ...g, color: color ?? undefined } : g
        ),
      })),

    setActiveTabGroup: (groupId) =>
      set((state) => {
        if (groupId === state.activeTabGroupId) return state;
        const targetGroup = state.tabGroups.find((g) => g.id === groupId);
        if (!targetGroup) return state;
        // Save current live state into the currently active group
        const savedGroups = state.tabGroups.map((g) =>
          g.id === state.activeTabGroupId
            ? { ...g, rootPanel: state.rootPanel, activePanelId: state.activePanelId }
            : g
        );
        return {
          tabGroups: savedGroups,
          activeTabGroupId: groupId,
          rootPanel: targetGroup.rootPanel,
          activePanelId: targetGroup.activePanelId,
        };
      }),

    reorderTabGroups: (fromIndex, toIndex) =>
      set((state) => {
        const groups = [...state.tabGroups];
        const [moved] = groups.splice(fromIndex, 1);
        groups.splice(toIndex, 0, moved);
        return { tabGroups: groups };
      }),

    moveTabToGroup: (tabId, fromPanelId, targetGroupId) =>
      set((state) => {
        if (targetGroupId === state.activeTabGroupId) return state;

        // Find the tab in the active group's live rootPanel
        const sourceLeaf = getAllLeaves(state.rootPanel).find((l) => l.id === fromPanelId);
        if (!sourceLeaf) return state;
        const tab = sourceLeaf.tabs.find((t) => t.id === tabId);
        if (!tab) return state;

        // Remove tab from active group's live rootPanel
        let newRootPanel = updateLeaf(state.rootPanel, fromPanelId, (leaf) =>
          removeTabFromLeaf(leaf, tabId)
        );

        // Clean up empty source panel (if not the sole leaf)
        const updatedSource = findLeaf(newRootPanel, fromPanelId);
        const allLeaves = getAllLeaves(newRootPanel);
        if (updatedSource && updatedSource.tabs.length === 0 && allLeaves.length > 1) {
          const removed = removeLeaf(newRootPanel, fromPanelId);
          newRootPanel = removed ? simplifyTree(removed) : newRootPanel;
        }

        // Find target group and add tab to its first leaf
        const targetGroupIndex = state.tabGroups.findIndex((g) => g.id === targetGroupId);
        if (targetGroupIndex === -1) return state;
        const targetGroup = state.tabGroups[targetGroupIndex];
        const targetLeaves = getAllLeaves(targetGroup.rootPanel);
        const targetLeaf = targetLeaves[0];
        if (!targetLeaf) return state;

        const movedTab: TerminalTab = { ...tab, panelId: targetLeaf.id, isActive: true };
        const newTargetRootPanel = updateLeaf(targetGroup.rootPanel, targetLeaf.id, (leaf) => ({
          ...leaf,
          tabs: [...leaf.tabs.map((t) => ({ ...t, isActive: false })), movedTab],
          activeTabId: movedTab.id,
        }));

        const newTabGroups = state.tabGroups.map((g, i) =>
          i === targetGroupIndex ? { ...g, rootPanel: newTargetRootPanel } : g
        );

        // Update active panel if the source panel was removed
        const newActivePanelId =
          state.activePanelId === fromPanelId
            ? (getAllLeaves(newRootPanel)[0]?.id ?? null)
            : state.activePanelId;

        return {
          rootPanel: newRootPanel,
          tabGroups: newTabGroups,
          activePanelId: newActivePanelId,
        };
      }),

    addTabGroupWithTab: (tabId, fromPanelId) =>
      set((state) => {
        // Find the tab in the active group's live rootPanel
        const sourceLeaf = getAllLeaves(state.rootPanel).find((l) => l.id === fromPanelId);
        if (!sourceLeaf) return state;
        const tab = sourceLeaf.tabs.find((t) => t.id === tabId);
        if (!tab) return state;

        // Remove tab from active group's live rootPanel
        let newSourceRootPanel = updateLeaf(state.rootPanel, fromPanelId, (leaf) =>
          removeTabFromLeaf(leaf, tabId)
        );

        // Clean up empty source panel (if not the sole leaf)
        const updatedSource = findLeaf(newSourceRootPanel, fromPanelId);
        const allSourceLeaves = getAllLeaves(newSourceRootPanel);
        if (updatedSource && updatedSource.tabs.length === 0 && allSourceLeaves.length > 1) {
          const removed = removeLeaf(newSourceRootPanel, fromPanelId);
          newSourceRootPanel = removed ? simplifyTree(removed) : newSourceRootPanel;
        }

        // Update active panel if the source panel was removed
        const newActivePanelId =
          state.activePanelId === fromPanelId
            ? (getAllLeaves(newSourceRootPanel)[0]?.id ?? null)
            : state.activePanelId;

        // Save the updated source group state
        const savedGroups = state.tabGroups.map((g) =>
          g.id === state.activeTabGroupId
            ? { ...g, rootPanel: newSourceRootPanel, activePanelId: newActivePanelId }
            : g
        );

        // Create the new group with the moved tab
        const newGroupId = generateGroupId();
        const newPanel = createLeafPanel();
        const movedTab: TerminalTab = { ...tab, panelId: newPanel.id, isActive: true };
        const newGroupRootPanel = updateLeaf(newPanel, newPanel.id, (leaf) => ({
          ...leaf,
          tabs: [movedTab],
          activeTabId: movedTab.id,
        }));
        const groupCount = state.tabGroups.length + 1;
        const newGroup: TabGroup = {
          id: newGroupId,
          name: `Group ${groupCount}`,
          rootPanel: newGroupRootPanel,
          activePanelId: newPanel.id,
        };

        return {
          tabGroups: [...savedGroups, newGroup],
          activeTabGroupId: newGroupId,
          rootPanel: newGroupRootPanel,
          activePanelId: newPanel.id,
        };
      }),

    draggingTabId: null,
    setDraggingTabId: (id) => set({ draggingTabId: id }),

    // Panels & Tabs
    rootPanel: initialPanel,
    activePanelId: initialPanel.id,

    getAllPanels: () => getAllLeaves(get().rootPanel),

    setTabSessionId: (tabId, sessionId) =>
      set((state) => {
        const leaf = findLeafByTab(state.rootPanel, tabId);
        if (!leaf) return state;
        return {
          rootPanel: updateLeaf(state.rootPanel, leaf.id, (l) => ({
            ...l,
            tabs: l.tabs.map((t) => (t.id === tabId ? { ...t, sessionId } : t)),
          })),
        };
      }),

    addTab: (title, connectionType, config, panelId, contentType, terminalOptions, sessionId) =>
      set((state) => {
        const allLeaves = getAllLeaves(state.rootPanel);
        const targetPanelId = panelId ?? state.activePanelId ?? allLeaves[0]?.id;
        if (!targetPanelId) return state;

        const defaultConfig: ConnectionConfig = config ?? {
          type: "local",
          config: { shell: state.defaultShell },
        };
        const newTab = createTab(
          title,
          connectionType,
          defaultConfig,
          targetPanelId,
          contentType,
          sessionId ?? null
        );
        const rootPanel = updateLeaf(state.rootPanel, targetPanelId, (leaf) => {
          const tabs = leaf.tabs.map((t) => ({ ...t, isActive: false }));
          tabs.push(newTab);
          return { ...leaf, tabs, activeTabId: newTab.id };
        });
        const hsEnabled =
          terminalOptions?.horizontalScrolling ??
          get().settings.defaultHorizontalScrolling ??
          false;
        const tabColor = terminalOptions?.color;
        // Store per-tab terminal options (excluding horizontalScrolling and color which are tracked separately)
        const tabOpts: TerminalOptions = {};
        if (terminalOptions?.fontFamily) tabOpts.fontFamily = terminalOptions.fontFamily;
        if (terminalOptions?.fontSize != null) tabOpts.fontSize = terminalOptions.fontSize;
        if (terminalOptions?.scrollbackBuffer != null)
          tabOpts.scrollbackBuffer = terminalOptions.scrollbackBuffer;
        if (terminalOptions?.cursorStyle) tabOpts.cursorStyle = terminalOptions.cursorStyle;
        if (terminalOptions?.cursorBlink != null) tabOpts.cursorBlink = terminalOptions.cursorBlink;
        const hasTabOpts = Object.keys(tabOpts).length > 0;
        return {
          rootPanel,
          activePanelId: targetPanelId,
          tabHorizontalScrolling: { ...state.tabHorizontalScrolling, [newTab.id]: hsEnabled },
          ...(tabColor ? { tabColors: { ...state.tabColors, [newTab.id]: tabColor } } : {}),
          ...(hasTabOpts
            ? { tabTerminalOptions: { ...state.tabTerminalOptions, [newTab.id]: tabOpts } }
            : {}),
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

        const dummyConfig: ConnectionConfig = { type: "local", config: { shell: "zsh" } };
        const newTab = createTab("Settings", "local", dummyConfig, targetPanelId, "settings");
        const rootPanel = updateLeaf(state.rootPanel, targetPanelId, (leaf) => {
          const tabs = leaf.tabs.map((t) => ({ ...t, isActive: false }));
          tabs.push(newTab);
          return { ...leaf, tabs, activeTabId: newTab.id };
        });
        return { rootPanel, activePanelId: targetPanelId };
      }),

    openLogViewerTab: () =>
      set((state) => {
        const allLeaves = getAllLeaves(state.rootPanel);

        // Look for an existing log-viewer tab
        for (const leaf of allLeaves) {
          const existing = leaf.tabs.find((t) => t.contentType === "log-viewer");
          if (existing) {
            const rootPanel = updateLeaf(state.rootPanel, leaf.id, (l) => ({
              ...l,
              tabs: l.tabs.map((t) => ({ ...t, isActive: t.id === existing.id })),
              activeTabId: existing.id,
            }));
            return { rootPanel, activePanelId: leaf.id };
          }
        }

        // No existing log-viewer tab — create one in the active panel
        const targetPanelId = state.activePanelId ?? allLeaves[0]?.id;
        if (!targetPanelId) return state;

        const dummyConfig: ConnectionConfig = { type: "local", config: { shell: "zsh" } };
        const newTab = createTab("Logs", "local", dummyConfig, targetPanelId, "log-viewer");
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
        const dummyConfig: ConnectionConfig = { type: "local", config: { shell: "zsh" } };
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
          const conn = state.connections.find((c) => c.id === connectionId);
          if (conn) {
            title = `Edit: ${conn.name}`;
          }
        }

        const dummyConfig: ConnectionConfig = { type: "local", config: { shell: "zsh" } };
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

    openAgentDefinitionEditorTab: (agentId, definitionId, folderId) =>
      set((state) => {
        const allLeaves = getAllLeaves(state.rootPanel);

        // Look for an existing editor tab for this agent definition
        for (const leaf of allLeaves) {
          const existing = leaf.tabs.find(
            (t) =>
              t.contentType === "connection-editor" &&
              t.connectionEditorMeta?.connectionId === agentId &&
              t.connectionEditorMeta?.agentDefinitionId === definitionId
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

        const targetPanelId = state.activePanelId ?? allLeaves[0]?.id;
        if (!targetPanelId) return state;

        // Determine title
        let title = "New Agent Connection";
        if (definitionId !== "new") {
          const defs = state.agentDefinitions[agentId] ?? [];
          const def = defs.find((d) => d.id === definitionId);
          if (def) title = `Edit: ${def.name}`;
        }

        const dummyConfig: ConnectionConfig = { type: "local", config: { shell: "zsh" } };
        const meta: ConnectionEditorMeta = {
          connectionId: agentId,
          folderId: null,
          agentDefinitionId: definitionId,
          agentFolderId: folderId ?? null,
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
        const { [tabId]: _removedOpts, ...remainingOpts } = state.tabTerminalOptions;
        const { [tabId]: _removedSearch, ...remainingSearch } = state.terminalSearchVisible;

        let rootPanel = updateLeaf(state.rootPanel, panelId, (leaf) =>
          removeTabFromLeaf(leaf, tabId)
        );

        // Dismiss zoom overlay if the zoomed tab is being closed
        const zoomedTabId = state.zoomedTabId === tabId ? null : state.zoomedTabId;

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
            zoomedTabId,
            tabCwds: remainingCwds,
            tabHorizontalScrolling: remainingHs,
            editorDirtyTabs: remainingDirty,
            tabColors: remainingColors,
            tabTerminalOptions: remainingOpts,
            terminalSearchVisible: remainingSearch,
          };
        }

        return {
          rootPanel,
          zoomedTabId,
          tabCwds: remainingCwds,
          tabHorizontalScrolling: remainingHs,
          editorDirtyTabs: remainingDirty,
          tabColors: remainingColors,
          tabTerminalOptions: remainingOpts,
          terminalSearchVisible: remainingSearch,
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
    settings: {
      version: "1",
      externalConnectionFiles: [],
      powerMonitoringEnabled: true,
      fileBrowserEnabled: true,
    },

    // Layout
    layoutConfig: DEFAULT_LAYOUT,
    layoutDialogOpen: false,

    setLayoutDialogOpen: (open) => set({ layoutDialogOpen: open }),

    // Shortcuts overlay
    shortcutsOverlayOpen: false,
    setShortcutsOverlayOpen: (open) => set({ shortcutsOverlayOpen: open }),

    // Panel zoom overlay
    zoomedTabId: null,
    setZoomedTabId: (tabId) => set({ zoomedTabId: tabId }),
    toggleZoomActiveTab: () => {
      const { activePanelId, rootPanel, zoomedTabId } = get();
      if (zoomedTabId !== null) {
        set({ zoomedTabId: null });
        return;
      }
      const leaves = getAllLeaves(rootPanel);
      const panel = leaves.find((p) => p.id === activePanelId) ?? leaves[0];
      if (panel?.activeTabId) {
        const tab = panel.tabs.find((t) => t.id === panel.activeTabId);
        if (tab?.contentType === "terminal") {
          set({ zoomedTabId: panel.activeTabId });
        }
      }
    },

    // Chord pending indicator
    chordPending: null,
    setChordPending: (pending) => set({ chordPending: pending }),

    // Zoom (runtime-only, not persisted) — scale factor for webview zoom
    zoomLevel: 1.0,
    zoomIn: () =>
      set((s) => ({ zoomLevel: Math.min(parseFloat((s.zoomLevel * 1.1).toFixed(2)), 3.0) })),
    zoomOut: () =>
      set((s) => ({ zoomLevel: Math.max(parseFloat((s.zoomLevel / 1.1).toFixed(2)), 0.5) })),
    zoomReset: () => set({ zoomLevel: 1.0 }),

    // Terminal search (runtime-only)
    terminalSearchVisible: {},
    setTerminalSearchVisible: (tabId, visible) =>
      set((s) => ({ terminalSearchVisible: { ...s.terminalSearchVisible, [tabId]: visible } })),
    toggleTerminalSearch: (tabId) =>
      set((s) => ({
        terminalSearchVisible: {
          ...s.terminalSearchVisible,
          [tabId]: !s.terminalSearchVisible[tabId],
        },
      })),

    // Large paste confirmation
    largePasteDialog: { open: false, charCount: 0, onConfirm: null },
    showLargePasteDialog: (charCount, onConfirm) =>
      set({ largePasteDialog: { open: true, charCount, onConfirm } }),
    closeLargePasteDialog: () =>
      set({ largePasteDialog: { open: false, charCount: 0, onConfirm: null } }),

    // Export/Import dialogs
    exportDialogOpen: false,
    setExportDialogOpen: (open) => set({ exportDialogOpen: open }),
    importDialogOpen: false,
    importFileContent: undefined,
    setImportDialog: (open, content) => set({ importDialogOpen: open, importFileContent: content }),

    // Recovery warnings from corrupt config files
    recoveryWarnings: [],
    recoveryDialogOpen: false,
    setRecoveryDialogOpen: (open) => set({ recoveryDialogOpen: open }),

    updateLayoutConfig: (partial) => {
      const updated = { ...get().layoutConfig, ...partial };
      set({ layoutConfig: updated });
      if (layoutPersistTimer) clearTimeout(layoutPersistTimer);
      layoutPersistTimer = setTimeout(() => {
        const current = get();
        persistSettings({ ...current.settings, layout: updated }).catch((err) =>
          console.error("Failed to persist layout config:", err)
        );
      }, 300);
    },

    applyLayoutPreset: (preset) => {
      const config = LAYOUT_PRESETS[preset];
      if (!config) return;
      set({ layoutConfig: config });
      if (layoutPersistTimer) clearTimeout(layoutPersistTimer);
      layoutPersistTimer = setTimeout(() => {
        const current = get();
        persistSettings({ ...current.settings, layout: config }).catch((err) =>
          console.error("Failed to persist layout preset:", err)
        );
      }, 300);
    },

    loadFromBackend: async () => {
      try {
        const { connections, folders, agents, externalErrors } = await loadConnections();
        const settings = await getSettings();
        // Hydrate agents: add ephemeral state (disconnected, collapsed)
        const remoteAgents = agents.map((a) => ({
          ...a,
          isExpanded: false,
          connectionState: "disconnected" as const,
        }));
        if (externalErrors.length > 0) {
          for (const err of externalErrors) {
            console.error(`Failed to load external file ${err.filePath}: ${err.error}`);
          }
        }
        const layoutConfig = settings.layout ?? DEFAULT_LAYOUT;
        set({ connections, folders, settings, remoteAgents, layoutConfig });
        applyTheme(settings.theme);
        if (settings.keybindingOverrides) {
          setKeybindingOverrides(settings.keybindingOverrides);
        }
        // Re-render terminals when OS theme changes in system mode
        onThemeChange(() => {
          set({});
        });
      } catch (err) {
        console.error("Failed to load connections from backend:", err);
      }
      // Load connection type registry
      try {
        const connectionTypes = await getConnectionTypes();
        set({ connectionTypes });
      } catch (err) {
        console.error("Failed to load connection types:", err);
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
      // Load SSH tunnels
      get().loadTunnels();
      // Load workspaces
      get().loadWorkspaces();
      // Load credential store status and auto-open unlock dialog if locked
      await get().loadCredentialStoreStatus();
      const credStatus = get().credentialStoreStatus;
      if (credStatus?.mode === "master_password" && credStatus?.status === "locked") {
        set({ unlockDialogOpen: true });
      }
      // Check VS Code availability in the background
      get().checkVscodeAvailability();
      // Check for recovery warnings from corrupt config files
      try {
        const warnings = await getRecoveryWarnings();
        if (warnings.length > 0) {
          set({ recoveryWarnings: warnings, recoveryDialogOpen: true });
        }
      } catch (err) {
        console.error("Failed to load recovery warnings:", err);
      }
    },

    updateSettings: async (newSettings) => {
      try {
        const oldSettings = get().settings;
        await persistSettings(newSettings);
        set({ settings: newSettings });

        if (oldSettings.theme !== newSettings.theme) {
          applyTheme(newSettings.theme);
        }

        // Side-effects when global defaults are toggled off.
        // Only disconnect if the active tab doesn't have an explicit override.
        if (oldSettings.powerMonitoringEnabled && !newSettings.powerMonitoringEnabled) {
          const activeTab = getActiveTab(get());
          const tabCfg = activeTab?.config.config as unknown as Record<string, unknown> | undefined;
          const hasOverride = tabCfg?.enableMonitoring === true;
          if (!hasOverride) {
            get().disconnectMonitoring();
          }
        }
        if (oldSettings.fileBrowserEnabled && !newSettings.fileBrowserEnabled) {
          const activeTab = getActiveTab(get());
          const tabCfg = activeTab?.config.config as unknown as Record<string, unknown> | undefined;
          const hasOverride = tabCfg?.enableFileBrowser === true;
          if (!hasOverride) {
            get().disconnectSftp();
            if (get().sidebarView === "files") {
              set({ sidebarView: "connections" });
            }
          }
        }
      } catch (err) {
        console.error("Failed to save settings:", err);
      }
    },

    reloadExternalConnections: async () => {
      try {
        const externalConns = await apiReloadExternalConnections();
        set((state) => {
          // Replace external connections (those with sourceFile) while keeping main ones
          const mainConns = state.connections.filter((c) => !c.sourceFile);
          return { connections: [...mainConns, ...externalConns] };
        });
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
      persistConnection(stripPassword(connection))
        .then(() => loadConnections())
        .then(({ connections, folders }) => set({ connections, folders }))
        .catch((err) => console.error("Failed to persist new connection:", err));
    },

    updateConnection: (connection) => {
      set((state) => ({
        connections: state.connections.map((c) => (c.id === connection.id ? connection : c)),
      }));
      persistConnection(stripPassword(connection))
        .then(() => loadConnections())
        .then(({ connections, folders }) => set({ connections, folders }))
        .catch((err) => console.error("Failed to persist connection update:", err));
    },

    deleteConnection: (connectionId) => {
      const conn = get().connections.find((c) => c.id === connectionId);
      set((state) => ({
        connections: state.connections.filter((c) => c.id !== connectionId),
      }));
      removeConnection(connectionId, conn?.sourceFile).catch((err) =>
        console.error("Failed to persist connection deletion:", err)
      );
    },

    addFolder: (folder) => {
      set((state) => ({ folders: [...state.folders, folder] }));
      persistFolder(folder)
        .then(() => loadConnections())
        .then(({ connections, folders }) => set({ connections, folders }))
        .catch((err) => console.error("Failed to persist new folder:", err));
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

        return { folders, connections };
      });
      removeFolder(folderId)
        .then(() => loadConnections())
        .then(({ connections, folders }) => set({ connections, folders }))
        .catch((err) => console.error("Failed to persist folder deletion:", err));
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
      persistConnection(stripPassword(duplicate))
        .then(() => loadConnections())
        .then(({ connections, folders }) => set({ connections, folders }))
        .catch((err) => console.error("Failed to persist duplicated connection:", err));
    },

    moveConnectionToFile: async (connectionId, targetSource) => {
      const conn = get().connections.find((c) => c.id === connectionId);
      if (!conn) return;
      const currentSource = conn.sourceFile ?? null;
      if (currentSource === targetSource) return;
      try {
        const updated = await apiMoveConnectionToFile(connectionId, currentSource, targetSource);
        set((state) => ({
          connections: state.connections.map((c) => (c.id === connectionId ? updated : c)),
        }));
      } catch (err) {
        console.error("Failed to move connection to file:", err);
      }
    },

    moveConnectionToFolder: (connectionId, folderId) => {
      // Optimistic update for instant visual feedback
      set((state) => ({
        connections: state.connections.map((c) => (c.id === connectionId ? { ...c, folderId } : c)),
      }));

      // Persist to backend, then reload to sync any dedup renames
      // (e.g., when moving a connection into a folder with a same-named sibling)
      const moved = get().connections.find((c) => c.id === connectionId);
      if (moved) {
        persistConnection(stripPassword(moved))
          .then(() => loadConnections())
          .then(({ connections, folders }) => set({ connections, folders }))
          .catch((err) => console.error("Failed to persist connection move:", err));
      }
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

    connectSftp: async (config: Record<string, unknown>) => {
      set({ sftpLoading: true, sftpError: null });
      try {
        const sessionId = await sftpOpen(config);
        const homePath = `/home/${config.username as string}`;
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
          sftpConnectedHost: `${config.username as string}@${config.host as string}:${config.port as number}`,
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

    // Per-tab terminal options
    tabTerminalOptions: {},

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
    agentFolders: {},

    addRemoteAgent: (agent) => {
      set((state) => ({ remoteAgents: [...state.remoteAgents, agent] }));
      persistAgent({ id: agent.id, name: agent.name, config: agent.config }).catch((err) =>
        console.error("Failed to persist new agent:", err)
      );
    },

    updateRemoteAgent: (agent) => {
      set((state) => ({
        remoteAgents: state.remoteAgents.map((a) => (a.id === agent.id ? agent : a)),
      }));
      persistAgent({ id: agent.id, name: agent.name, config: agent.config }).catch((err) =>
        console.error("Failed to persist agent update:", err)
      );
    },

    reorderRemoteAgents: (oldIndex, newIndex) => {
      set((state) => {
        const agents = [...state.remoteAgents];
        const [moved] = agents.splice(oldIndex, 1);
        agents.splice(newIndex, 0, moved);
        return { remoteAgents: agents };
      });
      const agentIds = get().remoteAgents.map((a) => a.id);
      persistAgentOrder(agentIds).catch((err) =>
        console.error("Failed to persist agent reorder:", err)
      );
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
        agentFolders: Object.fromEntries(
          Object.entries(s.agentFolders).filter(([k]) => k !== agentId)
        ),
      }));
      removeAgent(agentId).catch((err) => console.error("Failed to persist agent deletion:", err));
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
        throw err;
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
        agentFolders: { ...s.agentFolders, [agentId]: [] },
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
        const [sessions, connectionsData] = await Promise.all([
          listAgentSessions(agentId),
          listAgentConnections(agentId),
        ]);
        set((s) => ({
          agentSessions: { ...s.agentSessions, [agentId]: sessions },
          agentDefinitions: { ...s.agentDefinitions, [agentId]: connectionsData.connections },
          agentFolders: { ...s.agentFolders, [agentId]: connectionsData.folders },
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

    updateAgentDef: async (agentId, params) => {
      try {
        const updated = await apiUpdateAgentDefinition(agentId, params);
        set((s) => ({
          agentDefinitions: {
            ...s.agentDefinitions,
            [agentId]: (s.agentDefinitions[agentId] ?? []).map((d) =>
              d.id === updated.id ? updated : d
            ),
          },
        }));
      } catch (err) {
        console.error(`Failed to update agent definition on ${agentId}:`, err);
      }
    },

    createAgentFolder: async (agentId, name, parentId) => {
      try {
        const folder = await apiCreateAgentFolder(agentId, name, parentId);
        set((s) => ({
          agentFolders: {
            ...s.agentFolders,
            [agentId]: [...(s.agentFolders[agentId] ?? []), folder],
          },
        }));
      } catch (err) {
        console.error(`Failed to create agent folder on ${agentId}:`, err);
      }
    },

    updateAgentFolder: async (agentId, params) => {
      try {
        const updated = await apiUpdateAgentFolder(agentId, params);
        set((s) => ({
          agentFolders: {
            ...s.agentFolders,
            [agentId]: (s.agentFolders[agentId] ?? []).map((f) =>
              f.id === updated.id ? updated : f
            ),
          },
        }));
      } catch (err) {
        console.error(`Failed to update agent folder on ${agentId}:`, err);
      }
    },

    deleteAgentFolder: async (agentId, folderId) => {
      try {
        await apiDeleteAgentFolder(agentId, folderId);
        set((s) => ({
          agentFolders: {
            ...s.agentFolders,
            [agentId]: (s.agentFolders[agentId] ?? []).filter((f) => f.id !== folderId),
          },
          // Agent moves children to root — reflect in UI
          agentDefinitions: {
            ...s.agentDefinitions,
            [agentId]: (s.agentDefinitions[agentId] ?? []).map((d) =>
              d.folderId === folderId ? { ...d, folderId: null } : d
            ),
          },
        }));
      } catch (err) {
        console.error(`Failed to delete agent folder on ${agentId}:`, err);
      }
    },

    toggleAgentFolder: (agentId, folderId) => {
      set((s) => ({
        agentFolders: {
          ...s.agentFolders,
          [agentId]: (s.agentFolders[agentId] ?? []).map((f) =>
            f.id === folderId ? { ...f, isExpanded: !f.isExpanded } : f
          ),
        },
      }));
      // Fire-and-forget: persist expansion state on agent
      const folder = (get().agentFolders[agentId] ?? []).find((f) => f.id === folderId);
      if (folder) {
        apiUpdateAgentFolder(agentId, { id: folderId, is_expanded: folder.isExpanded }).catch(
          () => {}
        );
      }
    },

    // Local file browser state
    localFileEntries: [],
    localCurrentPath: "/",
    localFileLoading: false,
    localFileError: null,

    navigateLocal: async (path: string) => {
      // Normalize Windows backslashes to forward slashes so path manipulation
      // in the frontend (navigateUp, path join) works uniformly on all platforms.
      // Also expand bare drive letters (e.g. "C:") to their root form ("C:/")
      // so the Up button can reliably detect the drive root boundary.
      let normalizedPath = path.replace(/\\/g, "/");
      if (/^[A-Za-z]:$/.test(normalizedPath)) {
        normalizedPath = normalizedPath + "/";
      }
      set({ localFileLoading: true, localFileError: null });
      try {
        const entries = await localListDir(normalizedPath);
        set({
          localFileEntries: entries,
          localCurrentPath: normalizedPath,
          localFileLoading: false,
        });
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

    // Session-based file browser state
    sessionFileEntries: [],
    sessionCurrentPath: "/",
    sessionFileLoading: false,
    sessionFileError: null,
    sessionFileBrowserId: null,
    setSessionFileBrowserId: (sessionId) => set({ sessionFileBrowserId: sessionId }),

    navigateSession: async (sessionId: string, path: string) => {
      set({ sessionFileLoading: true, sessionFileError: null });
      try {
        const entries = await sessionListFiles(sessionId, path);
        set({
          sessionFileEntries: entries,
          sessionCurrentPath: path,
          sessionFileLoading: false,
        });
      } catch (err) {
        set({
          sessionFileLoading: false,
          sessionFileError: err instanceof Error ? err.message : String(err),
        });
      }
    },

    refreshSession: async () => {
      const { sessionFileBrowserId, sessionCurrentPath } = useAppStore.getState();
      if (!sessionFileBrowserId) return;
      set({ sessionFileLoading: true, sessionFileError: null });
      try {
        const entries = await sessionListFiles(sessionFileBrowserId, sessionCurrentPath);
        set({ sessionFileEntries: entries, sessionFileLoading: false });
      } catch (err) {
        set({
          sessionFileLoading: false,
          sessionFileError: err instanceof Error ? err.message : String(err),
        });
      }
    },

    // File browser mode
    fileBrowserMode: "none",
    setFileBrowserMode: (mode) => set({ fileBrowserMode: mode }),

    // File clipboard (copy/cut)
    fileClipboard: null,
    setFileClipboard: (clipboard) => set({ fileClipboard: clipboard }),

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

    connectMonitoring: async (config: Record<string, unknown>) => {
      set({ monitoringLoading: true, monitoringError: null });
      try {
        const sessionId = await monitoringOpen(config);
        const stats = await monitoringFetchStats(sessionId);
        set({
          monitoringSessionId: sessionId,
          monitoringHost: `${config.username as string}@${config.host as string}:${config.port as number}`,
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
      try {
        const stats = await monitoringFetchStats(monitoringSessionId);
        set({ monitoringStats: stats, monitoringError: null });
      } catch (err) {
        set({
          monitoringError: err instanceof Error ? err.message : String(err),
        });
      }
    },

    // SSH Tunnels
    tunnels: [],
    tunnelStates: {},

    loadTunnels: async () => {
      try {
        const tunnels = await getTunnels();
        const statuses = await getTunnelStatuses();
        const tunnelStates: Record<string, TunnelState> = {};
        for (const s of statuses) {
          tunnelStates[s.tunnelId] = s;
        }
        set({ tunnels, tunnelStates });
      } catch (err) {
        console.error("Failed to load tunnels:", err);
      }
    },

    saveTunnel: async (config) => {
      try {
        await apiSaveTunnel(config);
        set((state) => {
          const exists = state.tunnels.some((t) => t.id === config.id);
          const tunnels = exists
            ? state.tunnels.map((t) => (t.id === config.id ? config : t))
            : [...state.tunnels, config];
          return { tunnels };
        });
      } catch (err) {
        console.error("Failed to save tunnel:", err);
        throw err;
      }
    },

    deleteTunnel: async (tunnelId) => {
      try {
        await apiDeleteTunnel(tunnelId);
        set((state) => ({
          tunnels: state.tunnels.filter((t) => t.id !== tunnelId),
          tunnelStates: Object.fromEntries(
            Object.entries(state.tunnelStates).filter(([k]) => k !== tunnelId)
          ),
        }));
      } catch (err) {
        console.error("Failed to delete tunnel:", err);
      }
    },

    startTunnel: async (tunnelId) => {
      try {
        await apiStartTunnel(tunnelId);
      } catch (err) {
        console.error("Failed to start tunnel:", err);
        throw err;
      }
    },

    stopTunnel: async (tunnelId) => {
      try {
        await apiStopTunnel(tunnelId);
      } catch (err) {
        console.error("Failed to stop tunnel:", err);
        throw err;
      }
    },

    updateTunnelState: (state) => {
      set((s) => ({
        tunnelStates: { ...s.tunnelStates, [state.tunnelId]: state },
      }));
    },

    openTunnelEditorTab: (tunnelId) =>
      set((state) => {
        const allLeaves = getAllLeaves(state.rootPanel);

        // Look for an existing tunnel-editor tab for this tunnel
        for (const leaf of allLeaves) {
          const existing = leaf.tabs.find(
            (t) => t.contentType === "tunnel-editor" && t.tunnelEditorMeta?.tunnelId === tunnelId
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

        // Create new tunnel-editor tab in the active panel
        const targetPanelId = state.activePanelId ?? allLeaves[0]?.id;
        if (!targetPanelId) return state;

        let title = "New Tunnel";
        if (tunnelId) {
          const tunnel = state.tunnels.find((t) => t.id === tunnelId);
          if (tunnel) {
            title = `Edit: ${tunnel.name}`;
          }
        }

        const dummyConfig: ConnectionConfig = { type: "local", config: { shell: "zsh" } };
        const meta: TunnelEditorMeta = { tunnelId };
        const newTab = createTab(title, "local", dummyConfig, targetPanelId, "tunnel-editor");
        newTab.tunnelEditorMeta = meta;

        const rootPanel = updateLeaf(state.rootPanel, targetPanelId, (leaf) => {
          const tabs = leaf.tabs.map((t) => ({ ...t, isActive: false }));
          tabs.push(newTab);
          return { ...leaf, tabs, activeTabId: newTab.id };
        });
        return { rootPanel, activePanelId: targetPanelId };
      }),

    // Workspaces
    workspaces: [],
    activeWorkspaceName: null,

    loadWorkspaces: async () => {
      try {
        const workspaces = await apiGetWorkspaces();
        set({ workspaces });
      } catch (err) {
        console.error("Failed to load workspaces:", err);
      }
    },

    saveWorkspaceToBackend: async (definition) => {
      try {
        await apiSaveWorkspace(definition);
        await get().loadWorkspaces();
      } catch (err) {
        console.error("Failed to save workspace:", err);
        throw err;
      }
    },

    deleteWorkspaceFromBackend: async (workspaceId) => {
      try {
        await apiDeleteWorkspace(workspaceId);
        set((state) => ({
          workspaces: state.workspaces.filter((ws) => ws.id !== workspaceId),
        }));
      } catch (err) {
        console.error("Failed to delete workspace:", err);
      }
    },

    duplicateWorkspaceInBackend: async (workspaceId) => {
      try {
        await apiDuplicateWorkspace(workspaceId);
        await get().loadWorkspaces();
      } catch (err) {
        console.error("Failed to duplicate workspace:", err);
      }
    },

    openWorkspaceEditorTab: (workspaceId) =>
      set((state) => {
        const allLeaves = getAllLeaves(state.rootPanel);

        // Look for an existing workspace-editor tab for this workspace
        for (const leaf of allLeaves) {
          const existing = leaf.tabs.find(
            (t) =>
              t.contentType === "workspace-editor" &&
              t.workspaceEditorMeta?.workspaceId === workspaceId
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

        // Create new workspace-editor tab in the active panel
        const targetPanelId = state.activePanelId ?? allLeaves[0]?.id;
        if (!targetPanelId) return state;

        let title = "New Workspace";
        if (workspaceId) {
          const ws = state.workspaces.find((w) => w.id === workspaceId);
          if (ws) {
            title = `Edit: ${ws.name}`;
          }
        }

        const dummyConfig: ConnectionConfig = { type: "local", config: { shell: "zsh" } };
        const meta: WorkspaceEditorMeta = { workspaceId };
        const newTab = createTab(title, "local", dummyConfig, targetPanelId, "workspace-editor");
        newTab.workspaceEditorMeta = meta;

        const rootPanel = updateLeaf(state.rootPanel, targetPanelId, (leaf) => {
          const tabs = leaf.tabs.map((t) => ({ ...t, isActive: false }));
          tabs.push(newTab);
          return { ...leaf, tabs, activeTabId: newTab.id };
        });
        return { rootPanel, activePanelId: targetPanelId };
      }),

    launchWorkspace: async (workspaceId) => {
      try {
        const definition = await apiLoadWorkspace(workspaceId);
        const state = get();
        const builtGroups = buildTabGroupsFromWorkspace(
          definition.tabGroups,
          state.connections,
          state.defaultShell
        );
        if (builtGroups.length === 0) return;
        const firstGroup = builtGroups[0];
        set({
          tabGroups: builtGroups,
          activeTabGroupId: firstGroup.id,
          rootPanel: firstGroup.rootPanel,
          activePanelId: firstGroup.activePanelId,
          activeWorkspaceName: definition.name,
        });
      } catch (err) {
        console.error("Failed to launch workspace:", err);
      }
    },

    saveCurrentAsWorkspace: async (name, scope, description) => {
      try {
        const state = get();
        const activeGroup = state.tabGroups.find((g) => g.id === state.activeTabGroupId);
        const tabGroups =
          scope === "active" && activeGroup
            ? captureAllTabGroups(
                [activeGroup],
                state.activeTabGroupId,
                state.rootPanel,
                state.connections
              )
            : captureAllTabGroups(
                state.tabGroups,
                state.activeTabGroupId,
                state.rootPanel,
                state.connections
              );
        const id = `ws-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        await apiSaveWorkspace({ id, name, description, tabGroups });
        await get().loadWorkspaces();
        set({ activeWorkspaceName: name });
      } catch (err) {
        console.error("Failed to save current layout as workspace:", err);
        throw err;
      }
    },

    // Credential store
    credentialStoreStatus: null,
    setCredentialStoreStatus: (status) => set({ credentialStoreStatus: status }),
    loadCredentialStoreStatus: async () => {
      try {
        const status = await apiGetCredentialStoreStatus();
        set({ credentialStoreStatus: status });
      } catch (err) {
        console.error("Failed to load credential store status:", err);
      }
    },
    unlockDialogOpen: false,
    setUnlockDialogOpen: (open) => set({ unlockDialogOpen: open }),
    masterPasswordSetupOpen: false,
    masterPasswordSetupMode: "setup",
    openMasterPasswordSetup: (mode) =>
      set({ masterPasswordSetupOpen: true, masterPasswordSetupMode: mode }),
    closeMasterPasswordSetup: () => set({ masterPasswordSetupOpen: false }),
  };
});

// Track last-focused leaf in split containers for directional navigation (#448).
// When activePanelId changes, mark all ancestor SplitContainers so that
// navigating back into a subtree restores the last-focused panel.
useAppStore.subscribe((state, prev) => {
  if (state.activePanelId && state.activePanelId !== prev.activePanelId) {
    const updated = markActiveLeaf(state.rootPanel, state.activePanelId);
    if (updated !== state.rootPanel) {
      useAppStore.setState({ rootPanel: updated });
    }
  }
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
