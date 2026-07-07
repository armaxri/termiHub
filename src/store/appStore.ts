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
  NetworkDiagnosticMeta,
  NetworkTool,
  TabGroup,
  TerminalExitInfo,
} from "@/types/terminal";
import type { HttpMonitorState } from "@/types/network";
import {
  SavedConnection,
  ConnectionFolder,
  FileEntry,
  SftpStatus,
  AppSettings,
  RemoteAgentDefinition,
  AgentCapabilities,
  AgentSettings,
  LayoutConfig,
  DEFAULT_LAYOUT,
  LAYOUT_PRESETS,
  RecoveryWarning,
  PersistentRunState,
  PersistentSessionEntry,
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
  sftpRealpath,
  sessionListFiles,
  localListDir,
  vscodeAvailable as checkVscode,
  monitoringOpen,
  monitoringClose,
  monitoringFetchStats,
  sessionGetCapabilities,
  sessionMonitoringOpen,
  sessionMonitoringClose,
  listAvailableShells,
  getDefaultShell,
  connectAgent as apiConnectAgent,
  disconnectAgent as apiDisconnectAgent,
  applyAgentSettings as apiApplyAgentSettings,
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
  getAppMode as apiGetAppMode,
  checkForUpdates as apiCheckForUpdates,
  skipUpdateVersion as apiSkipUpdateVersion,
  clearSkippedVersion as apiClearSkippedVersion,
  startPersistentSession as apiStartPersistentSession,
  stopPersistentSession as apiStopPersistentSession,
  attachPersistentTab as apiAttachPersistentTab,
  adoptPersistentSession as apiAdoptPersistentSession,
  closeTerminal as apiCloseTerminal,
  detachPersistentTab as apiDetachPersistentTab,
} from "@/services/api";
import type { ConnectionTypeInfo } from "@/services/api";
import { RemoteAgentConfig } from "@/types/terminal";
import { TunnelConfig, TunnelState } from "@/types/tunnel";
import { EmbeddedServerConfig, ServerState as EmbeddedServerState } from "@/types/embeddedServer";
import {
  listEmbeddedServers,
  saveEmbeddedServer as apiSaveEmbeddedServer,
  deleteEmbeddedServer as apiDeleteEmbeddedServer,
  startEmbeddedServer as apiStartEmbeddedServer,
  stopEmbeddedServer as apiStopEmbeddedServer,
  getEmbeddedServerStates,
  createAndStartServer as apiCreateAndStartServer,
} from "@/services/embeddedServerApi";
import { DEFAULT_PORTS, ServerType } from "@/types/embeddedServer";
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
import {
  buildTabGroupsFromWorkspace,
  captureAllTabGroups,
  getWorkspaceLeaves,
} from "@/utils/workspaceLayout";
import {
  saveLastSession as apiSaveLastSession,
  loadLastSession as apiLoadLastSession,
  clearLastSession as apiClearLastSession,
} from "@/services/lastSessionApi";
import { resolveConnectionCredential } from "@/utils/resolveConnectionCredential";
import { SystemStats } from "@/types/monitoring";
import { onSessionMonitoringStats, onPersistentSessionStateChanged } from "@/services/events";
import { applyTheme, onThemeChange } from "@/themes";
import { setOverrides as setKeybindingOverrides } from "@/services/keybindings";
import {
  registerAdditionalLanguagePackages,
  registerCustomGrammars,
} from "@/utils/monacoCustomLanguages";
import { frontendLog } from "@/utils/frontendLog";
import { toast } from "@/components/ui";
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

export type SidebarView =
  | "connections"
  | "files"
  | "tunnels"
  | "services"
  | "workspaces"
  | "network-tools";

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

/** Return a new Record with `key` removed. */
function omitKey<V>(rec: Record<string, V>, key: string): Record<string, V> {
  const { [key]: _, ...rest } = rec;
  return rest;
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
  const hasNonEmptyPassword =
    typeof cfg.password === "string" && (cfg.password as string).length > 0;
  if (hasNonEmptyPassword && cfg.savePassword) {
    return connection; // Let backend route non-empty password to credential store
  }
  if (cfg.password !== undefined) {
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
  /** Whether the user checked "Save password" in the last password prompt. */
  passwordPromptShouldSave: boolean;
  requestPassword: (host: string, username: string) => Promise<string | null>;
  submitPassword: (password: string, shouldSave?: boolean) => void;
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
    sessionId?: string | null,
    persistentConnectionId?: string
  ) => string;

  // Persistent connection sessions
  /** Live state of all persistent connection sessions, keyed by connectionId. */
  persistentSessions: Record<string, PersistentSessionEntry>;
  /** Start the background process for a persistent connection (does not open a tab). */
  startPersistentSession: (connectionId: string) => Promise<void>;
  /** Attach a new terminal tab to an already-running persistent session. */
  attachPersistentSession: (connectionId: string, panelId?: string) => Promise<void>;
  /** Gracefully stop the background process for a persistent connection. */
  stopPersistentSession: (connectionId: string) => Promise<void>;
  /** Update the store entry for a persistent session (called from event listener). */
  setPersistentSessionEntry: (connectionId: string, patch: Partial<PersistentSessionEntry>) => void;
  /** Transition a persistent session to the error state (called when process dies unexpectedly). */
  setPersistentSessionError: (connectionId: string, errorMessage: string) => void;
  /**
   * Start a persistent background session for an agent-hosted connection definition.
   * Resolves with the backend session ID on success, or `null` if the API call failed
   * (in which case the entry is left in the `error` state).
   */
  startAgentPersistentSession: (
    agentId: string,
    def: AgentDefinitionInfo
  ) => Promise<string | null>;
  /** Attach a new terminal tab to a running agent-hosted persistent session. */
  attachAgentPersistentSession: (
    agentId: string,
    def: AgentDefinitionInfo,
    panelId?: string
  ) => Promise<void>;
  /**
   * Start a persistent agent session if not already running, then attach a tab.
   * Used by the sidebar double-click handler so the session is registered with
   * the persistent-session machinery (sidebar state dot turns green) rather than
   * opening an unmanaged tab through `createTerminal`.
   */
  startAndAttachAgentPersistentSession: (
    agentId: string,
    def: AgentDefinitionInfo,
    panelId?: string
  ) => Promise<void>;
  /**
   * Restart (or reattach to) the persistent session backing `tabId` and write
   * the resulting live session id onto the tab. Used by the terminal reconnect
   * path so a persistent tab whose session was destroyed gets a fresh live
   * session instead of reattaching to a dead one. Resolves with the new session
   * id, or `null` if the tab is not persistent or the restart failed.
   */
  restartPersistentSessionForTab: (tabId: string) => Promise<string | null>;
  /**
   * Adopt a surviving agent session into the desktop's persistent registry and
   * attach a new terminal tab to it with full scrollback replay.
   *
   * Used by the sidebar's Active Sessions double-click handler: when the user
   * reopens a session that the desktop is not yet tracking (e.g. after a tab
   * close, or after a desktop restart that discovered the session via
   * `listAgentSessions`), the agent's session ID is linked to the desktop's
   * `${agentId}:${def.id}` connection ID and a tab is attached.
   */
  adoptAndAttachAgentPersistentSession: (
    agentId: string,
    def: AgentDefinitionInfo,
    agentSessionId: string,
    panelId?: string
  ) => Promise<void>;
  openSettingsTab: () => void;
  openLogViewerTab: () => void;
  openNetworkDiagnosticTab: (
    tool: NetworkTool,
    prefillHost?: string,
    connectionId?: string
  ) => void;
  httpMonitors: HttpMonitorState[];
  setHttpMonitors: (monitors: HttpMonitorState[]) => void;
  openEditorTab: (filePath: string, isRemote: boolean, sftpSessionId?: string) => void;
  /**
   * Open a new "scratch" editor tab seeded with in-memory content that is not
   * backed by a file on disk (e.g. captured terminal output). The tab is
   * treated as unsaved until the user saves it via Save As. Each call creates a
   * new tab — scratch buffers are never deduplicated.
   */
  openScratchEditorTab: (title: string, fileName: string, content: string) => void;
  openConnectionEditorTab: (connectionId: string, folderId?: string | null) => void;
  openAgentDefinitionEditorTab: (
    agentId: string,
    definitionId: string,
    folderId?: string | null
  ) => void;
  editorDirtyTabs: Record<string, boolean>;
  setEditorDirty: (tabId: string, dirty: boolean) => void;
  pendingCloseRequest: { tabId: string; panelId: string } | null;
  setPendingCloseRequest: (req: { tabId: string; panelId: string } | null) => void;
  /**
   * Confirmation request shown when the user closes a tab (or tab group) via
   * keyboard shortcut while `settings.confirmCloseTabOnShortcut` is enabled.
   * Null when no dialog is open.
   */
  pendingShortcutCloseConfirm:
    | { kind: "tab"; tabId: string; panelId: string; label: string }
    | { kind: "tab-group"; tabGroupId: string; label: string }
    | null;
  setPendingShortcutCloseConfirm: (
    req:
      | { kind: "tab"; tabId: string; panelId: string; label: string }
      | { kind: "tab-group"; tabGroupId: string; label: string }
      | null
  ) => void;
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
  /** Last settings object that was successfully persisted to disk (or loaded from disk). */
  savedSettings: AppSettings;

  // Layout
  layoutConfig: LayoutConfig;
  layoutDialogOpen: boolean;
  setLayoutDialogOpen: (open: boolean) => void;
  updateLayoutConfig: (partial: Partial<LayoutConfig>) => void;
  applyLayoutPreset: (preset: "default" | "focus" | "zen") => void;
  toggleActivityBarView: (view: SidebarView) => void;

  // Shortcuts overlay
  shortcutsOverlayOpen: boolean;
  setShortcutsOverlayOpen: (open: boolean) => void;

  // Standalone overlay views (updates, about) — opened from the settings menu
  overlayView: "updates" | "about" | null;
  openOverlayView: (view: "updates" | "about") => void;
  closeOverlayView: () => void;

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

  // Open-saved-file-in-tab confirmation
  openSavedFileDialog: { open: boolean; filePath: string };
  showOpenSavedFileDialog: (filePath: string) => void;
  closeOpenSavedFileDialog: () => void;

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
  /** Reload connections from the backend using the versioned reload guard. */
  reloadConnectionsFromBackend: () => void;
  toggleFolder: (folderId: string) => void;
  addConnection: (connection: SavedConnection) => void;
  updateConnection: (connection: SavedConnection) => void;
  deleteConnection: (connectionId: string) => void;
  bulkDeleteConnections: (connectionIds: string[]) => void;
  addFolder: (folder: ConnectionFolder) => void;
  deleteFolder: (folderId: string) => void;
  duplicateConnection: (connectionId: string) => void;
  moveConnectionToFolder: (connectionId: string, folderId: string | null) => void;
  bulkMoveConnectionsToFolder: (connectionIds: string[], folderId: string | null) => void;
  moveConnectionToFile: (connectionId: string, targetSource: string | null) => Promise<void>;

  // File browser / SFTP
  fileEntries: FileEntry[];
  currentPath: string;
  sftpSessionId: string | null;
  /**
   * Explicit SFTP session lifecycle status (audit gap A1). Replaces the
   * overloaded `sftpLoading` boolean so the UI can tell "connecting" apart from
   * "listing"/"refreshing" and "idle".
   */
  sftpStatus: SftpStatus;
  sftpError: string | null;
  sftpConnectedHost: string | null;
  /**
   * The last config passed to `connectSftp`, retained so a failed connect can be
   * retried (audit gap S1). Cleared on `disconnectSftp`.
   */
  sftpLastConfig: Record<string, unknown> | null;
  setCurrentPath: (path: string) => void;
  setFileEntries: (entries: FileEntry[]) => void;
  connectSftp: (config: Record<string, unknown>) => Promise<void>;
  disconnectSftp: () => Promise<void>;
  navigateSftp: (path: string) => Promise<void>;
  refreshSftp: () => Promise<void>;
  /** Re-invoke `connectSftp` with the persisted last config (audit gap S1). */
  retrySftp: () => Promise<void>;
  /** Clear the SFTP error so the failed-connect placeholder resets (audit gap S1). */
  dismissSftpError: () => void;

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

  // Per-tab terminal spawn errors (runtime-only, cleared on retry or tab close)
  terminalSpawnErrors: Record<string, string>;
  terminalRetryCounters: Record<string, number>;
  /** True while a createTerminal call is in-flight — drives the "Connecting…" overlay. */
  terminalConnecting: Record<string, boolean>;
  setTerminalSpawnError: (tabId: string, error: string | null) => void;
  retryTerminalSpawn: (tabId: string) => void;
  setTerminalConnecting: (tabId: string, connecting: boolean) => void;
  /** Auto-retry attempt count for agent sessions (> 0 = actively auto-retrying). */
  terminalAutoRetryCount: Record<string, number>;
  /** Tab is parked waiting for its parent agent to connect; value = agentId. */
  terminalWaitingForAgent: Record<string, string>;
  setTerminalAutoRetrying: (tabId: string, count: number) => void;
  setTerminalWaitingForAgent: (tabId: string, agentId: string | null) => void;

  // Per-tab terminal session disconnects (runtime-only, cleared on reconnect, dismiss, or tab close)
  terminalExitedTabs: Record<string, boolean>;
  /** How each exited tab's session ended — drives the disconnect overlay wording (#1121). */
  terminalExitInfo: Record<string, TerminalExitInfo>;
  /**
   * Session IDs the user explicitly killed (e.g. from the Open Connections panel).
   * Consumed by the exit handler so a user kill is classified as `killed` rather
   * than an unexpected disconnect (#1121).
   */
  intentionallyKilledSessions: Record<string, boolean>;
  /** Error message from a failed reconnect attempt (agent auto-reconnect exhausted). */
  terminalDisconnectErrors: Record<string, string>;
  /** True when the disconnect overlay was dismissed — session is dead but user is browsing scrollback. */
  terminalViewMode: Record<string, boolean>;
  /** True while the agent is actively trying to reconnect (shows spinner overlay). */
  terminalReconnectingTabs: Record<string, boolean>;
  /** True while cached scrollback is being fetched and written after a persistent session reattach. */
  terminalReattaching: Record<string, boolean>;
  /** True when the "reconnect?" prompt should appear (triggered by Enter in view mode). */
  terminalReconnectPrompt: Record<string, boolean>;
  /** Error message that triggered the auto-reconnect, shown during the spinner overlay. */
  terminalReconnectTriggerErrors: Record<string, string>;
  /**
   * Mark a tab's session as exited. Pass `info` to record the exit code and
   * cause so the overlay can branch its wording; a `killed` reason additionally
   * drops the tab straight into view mode so no disconnect overlay appears (#1121).
   */
  setTerminalExited: (tabId: string, info?: TerminalExitInfo) => void;
  /** Tag a session as intentionally killed by the user (e.g. Open Connections) (#1121). */
  markSessionKilled: (sessionId: string) => void;
  /** Return whether a session was intentionally killed, clearing the flag (#1121). */
  consumeSessionKilled: (sessionId: string) => boolean;
  setTerminalDisconnectWithError: (tabId: string, error: string) => void;
  setTerminalReconnecting: (tabId: string, reconnecting: boolean) => void;
  setTerminalReattaching: (tabId: string, reattaching: boolean) => void;
  setTerminalReconnectTriggerError: (tabId: string, error: string | null) => void;
  /** Dismiss the disconnect overlay into "view mode": scrollback is preserved, a thin banner shows. */
  dismissTerminalDisconnect: (tabId: string) => void;
  reconnectTerminal: (tabId: string) => void;
  showTerminalReconnectPrompt: (tabId: string) => void;
  dismissTerminalReconnectPrompt: (tabId: string) => void;

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
  clearAgentSessions: (agentId: string) => void;
  updateAgentSettings: (agentId: string, settings: AgentSettings) => Promise<void>;
  refreshAgentSessions: (agentId: string) => Promise<void>;
  saveAgentDef: (agentId: string, definition: Record<string, unknown>) => Promise<void>;
  duplicateAgentDef: (agentId: string, definitionId: string) => Promise<void>;
  updateAgentDef: (agentId: string, params: Record<string, unknown>) => Promise<void>;
  moveAgentDefToFolder: (agentId: string, defId: string, folderId: string | null) => Promise<void>;
  bulkMoveAgentDefsToFolder: (
    agentId: string,
    defIds: string[],
    folderId: string | null
  ) => Promise<void>;
  deleteAgentDef: (agentId: string, definitionId: string) => Promise<void>;
  createAgentFolder: (agentId: string, name: string, parentId?: string | null) => Promise<void>;
  updateAgentFolder: (agentId: string, params: Record<string, unknown>) => Promise<void>;
  deleteAgentFolder: (agentId: string, folderId: string) => Promise<void>;
  toggleAgentFolder: (agentId: string, folderId: string) => void;
  /** Convert all agent-error tabs for the given agent into live terminal tabs after reconnect. */
  resolveAgentErrorTabs: (agentId: string) => void;

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
  /**
   * Number of stats samples received on the current monitoring connection.
   * The remote collectors report CPU 0% on the first sample (no prior delta),
   * so the UI treats sample #1 as "priming" for the CPU field. Reset to 0 on
   * connect/disconnect and incremented on every real stats update. See audit
   * gap G10.
   */
  monitoringSampleCount: number;
  /**
   * True when auto-connect was aborted because the user cancelled the password
   * prompt. The status bar renders a subtle "Monitoring not connected"
   * affordance (with a reachable Retry) instead of failing silently. Reset on
   * connect start, disconnect, and retry. See audit gap G8.
   */
  monitoringCancelled: boolean;
  /** Last-known stats per host key, persisted across tab switches for instant display on reconnect. */
  monitoringStatsCache: Record<string, SystemStats>;
  connectMonitoring: (config: Record<string, unknown>) => Promise<void>;
  disconnectMonitoring: () => Promise<void>;
  refreshMonitoring: () => Promise<void>;
  /** Clear a lingering monitoringError so a stale tooltip cannot persist across hosts (audit gap G9). */
  clearMonitoringError: () => void;
  /** Set/reset the "connect was cancelled" affordance flag (audit gap G8). */
  setMonitoringCancelled: (cancelled: boolean) => void;
  /** Per-session capabilities fetched after session creation (keyed by sessionId). */
  sessionCapabilities: Record<string, { monitoring: boolean; fileBrowser: boolean }>;
  setSessionCapabilities: (
    sessionId: string,
    caps: { monitoring: boolean; fileBrowser: boolean }
  ) => void;

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

  // Embedded Servers
  embeddedServers: EmbeddedServerConfig[];
  embeddedServerStates: Record<string, EmbeddedServerState>;
  loadEmbeddedServers: () => Promise<void>;
  /** Refresh only the live runtime states (stats/uptime) without reloading the config list. */
  refreshEmbeddedServerStates: () => Promise<void>;
  saveEmbeddedServer: (config: EmbeddedServerConfig) => Promise<void>;
  deleteEmbeddedServer: (serverId: string) => Promise<void>;
  startEmbeddedServer: (serverId: string) => Promise<void>;
  stopEmbeddedServer: (serverId: string) => Promise<void>;
  updateEmbeddedServerState: (state: EmbeddedServerState) => void;
  quickShareServer: (path: string, protocol: ServerType) => Promise<string>;

  // Workspaces
  workspaces: WorkspaceSummary[];
  activeWorkspaceName: string | null;
  loadWorkspaces: () => Promise<void>;
  saveWorkspaceToBackend: (definition: WorkspaceDefinition) => Promise<void>;
  deleteWorkspaceFromBackend: (workspaceId: string) => Promise<void>;
  duplicateWorkspaceInBackend: (workspaceId: string) => Promise<void>;
  openWorkspaceEditorTab: (workspaceId: string | null) => void;
  /**
   * The id of the workspace whose launch is currently in flight, or `null` when
   * none is launching. Used to guard against re-entrant `launchWorkspace` calls
   * (double-click / repeated Play) and to disable the Launch controls in the UI.
   */
  launchingWorkspaceId: string | null;
  launchWorkspace: (workspaceId: string) => Promise<void>;
  /** scope "all" captures all tab groups; "active" captures only the active group. */
  saveCurrentAsWorkspace: (
    name: string,
    scope: "all" | "active",
    description?: string
  ) => Promise<void>;

  // Last session (auto-saved layout restored on startup)
  /**
   * True while a restore/launch is settling (GAP G5, #1146). While set,
   * {@link scheduleLastSessionSave} is a no-op so a mid-restore snapshot — where
   * some tabs are still connecting or in agent-error — cannot be captured and
   * persisted over the previously-good last session. Cleared once the restored
   * cohort settles (a short settle window after the layout is placed).
   */
  restoreInProgress: boolean;
  /** Capture the current tab groups/layout and persist them as the last session. */
  saveLastSession: () => Promise<void>;
  /** Debounced wrapper around {@link saveLastSession} for high-frequency layout changes. */
  scheduleLastSessionSave: () => void;
  /** Restore the persisted last session into the live layout. Returns true if a session was restored. */
  restoreLastSession: () => Promise<boolean>;
  /** Clear the persisted last session (e.g. when restore-on-startup is disabled). */
  clearLastSession: () => Promise<void>;

  // Credential store
  credentialStoreStatus: CredentialStoreStatusInfo | null;
  setCredentialStoreStatus: (status: CredentialStoreStatusInfo) => void;
  loadCredentialStoreStatus: () => Promise<void>;
  unlockDialogOpen: boolean;
  setUnlockDialogOpen: (open: boolean) => void;
  /**
   * Pending resolvers for in-flight requestUnlock() calls. Internal — settled by
   * resolveUnlock(). Held as a list so that concurrent connect flows each awaiting
   * requestUnlock() all settle on a single dialog exit; a single resolver would
   * be overwritten by the second caller, wedging the first connect forever (G1).
   */
  unlockResolvers: ((unlocked: boolean) => void)[];
  /**
   * Opens the unlock dialog and returns a Promise that resolves to `true` when the
   * store is successfully unlocked, or `false` when the user cancels/skips.
   * Callers can `await` this before proceeding with a credential-dependent action.
   */
  requestUnlock: () => Promise<boolean>;
  /** Settles (and clears) every pending requestUnlock() promise. Idempotent. */
  resolveUnlock: (unlocked: boolean) => void;
  masterPasswordSetupOpen: boolean;
  masterPasswordSetupMode: "setup" | "change";
  openMasterPasswordSetup: (mode: "setup" | "change") => void;
  closeMasterPasswordSetup: () => void;

  // Portable mode
  isPortableMode: boolean;
  portableDataDir: string | null;
  loadAppMode: () => Promise<void>;

  // Update checker
  updateCheckState: "idle" | "checking" | "up-to-date" | "available" | "error";
  updateInfo: import("@/types/connection").UpdateInfo | null;
  updateNotificationDismissed: boolean;
  checkForUpdates: (force: boolean) => Promise<void>;
  dismissUpdateNotification: () => void;
  skipUpdate: () => Promise<void>;
  clearSkippedUpdateVersion: () => Promise<void>;
}

let tabCounter = 0;
let layoutPersistTimer: ReturnType<typeof setTimeout> | null = null;
/** Debounce timer for auto-saving the last session on layout changes. */
let lastSessionPersistTimer: ReturnType<typeof setTimeout> | null = null;
const LAST_SESSION_SAVE_DEBOUNCE_MS = 500;
/**
 * Settle timer for the restore-in-progress guard (GAP G5, #1146). After a
 * restore/launch places its layout, per-tab connects keep mutating the tree for
 * a moment; we hold {@link AppState.restoreInProgress} for this window so those
 * transient (still-connecting / agent-error) states are not auto-saved over the
 * good session. Comfortably larger than the auto-save debounce.
 */
let restoreSettleTimer: ReturnType<typeof setTimeout> | null = null;
const RESTORE_SETTLE_MS = 2000;

/**
 * Raise the restore-in-progress guard (GAP G5, #1146) and (re)arm the settle
 * timer that lowers it. Call immediately after a restore/launch has placed its
 * layout so the auto-save subscription and any in-flight per-tab connects are
 * skipped until the cohort settles. Safe to call repeatedly — the timer is
 * reset each time so overlapping restores extend the window.
 */
function beginRestoreGuard(setState: (partial: Partial<AppState>) => void): void {
  setState({ restoreInProgress: true });
  if (restoreSettleTimer) clearTimeout(restoreSettleTimer);
  restoreSettleTimer = setTimeout(() => {
    restoreSettleTimer = null;
    setState({ restoreInProgress: false });
    frontendLog("workspace", "restore settle window elapsed; auto-save re-enabled");
  }, RESTORE_SETTLE_MS);
}

/**
 * Tear down every live backend session currently held by the store (GAP G1,
 * #1146). `launchWorkspace` / `restoreLastSession` replace the whole layout with
 * a single `set(...)`; without this, the prior tabs' PTY/SSH/agent sessions are
 * dropped from the store and orphaned into the Open Connections panel with no
 * tab to reach them. Call this BEFORE placing the new groups.
 *
 * The active group's live tree lives in `rootPanel`; every other group's tree
 * lives in `group.rootPanel` (mirrors {@link captureAllTabGroups}). Persistent
 * sessions are detached rather than killed so their background process survives
 * and can be re-adopted — the same distinction the Terminal unmount cleanup
 * makes. Failures are swallowed: a best-effort close must never block the
 * launch/restore that follows.
 */
function teardownAllSessions(state: {
  tabGroups: TabGroup[];
  activeTabGroupId: string;
  rootPanel: PanelNode;
}): void {
  const trees = state.tabGroups.map((g) =>
    g.id === state.activeTabGroupId ? state.rootPanel : g.rootPanel
  );
  const tabs = trees.flatMap((tree) => getAllLeaves(tree).flatMap((leaf) => leaf.tabs));
  let closed = 0;
  for (const tab of tabs) {
    if (!tab.sessionId) continue;
    closed++;
    if (tab.persistentConnectionId) {
      // Persistent session — detach so the background process keeps running.
      apiDetachPersistentTab(tab.sessionId, tab.id).catch(() => {});
    } else {
      apiCloseTerminal(tab.sessionId).catch(() => {});
    }
  }
  if (closed > 0) {
    frontendLog("workspace", `tore down ${closed} live session(s) before restore/launch`);
  }
}

/** Unlisten function for the active session-based monitoring event subscription. */
let _monitoringUnlisten: (() => void) | null = null;

function createTab(
  title: string,
  connectionType: string,
  config: ConnectionConfig,
  panelId: string,
  contentType: TabContentType = "terminal",
  sessionId: string | null = null,
  persistentConnectionId?: string
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
    ...(persistentConnectionId ? { persistentConnectionId } : {}),
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

// Monotonically increasing counters for connection-state reloads.
// `_connReloadSeq` increments each time a reload is initiated; `_connAppliedSeq`
// tracks the highest sequence whose result has been applied to the store.
// This prevents a stale concurrent reload (lower seq) from overwriting a fresher
// correction (higher seq) that happened to resolve first.
let _connReloadSeq = 0;
let _connAppliedSeq = 0;

/** @internal Reset reload sequencer — for tests only. */
export function _resetConnectionReloadSeq(): void {
  _connReloadSeq = 0;
  _connAppliedSeq = 0;
}

// Monotonic sequencer for SFTP directory-list requests (GAP R1, #1143).
// navigateSftp/refreshSftp await sftpListDir with no ordering guarantee, so when
// two navigations overlap the response that resolves LAST wins currentPath/
// fileEntries — leaving the path and displayed list desynced. Each list request
// captures the next seq; a response only commits state if it is still the latest
// request, so a stale (superseded) response is ignored.
let _sftpListSeq = 0;

/** @internal Reset the SFTP list sequencer — for tests only. */
export function _resetSftpListSeq(): void {
  _sftpListSeq = 0;
}

// Detects a mid-browse failure that means the underlying SFTP session is dead
// (audit gap S2): the Rust side raises "SFTP session not found" when the slot is
// gone, and russh reports channel/transport drops with these phrasings. On such
// an error the front end must stop pretending it is connected (clear
// sftpSessionId) so the auto-connect effect can re-establish and a Reconnect
// control is offered — as opposed to a recoverable per-directory error (e.g.
// "permission denied") which must leave the session intact.
function isSftpSessionDeadError(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes("session not found") ||
    m.includes("channel") ||
    m.includes("disconnected") ||
    m.includes("connection reset") ||
    m.includes("broken pipe") ||
    m.includes("not connected") ||
    m.includes("transport")
  );
}

// In-flight guards for tunnel start/stop (GAP 4, #1141). A rapid double-click on
// Start/Stop for a tunnel that is already `connecting` must not fire a second
// backend call — that produces spurious "already active/connecting" error toasts
// and can flip the visible state. We track the id of each tunnel whose start/stop
// call has not yet resolved and no-op any re-entrant call for the same id.
const _tunnelStartInFlight = new Set<string>();
const _tunnelStopInFlight = new Set<string>();

export const useAppStore = create<AppState>((set, get) => {
  // Reload connections from the backend, applying the result only if this
  // reload was initiated more recently than the last applied one.
  /**
   * Reconcile an in-memory connection's optimistic id with the **persisted** id
   * the backend returns from a save. The editor assigns `conn-<ts>` and the
   * backend recomputes a name-derived id, so a connect firing before the reload
   * would otherwise store a credential under the stale id and orphan it (#863,
   * #875). A no-op when the id is unchanged or the backend returned nothing.
   */
  function reconcileConnectionId(prevId: string, persistedId: string | undefined): void {
    if (!persistedId || persistedId === prevId) return;
    frontendLog("connection_sync", `reconciling ${prevId} → ${persistedId}`);
    set((state) => ({
      connections: state.connections.map((c) => (c.id === prevId ? { ...c, id: persistedId } : c)),
    }));
  }

  function applyConnectionReload(): Promise<void> {
    const mySeq = ++_connReloadSeq;
    frontendLog("connection_sync", `reload initiated (seq=${mySeq})`);
    return loadConnections().then(({ connections, folders }) => {
      if (mySeq >= _connAppliedSeq) {
        _connAppliedSeq = mySeq;
        frontendLog(
          "connection_sync",
          `reload applied (seq=${mySeq}, conns=${connections.length}, folders=${folders.length})`
        );
        set({ connections, folders });
      } else {
        frontendLog(
          "connection_sync",
          `reload dropped (seq=${mySeq} superseded by applied=${_connAppliedSeq})`
        );
      }
    });
  }

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

    // Network monitors (populated by NetworkToolsSidebar on open)
    httpMonitors: [],
    setHttpMonitors: (monitors) => set({ httpMonitors: monitors }),

    // Sidebar
    sidebarView: "connections",
    sidebarCollapsed: false,
    sidebarWidth: 260,
    setSidebarView: (view) => {
      set((state) => ({
        sidebarView: view,
        sidebarCollapsed: state.sidebarView === view && !state.sidebarCollapsed ? true : false,
      }));
      const { sidebarCollapsed, updateLayoutConfig } = get();
      updateLayoutConfig({ sidebarView: view, sidebarCollapsed });
    },
    toggleSidebar: () => {
      set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed }));
      const { sidebarView, sidebarCollapsed, updateLayoutConfig } = get();
      updateLayoutConfig({ sidebarView, sidebarCollapsed });
    },
    setSidebarWidth: (width) => set({ sidebarWidth: width }),

    // Password prompt
    passwordPromptOpen: false,
    passwordPromptHost: "",
    passwordPromptUsername: "",
    passwordPromptResolve: null,
    passwordPromptShouldSave: false,

    requestPassword: (host, username) => {
      return new Promise<string | null>((resolve) => {
        set({
          passwordPromptOpen: true,
          passwordPromptHost: host,
          passwordPromptUsername: username,
          passwordPromptResolve: resolve,
          passwordPromptShouldSave: false,
        });
      });
    },

    submitPassword: (password, shouldSave = false) => {
      const { passwordPromptResolve } = get();
      if (passwordPromptResolve) passwordPromptResolve(password);
      set({
        passwordPromptOpen: false,
        passwordPromptHost: "",
        passwordPromptUsername: "",
        passwordPromptResolve: null,
        passwordPromptShouldSave: shouldSave,
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
        passwordPromptShouldSave: false,
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
        // Follow zoom to the new group's active tab so the overlay never goes stale
        let newZoomedTabId = state.zoomedTabId;
        if (state.zoomedTabId !== null) {
          const newActivePanel = targetGroup.activePanelId
            ? findLeaf(targetGroup.rootPanel, targetGroup.activePanelId)
            : null;
          newZoomedTabId = newActivePanel?.activeTabId ?? null;
        }
        return {
          tabGroups: savedGroups,
          activeTabGroupId: groupId,
          rootPanel: targetGroup.rootPanel,
          activePanelId: targetGroup.activePanelId,
          zoomedTabId: newZoomedTabId,
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

    // Persistent connection sessions
    persistentSessions: {},

    startPersistentSession: async (connectionId) => {
      const conn = get().connections.find((c) => c.id === connectionId);
      if (!conn) return;
      set((state) => ({
        persistentSessions: {
          ...state.persistentSessions,
          [connectionId]: {
            connectionId,
            sessionId: null,
            state: "starting",
            attachedTabIds: [],
          },
        },
      }));
      try {
        await apiStartPersistentSession(connectionId, conn.config.type, conn.config.config);
      } catch (err) {
        set((state) => ({
          persistentSessions: {
            ...state.persistentSessions,
            [connectionId]: {
              ...state.persistentSessions[connectionId],
              state: "error",
              errorMessage: err instanceof Error ? err.message : String(err),
            },
          },
        }));
      }
    },

    attachPersistentSession: async (connectionId, panelId) => {
      const entry = get().persistentSessions[connectionId];
      const conn = get().connections.find((c) => c.id === connectionId);
      if (!conn || !entry?.sessionId) return;
      const tabId = get().addTab(
        conn.name,
        conn.config.type,
        conn.config,
        panelId,
        "terminal",
        conn.terminalOptions,
        entry.sessionId,
        connectionId
      );
      try {
        await apiAttachPersistentTab(connectionId, tabId);
        set((state) => {
          const existing = state.persistentSessions[connectionId];
          if (!existing) return state;
          return {
            persistentSessions: {
              ...state.persistentSessions,
              [connectionId]: {
                ...existing,
                attachedTabIds: [...existing.attachedTabIds, tabId],
              },
            },
          };
        });
      } catch (err) {
        frontendLog(
          "app_store",
          `attach_persistent_tab failed for ${connectionId}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    },

    stopPersistentSession: async (connectionId) => {
      set((state) => {
        const existing = state.persistentSessions[connectionId];
        if (!existing) return state;
        return {
          persistentSessions: {
            ...state.persistentSessions,
            [connectionId]: { ...existing, state: "stopping" },
          },
        };
      });
      try {
        await apiStopPersistentSession(connectionId);
      } catch (err) {
        frontendLog(
          "app_store",
          `stop_persistent_session failed for ${connectionId}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    },

    setPersistentSessionEntry: (connectionId, patch) =>
      set((state) => {
        const existing = state.persistentSessions[connectionId];
        if (!existing) return state;
        return {
          persistentSessions: {
            ...state.persistentSessions,
            [connectionId]: { ...existing, ...patch },
          },
        };
      }),

    setPersistentSessionError: (connectionId, errorMessage) =>
      set((state) => {
        const existing = state.persistentSessions[connectionId];
        if (!existing) return state;
        return {
          persistentSessions: {
            ...state.persistentSessions,
            [connectionId]: { ...existing, state: "error", errorMessage },
          },
        };
      }),

    startAgentPersistentSession: async (agentId, def) => {
      const connectionId = `${agentId}:${def.id}`;
      set((state) => ({
        persistentSessions: {
          ...state.persistentSessions,
          [connectionId]: {
            connectionId,
            sessionId: null,
            state: "starting",
            attachedTabIds: [],
          },
        },
      }));
      try {
        const sessionId = await apiStartPersistentSession(
          connectionId,
          def.sessionType,
          { ...def.config, title: def.name, definitionId: def.id },
          agentId
        );
        // Record the session ID immediately so callers can attach without
        // racing the persistent-session-state-changed event. The state
        // transition to "running" remains driven by that event.
        set((state) => {
          const existing = state.persistentSessions[connectionId];
          if (!existing) return state;
          return {
            persistentSessions: {
              ...state.persistentSessions,
              [connectionId]: { ...existing, sessionId },
            },
          };
        });
        return sessionId;
      } catch (err) {
        set((state) => ({
          persistentSessions: {
            ...state.persistentSessions,
            [connectionId]: {
              ...state.persistentSessions[connectionId],
              state: "error",
              errorMessage: err instanceof Error ? err.message : String(err),
            },
          },
        }));
        return null;
      }
    },

    attachAgentPersistentSession: async (agentId, def, panelId) => {
      const connectionId = `${agentId}:${def.id}`;
      const entry = get().persistentSessions[connectionId];
      if (!entry?.sessionId) return;
      const tabId = get().addTab(
        def.name,
        "remote-session",
        {
          type: "remote-session",
          config: {
            agentId,
            sessionType: def.sessionType,
            ...def.config,
            persistent: true,
            title: def.name,
          },
        },
        panelId,
        "terminal",
        def.terminalOptions,
        entry.sessionId,
        connectionId
      );
      // Resolve the actual panel the tab landed in so we can close it on failure.
      const actualPanelId = findLeafByTab(get().rootPanel, tabId)?.id;
      try {
        await apiAttachPersistentTab(connectionId, tabId);
        set((state) => {
          const existing = state.persistentSessions[connectionId];
          if (!existing) return state;
          return {
            persistentSessions: {
              ...state.persistentSessions,
              [connectionId]: {
                ...existing,
                attachedTabIds: [...existing.attachedTabIds, tabId],
              },
            },
          };
        });
      } catch (err) {
        frontendLog(
          "app_store",
          `attach_persistent_tab failed for ${connectionId}: ${err instanceof Error ? err.message : String(err)}`
        );
        // Session is gone — remove the tab so the user does not see a blank terminal.
        if (actualPanelId) {
          get().closeTab(tabId, actualPanelId);
        }
      }
    },

    adoptAndAttachAgentPersistentSession: async (agentId, def, agentSessionId, panelId) => {
      const connectionId = `${agentId}:${def.id}`;
      const existing = get().persistentSessions[connectionId];

      // If we already track this connection and it points at the same agent
      // session, fall through to the normal attach path — no adoption needed.
      if (existing?.sessionId === agentSessionId) {
        await get().attachAgentPersistentSession(agentId, def, panelId);
        return;
      }

      // If we track a *different* session ID for this connection (e.g. a stale
      // entry from before the agent restart), warn and skip — the user can stop
      // the old persistent record explicitly if they want to overwrite it.
      if (existing?.sessionId && existing.sessionId !== agentSessionId) {
        frontendLog(
          "app_store",
          `adopt skipped for ${connectionId}: already mapped to ${existing.sessionId}`
        );
        return;
      }

      try {
        await apiAdoptPersistentSession(connectionId, agentId, agentSessionId);
      } catch (err) {
        frontendLog(
          "app_store",
          `adopt_persistent_session failed for ${connectionId}: ${err instanceof Error ? err.message : String(err)}`
        );
        return;
      }

      // Seed the desktop's persistentSessions map so attachAgentPersistentSession
      // finds the entry. The backend will emit a persistent-state event that may
      // re-set this asynchronously; mirroring it here avoids a race in the
      // attach call that follows.
      set((state) => ({
        persistentSessions: {
          ...state.persistentSessions,
          [connectionId]: {
            connectionId,
            sessionId: agentSessionId,
            state: "running",
            attachedTabIds: [],
          },
        },
      }));

      await get().attachAgentPersistentSession(agentId, def, panelId);
    },

    startAndAttachAgentPersistentSession: async (agentId, def, panelId) => {
      const connectionId = `${agentId}:${def.id}`;
      const existing = get().persistentSessions[connectionId];
      if (existing?.sessionId && (existing.state === "running" || existing.state === "attached")) {
        await get().attachAgentPersistentSession(agentId, def, panelId);
        return;
      }
      const sessionId = await get().startAgentPersistentSession(agentId, def);
      if (!sessionId) return;
      await get().attachAgentPersistentSession(agentId, def, panelId);
    },

    restartPersistentSessionForTab: async (tabId) => {
      const state = get();
      const tab = [
        ...getAllLeaves(state.rootPanel).flatMap((l) => l.tabs),
        ...state.tabGroups.flatMap((g) => getAllLeaves(g.rootPanel).flatMap((l) => l.tabs)),
      ].find((t) => t.id === tabId);
      const connectionId = tab?.persistentConnectionId;
      if (!tab || !connectionId) return null;

      const cfg = tab.config.config as {
        agentId?: string;
        sessionType?: string;
        title?: string;
        [key: string]: unknown;
      };
      const agentId = cfg.agentId;
      if (!agentId || !connectionId.startsWith(`${agentId}:`)) return null;
      const defId = connectionId.slice(agentId.length + 1);

      // Register this tab as attached to the (re)started persistent session and
      // track it in the store entry so attach counts and detach-on-close stay
      // correct. Failures are logged but non-fatal — the session is still usable.
      const attachTab = async () => {
        try {
          await apiAttachPersistentTab(connectionId, tabId);
          set((s) => {
            const entry = s.persistentSessions[connectionId];
            if (!entry || entry.attachedTabIds.includes(tabId)) return s;
            return {
              persistentSessions: {
                ...s.persistentSessions,
                [connectionId]: {
                  ...entry,
                  attachedTabIds: [...entry.attachedTabIds, tabId],
                },
              },
            };
          });
        } catch (err) {
          frontendLog(
            "app_store",
            `restart_persistent attach failed for ${connectionId}: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      };

      // Reuse a session that is already live (e.g. the agent transport simply
      // dropped and recovered) rather than spawning a duplicate.
      const existing = state.persistentSessions[connectionId];
      if (existing?.sessionId && (existing.state === "running" || existing.state === "attached")) {
        get().setTabSessionId(tabId, existing.sessionId);
        await attachTab();
        return existing.sessionId;
      }

      // The session is gone — clear the dead id so the terminal never reattaches
      // to a corpse, then start a fresh persistent session. Reconstruct the
      // connection definition from the tab config (agent definitions may not be
      // loaded, e.g. after an agent disconnect); agentId/persistent are dropped
      // from the forwarded settings.
      get().setTabSessionId(tabId, null);
      const { agentId: _agentId, sessionType, title, persistent: _persistent, ...connConfig } = cfg;
      const def: AgentDefinitionInfo = {
        id: defId,
        name: title ?? tab.title,
        sessionType: sessionType ?? "shell",
        config: connConfig,
        persistent: true,
        folderId: null,
      };

      const sessionId = await get().startAgentPersistentSession(agentId, def);
      if (!sessionId) return null;
      await attachTab();
      get().setTabSessionId(tabId, sessionId);
      return sessionId;
    },

    // Panels & Tabs
    rootPanel: initialPanel,
    activePanelId: initialPanel.id,

    getAllPanels: () => getAllLeaves(get().rootPanel),

    setTabSessionId: (tabId, sessionId) => {
      // For remote-session tabs gaining a session ID, fetch capabilities so
      // monitoring knows whether this session supports stats collection.
      if (sessionId) {
        const tab = getAllLeaves(get().rootPanel)
          .flatMap((l) => l.tabs)
          .find((t) => t.id === tabId);
        if (tab?.connectionType === "remote-session") {
          sessionGetCapabilities(sessionId)
            .then((caps) => get().setSessionCapabilities(sessionId, caps))
            .catch(() => {});
        }
      }
      set((state) => {
        const leaf = findLeafByTab(state.rootPanel, tabId);
        if (!leaf) return state;
        return {
          rootPanel: updateLeaf(state.rootPanel, leaf.id, (l) => ({
            ...l,
            tabs: l.tabs.map((t) => (t.id === tabId ? { ...t, sessionId } : t)),
          })),
        };
      });
    },

    addTab: (
      title,
      connectionType,
      config,
      panelId,
      contentType,
      terminalOptions,
      sessionId,
      persistentConnectionId
    ) => {
      let createdTabId = "";
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
          sessionId ?? null,
          persistentConnectionId
        );
        createdTabId = newTab.id;
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
      });
      return createdTabId;
    },

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

    openNetworkDiagnosticTab: (tool, prefillHost, connectionId) =>
      set((state) => {
        const allLeaves = getAllLeaves(state.rootPanel);
        const targetPanelId = state.activePanelId ?? allLeaves[0]?.id;
        if (!targetPanelId) return state;

        const meta: NetworkDiagnosticMeta = { tool, prefillHost, connectionId };
        const dummyConfig: ConnectionConfig = { type: "local", config: {} };
        const toolLabel: Record<NetworkTool, string> = {
          "port-scanner": "Port Scanner",
          ping: "Ping",
          "dns-lookup": "DNS Lookup",
          "http-monitor": "HTTP Monitor",
          traceroute: "Traceroute",
          wol: "Wake-on-LAN",
          "open-ports": "Open Ports",
        };
        const title = prefillHost ? `${toolLabel[tool]}: ${prefillHost}` : toolLabel[tool];
        const newTab = createTab(title, "local", dummyConfig, targetPanelId, "network-diagnostic");
        (
          newTab as TerminalTab & { networkDiagnosticMeta: NetworkDiagnosticMeta }
        ).networkDiagnosticMeta = meta;
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
              tabs: l.tabs.map((t) => {
                if (t.id !== existing.id) return { ...t, isActive: false };
                // Refresh the SFTP session ID so a reconnected session works.
                const updatedMeta =
                  isRemote && sftpSessionId && t.editorMeta
                    ? { ...t.editorMeta, sftpSessionId }
                    : t.editorMeta;
                return { ...t, isActive: true, editorMeta: updatedMeta };
              }),
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

    openScratchEditorTab: (title, fileName, content) =>
      set((state) => {
        const allLeaves = getAllLeaves(state.rootPanel);
        const targetPanelId = state.activePanelId ?? allLeaves[0]?.id;
        if (!targetPanelId) return state;

        const dummyConfig: ConnectionConfig = { type: "local", config: { shell: "zsh" } };
        const editorMeta: EditorTabMeta = {
          filePath: fileName,
          isRemote: false,
          scratch: true,
          scratchContent: content,
        };
        const newTab = createTab(title, "local", dummyConfig, targetPanelId, "editor");
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
        if (connectionId === "new-remote-agent") {
          title = "New Remote Agent";
        } else if (connectionId !== "new") {
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

    pendingCloseRequest: null,
    setPendingCloseRequest: (req) => set({ pendingCloseRequest: req }),

    pendingShortcutCloseConfirm: null,
    setPendingShortcutCloseConfirm: (req) => set({ pendingShortcutCloseConfirm: req }),

    closeTab: (tabId, panelId) =>
      set((state) => {
        // Clean up per-tab state for the closed tab
        const remainingCwds = omitKey(state.tabCwds, tabId);
        const remainingHs = omitKey(state.tabHorizontalScrolling, tabId);
        const remainingDirty = omitKey(state.editorDirtyTabs, tabId);
        const remainingColors = omitKey(state.tabColors, tabId);
        const remainingOpts = omitKey(state.tabTerminalOptions, tabId);
        const remainingSearch = omitKey(state.terminalSearchVisible, tabId);
        const remainingSpawnErrors = omitKey(state.terminalSpawnErrors, tabId);
        const remainingRetryCounters = omitKey(state.terminalRetryCounters, tabId);
        const remainingConnecting = omitKey(state.terminalConnecting, tabId);
        const remainingExited = omitKey(state.terminalExitedTabs, tabId);
        const remainingExitInfo = omitKey(state.terminalExitInfo, tabId);
        const remainingDiscErr = omitKey(state.terminalDisconnectErrors, tabId);
        const remainingView = omitKey(state.terminalViewMode, tabId);
        const remainingReconn = omitKey(state.terminalReconnectingTabs, tabId);
        const remainingReattach = omitKey(state.terminalReattaching, tabId);
        const remainingPrompt = omitKey(state.terminalReconnectPrompt, tabId);
        const remainingAutoRetry = omitKey(state.terminalAutoRetryCount, tabId);
        const remainingWaiting = omitKey(state.terminalWaitingForAgent, tabId);

        // Remove this tab from any persistent session's attachedTabIds
        const persistentSessions = { ...state.persistentSessions };
        for (const [connId, entry] of Object.entries(persistentSessions)) {
          if (entry.attachedTabIds.includes(tabId)) {
            persistentSessions[connId] = {
              ...entry,
              attachedTabIds: entry.attachedTabIds.filter((id) => id !== tabId),
            };
          }
        }

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
            persistentSessions,
            tabCwds: remainingCwds,
            tabHorizontalScrolling: remainingHs,
            editorDirtyTabs: remainingDirty,
            tabColors: remainingColors,
            tabTerminalOptions: remainingOpts,
            terminalSearchVisible: remainingSearch,
            terminalSpawnErrors: remainingSpawnErrors,
            terminalRetryCounters: remainingRetryCounters,
            terminalConnecting: remainingConnecting,
            terminalExitedTabs: remainingExited,
            terminalExitInfo: remainingExitInfo,
            terminalDisconnectErrors: remainingDiscErr,
            terminalViewMode: remainingView,
            terminalReconnectingTabs: remainingReconn,
            terminalReattaching: remainingReattach,
            terminalReconnectPrompt: remainingPrompt,
            terminalAutoRetryCount: remainingAutoRetry,
            terminalWaitingForAgent: remainingWaiting,
          };
        }

        return {
          rootPanel,
          zoomedTabId,
          persistentSessions,
          tabCwds: remainingCwds,
          tabHorizontalScrolling: remainingHs,
          editorDirtyTabs: remainingDirty,
          tabColors: remainingColors,
          tabTerminalOptions: remainingOpts,
          terminalSearchVisible: remainingSearch,
          terminalSpawnErrors: remainingSpawnErrors,
          terminalRetryCounters: remainingRetryCounters,
          terminalConnecting: remainingConnecting,
          terminalExitedTabs: remainingExited,
          terminalExitInfo: remainingExitInfo,
          terminalDisconnectErrors: remainingDiscErr,
          terminalViewMode: remainingView,
          terminalReconnectingTabs: remainingReconn,
          terminalReattaching: remainingReattach,
          terminalReconnectPrompt: remainingPrompt,
          terminalAutoRetryCount: remainingAutoRetry,
          terminalWaitingForAgent: remainingWaiting,
        };
      }),

    setActiveTab: (tabId, panelId) =>
      set((state) => {
        const newRootPanel = updateLeaf(state.rootPanel, panelId, (leaf) => ({
          ...leaf,
          tabs: leaf.tabs.map((t) => ({ ...t, isActive: t.id === tabId })),
          activeTabId: tabId,
        }));

        // If the zoom overlay is showing a tab from the same panel, follow the switch
        let newZoomedTabId = state.zoomedTabId;
        if (state.zoomedTabId !== null) {
          const panelLeaf = findLeaf(state.rootPanel, panelId);
          if (panelLeaf?.tabs.some((t) => t.id === state.zoomedTabId)) {
            newZoomedTabId = tabId;
          }
        }

        return {
          rootPanel: newRootPanel,
          activePanelId: panelId,
          zoomedTabId: newZoomedTabId,
        };
      }),

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

    setActivePanel: (panelId) =>
      set((state) => {
        let newZoomedTabId = state.zoomedTabId;
        if (state.zoomedTabId !== null) {
          const newPanel = findLeaf(state.rootPanel, panelId);
          newZoomedTabId = newPanel?.activeTabId ?? null;
        }
        return { activePanelId: panelId, zoomedTabId: newZoomedTabId };
      }),

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
      confirmCloseTabOnShortcut: true,
      askOpenSavedFileInTab: true,
    },
    savedSettings: {
      version: "1",
      externalConnectionFiles: [],
      powerMonitoringEnabled: true,
      fileBrowserEnabled: true,
      confirmCloseTabOnShortcut: true,
      askOpenSavedFileInTab: true,
    },

    // Layout
    layoutConfig: DEFAULT_LAYOUT,
    layoutDialogOpen: false,

    setLayoutDialogOpen: (open) => set({ layoutDialogOpen: open }),

    // Shortcuts overlay
    shortcutsOverlayOpen: false,
    setShortcutsOverlayOpen: (open) => set({ shortcutsOverlayOpen: open }),

    // Standalone overlay views
    overlayView: null,
    openOverlayView: (view) => set({ overlayView: view }),
    closeOverlayView: () => set({ overlayView: null }),

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
        set({ zoomedTabId: panel.activeTabId });
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

    // Open-saved-file-in-tab confirmation
    openSavedFileDialog: { open: false, filePath: "" },
    showOpenSavedFileDialog: (filePath) => set({ openSavedFileDialog: { open: true, filePath } }),
    closeOpenSavedFileDialog: () => set({ openSavedFileDialog: { open: false, filePath: "" } }),

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

    toggleActivityBarView: (view) => {
      const REQUIRED_VIEWS: SidebarView[] = ["connections"];
      if (REQUIRED_VIEWS.includes(view)) return;
      const { layoutConfig, sidebarView, sidebarCollapsed } = get();
      const hidden = layoutConfig.hiddenActivityBarViews ?? [];
      const isCurrentlyHidden = hidden.includes(view);
      const updatedHidden = isCurrentlyHidden
        ? hidden.filter((v) => v !== view)
        : [...hidden, view];
      const updated = { ...layoutConfig, hiddenActivityBarViews: updatedHidden };
      // If hiding the currently active view, collapse the sidebar
      const shouldCollapse = !isCurrentlyHidden && sidebarView === view && !sidebarCollapsed;
      set({ layoutConfig: updated, ...(shouldCollapse ? { sidebarCollapsed: true } : {}) });
      if (layoutPersistTimer) clearTimeout(layoutPersistTimer);
      layoutPersistTimer = setTimeout(() => {
        const current = get();
        persistSettings({ ...current.settings, layout: updated }).catch((err) =>
          console.error("Failed to persist layout config:", err)
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
        const persistedView =
          (layoutConfig.sidebarView as SidebarView | undefined) ?? "connections";
        const sidebarView: SidebarView = persistedView === "files" ? "connections" : persistedView;
        const sidebarCollapsed = layoutConfig.sidebarCollapsed ?? false;
        set({
          connections,
          folders,
          settings,
          savedSettings: settings,
          remoteAgents,
          layoutConfig,
          sidebarView,
          sidebarCollapsed,
        });
        applyTheme(settings.theme);
        if (settings.keybindingOverrides) {
          setKeybindingOverrides(settings.keybindingOverrides);
        }
        if (settings.installedLanguagePackages?.length) {
          void registerAdditionalLanguagePackages(settings.installedLanguagePackages);
        }
        if (settings.customLanguageGrammars?.length) {
          registerCustomGrammars(settings.customLanguageGrammars).catch((err: unknown) => {
            frontendLog(
              "app_store",
              `Failed to register custom grammars on startup: ${err instanceof Error ? err.message : String(err)}`
            );
          });
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
      // Load embedded servers
      get().loadEmbeddedServers();
      // Load workspaces
      get().loadWorkspaces();
      // Load app mode (portable vs. installed) for status bar and settings display
      await get().loadAppMode();
      // Load credential store status (dialog opens on-demand when credentials are needed)
      await get().loadCredentialStoreStatus();
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
      // Subscribe to persistent session state changes from the backend
      onPersistentSessionStateChanged((change) => {
        const { connectionId, sessionId, state: rawState, attachedTabCount, errorMessage } = change;
        const runState = rawState as PersistentRunState;
        if (runState === "stopped") {
          // Remove the entry entirely when the session stops
          set((s) => {
            const { [connectionId]: _dropped, ...remaining } = s.persistentSessions;
            return { persistentSessions: remaining };
          });
        } else {
          set((s) => {
            const existing = s.persistentSessions[connectionId];
            return {
              persistentSessions: {
                ...s.persistentSessions,
                [connectionId]: {
                  connectionId,
                  sessionId: sessionId ?? existing?.sessionId ?? null,
                  state: runState,
                  attachedTabIds: existing?.attachedTabIds ?? [],
                  ...(errorMessage ? { errorMessage } : {}),
                },
              },
            };
          });
        }
        frontendLog(
          "app_store",
          `persistent-session-state: ${connectionId} → ${rawState} (tabs: ${attachedTabCount})`
        );
      }).catch((err: unknown) => {
        frontendLog(
          "app_store",
          `Failed to subscribe to persistent session events: ${err instanceof Error ? err.message : String(err)}`
        );
      });
    },

    updateSettings: async (newSettings) => {
      try {
        const oldSettings = get().settings;
        await persistSettings(newSettings);
        set({ settings: newSettings, savedSettings: newSettings });

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

    reloadConnectionsFromBackend: () => {
      frontendLog("connection_sync", "focus reload: triggered by external event");
      void applyConnectionReload();
    },

    addConnection: (connection) => {
      set((state) => ({ connections: [...state.connections, connection] }));
      frontendLog("connection_sync", `addConnection: persisting ${connection.id}`);
      persistConnection(stripPassword(connection))
        .then((persistedId) => {
          reconcileConnectionId(connection.id, persistedId);
          toast.success(`Saved ${connection.name}`);
          return applyConnectionReload();
        })
        .catch((err) => {
          console.error("Failed to persist new connection:", err);
          toast.error(
            `Failed to save ${connection.name}: ${err instanceof Error ? err.message : String(err)}`
          );
        });
    },

    updateConnection: (connection) => {
      set((state) => ({
        connections: state.connections.map((c) => (c.id === connection.id ? connection : c)),
      }));
      frontendLog("connection_sync", `updateConnection: persisting ${connection.id}`);
      persistConnection(stripPassword(connection))
        .then((persistedId) => {
          // A rename changes the name-derived persisted id; reconcile so a connect
          // before the reload stores its credential under the new id (#875).
          reconcileConnectionId(connection.id, persistedId);
          toast.success(`Saved ${connection.name}`);
          return applyConnectionReload();
        })
        .catch((err) => {
          console.error("Failed to persist connection update:", err);
          toast.error(
            `Failed to save ${connection.name}: ${err instanceof Error ? err.message : String(err)}`
          );
        });
    },

    deleteConnection: (connectionId) => {
      const conn = get().connections.find((c) => c.id === connectionId);
      frontendLog("connection_sync", `deleteConnection: removing ${connectionId} optimistically`);
      set((state) => ({
        connections: state.connections.filter((c) => c.id !== connectionId),
      }));
      removeConnection(connectionId, conn?.sourceFile)
        .then(() => {
          frontendLog("connection_sync", `deleteConnection: backend confirmed, reloading`);
          toast.success(`Deleted ${conn?.name ?? "connection"}`);
          return applyConnectionReload();
        })
        .catch((err) => {
          console.error("Failed to persist connection deletion:", err);
          toast.error(
            `Failed to delete ${conn?.name ?? "connection"}: ${err instanceof Error ? err.message : String(err)}`
          );
        });
    },

    bulkDeleteConnections: (connectionIds) => {
      const idSet = new Set(connectionIds);
      const toDelete = get().connections.filter((c) => idSet.has(c.id));
      frontendLog(
        "connection_sync",
        `bulkDeleteConnections: removing ${connectionIds.join(", ")} optimistically`
      );
      set((state) => ({
        connections: state.connections.filter((c) => !idSet.has(c.id)),
      }));
      Promise.all(toDelete.map((c) => removeConnection(c.id, c.sourceFile)))
        .then(() => {
          frontendLog("connection_sync", `bulkDeleteConnections: backend confirmed, reloading`);
          return applyConnectionReload();
        })
        .catch((err) => console.error("Failed to persist bulk connection deletion:", err));
    },

    addFolder: (folder) => {
      set((state) => ({ folders: [...state.folders, folder] }));
      frontendLog("connection_sync", `addFolder: persisting ${folder.id}`);
      persistFolder(folder)
        .then(() => applyConnectionReload())
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
      frontendLog("connection_sync", `deleteFolder: removing ${folderId}`);
      removeFolder(folderId)
        .then(() => applyConnectionReload())
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
      frontendLog("connection_sync", `duplicateConnection: persisting copy of ${connectionId}`);
      persistConnection(stripPassword(duplicate))
        .then(() => applyConnectionReload())
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
        frontendLog("connection_sync", `moveConnectionToFolder: persisting ${connectionId}`);
        persistConnection(stripPassword(moved))
          .then(() => applyConnectionReload())
          .catch((err) => console.error("Failed to persist connection move:", err));
      }
    },

    bulkMoveConnectionsToFolder: (connectionIds, folderId) => {
      const idSet = new Set(connectionIds);

      // Optimistic update for instant visual feedback
      set((state) => ({
        connections: state.connections.map((c) => (idSet.has(c.id) ? { ...c, folderId } : c)),
      }));

      // Persist all connections in parallel, then reload once
      const moved = get().connections.filter((c) => idSet.has(c.id));
      frontendLog(
        "connection_sync",
        `bulkMoveConnectionsToFolder: persisting ${moved.length} connections`
      );
      Promise.all(moved.map((conn) => persistConnection(stripPassword(conn))))
        .then(() => applyConnectionReload())
        .catch((err) => console.error("Failed to persist bulk connection move:", err));
    },

    // File browser / SFTP
    fileEntries: [],
    currentPath: "/",
    sftpSessionId: null,
    sftpStatus: "idle",
    sftpError: null,
    sftpConnectedHost: null,
    sftpLastConfig: null,

    setCurrentPath: (path) => set({ currentPath: path }),
    setFileEntries: (entries) => set({ fileEntries: entries }),

    connectSftp: async (config: Record<string, unknown>) => {
      // Retain the config so a failed connect can be retried (audit gap S1).
      set({ sftpStatus: "connecting", sftpError: null, sftpLastConfig: config });
      try {
        const sessionId = await sftpOpen(config);
        // Resolve the real remote home via SFTP realpath(".") instead of the
        // fragile /home/<user> guess, which is wrong for non-Linux layouts and
        // custom home paths (audit GAP C2, issue #1143). Fall back to root if
        // realpath is unsupported or the resolved home cannot be listed.
        let entries: FileEntry[];
        let activePath = "/";
        try {
          const homePath = await sftpRealpath(sessionId, ".");
          entries = await sftpListDir(sessionId, homePath);
          activePath = homePath;
        } catch (homeErr) {
          frontendLog(
            "sftp",
            `connectSftp: home resolution failed, falling back to root: ${
              homeErr instanceof Error ? homeErr.message : String(homeErr)
            }`
          );
          entries = await sftpListDir(sessionId, "/");
        }
        set({
          sftpSessionId: sessionId,
          sftpStatus: "connected",
          currentPath: activePath,
          fileEntries: entries,
          sftpConnectedHost: `${config.username as string}@${config.host as string}:${config.port as number}`,
        });
      } catch (err) {
        set({
          sftpStatus: "error",
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
        sftpStatus: "idle",
        fileEntries: [],
        currentPath: "/",
        sftpError: null,
        sftpConnectedHost: null,
        sftpLastConfig: null,
      });
    },

    retrySftp: async () => {
      const config = useAppStore.getState().sftpLastConfig;
      if (!config) {
        frontendLog("sftp", "retrySftp: no persisted config to retry with");
        return;
      }
      frontendLog("sftp", "retrySftp: re-attempting SFTP connect");
      await useAppStore.getState().connectSftp(config);
    },

    dismissSftpError: () =>
      // Clearing the error must also leave a coherent status: fall back to
      // `connected` when a live session survived the error (a recoverable
      // listing error), otherwise `idle`. Leaving it on `error` would keep the
      // failed-connect placeholder up even after the message is dismissed.
      set((state) => ({
        sftpError: null,
        sftpStatus: state.sftpSessionId ? "connected" : "idle",
      })),

    navigateSftp: async (path: string) => {
      const sessionId = useAppStore.getState().sftpSessionId;
      if (!sessionId) return;
      const seq = ++_sftpListSeq;
      set({ sftpStatus: "listing", sftpError: null });
      try {
        const entries = await sftpListDir(sessionId, path);
        // Ignore a stale response: a newer navigate/refresh superseded this one.
        if (seq !== _sftpListSeq) {
          frontendLog("sftp", `navigateSftp: dropping stale list for ${path} (seq ${seq})`);
          return;
        }
        set({ fileEntries: entries, currentPath: path, sftpStatus: "connected" });
      } catch (err) {
        if (seq !== _sftpListSeq) return;
        const message = err instanceof Error ? err.message : String(err);
        // A dead session (audit gap S2) must drop sftpSessionId so the UI stops
        // looking connected and the auto-connect effect / Reconnect can recover.
        const sessionDead = isSftpSessionDeadError(message);
        if (sessionDead) {
          frontendLog("sftp", `navigateSftp: session appears dead — clearing session (${message})`);
        }
        set({
          sftpStatus: "error",
          sftpError: message,
          ...(sessionDead ? { sftpSessionId: null, sftpConnectedHost: null } : {}),
        });
      }
    },

    refreshSftp: async () => {
      const { sftpSessionId, currentPath } = useAppStore.getState();
      if (!sftpSessionId) return;
      const seq = ++_sftpListSeq;
      set({ sftpStatus: "listing", sftpError: null });
      try {
        const entries = await sftpListDir(sftpSessionId, currentPath);
        // Ignore a stale response: a newer navigate/refresh superseded this one.
        if (seq !== _sftpListSeq) {
          frontendLog("sftp", `refreshSftp: dropping stale list for ${currentPath} (seq ${seq})`);
          return;
        }
        set({ fileEntries: entries, sftpStatus: "connected" });
      } catch (err) {
        if (seq !== _sftpListSeq) return;
        const message = err instanceof Error ? err.message : String(err);
        const sessionDead = isSftpSessionDeadError(message);
        if (sessionDead) {
          frontendLog("sftp", `refreshSftp: session appears dead — clearing session (${message})`);
        }
        set({
          sftpStatus: "error",
          sftpError: message,
          ...(sessionDead ? { sftpSessionId: null, sftpConnectedHost: null } : {}),
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
      set((state) => ({
        tabColors:
          color === null ? omitKey(state.tabColors, tabId) : { ...state.tabColors, [tabId]: color },
      })),

    // Per-tab terminal spawn errors (runtime-only)
    terminalSpawnErrors: {},
    terminalRetryCounters: {},
    terminalConnecting: {},
    terminalAutoRetryCount: {},
    terminalWaitingForAgent: {},
    setTerminalSpawnError: (tabId, error) =>
      set((state) => ({
        terminalSpawnErrors:
          error === null
            ? omitKey(state.terminalSpawnErrors, tabId)
            : { ...state.terminalSpawnErrors, [tabId]: error },
      })),
    retryTerminalSpawn: (tabId) =>
      set((state) => ({
        terminalSpawnErrors: omitKey(state.terminalSpawnErrors, tabId),
        terminalAutoRetryCount: omitKey(state.terminalAutoRetryCount, tabId),
        terminalWaitingForAgent: omitKey(state.terminalWaitingForAgent, tabId),
        terminalRetryCounters: {
          ...state.terminalRetryCounters,
          [tabId]: (state.terminalRetryCounters[tabId] ?? 0) + 1,
        },
      })),
    setTerminalConnecting: (tabId, connecting) =>
      set((state) => ({
        terminalConnecting: connecting
          ? { ...state.terminalConnecting, [tabId]: true }
          : omitKey(state.terminalConnecting, tabId),
      })),
    setTerminalAutoRetrying: (tabId, count) =>
      set((state) => ({
        terminalConnecting: omitKey(state.terminalConnecting, tabId),
        terminalAutoRetryCount:
          count === 0
            ? omitKey(state.terminalAutoRetryCount, tabId)
            : { ...state.terminalAutoRetryCount, [tabId]: count },
      })),
    setTerminalWaitingForAgent: (tabId, agentId) =>
      set((state) => ({
        terminalConnecting: omitKey(state.terminalConnecting, tabId),
        terminalWaitingForAgent:
          agentId === null
            ? omitKey(state.terminalWaitingForAgent, tabId)
            : { ...state.terminalWaitingForAgent, [tabId]: agentId },
      })),

    // Per-tab terminal session disconnects (runtime-only)
    terminalExitedTabs: {},
    terminalExitInfo: {},
    intentionallyKilledSessions: {},
    terminalDisconnectErrors: {},
    terminalViewMode: {},
    terminalReconnectingTabs: {},
    terminalReattaching: {},
    terminalReconnectPrompt: {},
    terminalReconnectTriggerErrors: {},
    setTerminalExited: (tabId, info) => {
      set((state) => ({
        terminalExitedTabs: { ...state.terminalExitedTabs, [tabId]: true },
        // Record the exit cause/code so the overlay can branch its wording (#1121).
        terminalExitInfo: info
          ? { ...state.terminalExitInfo, [tabId]: info }
          : state.terminalExitInfo,
        // A user-initiated kill goes straight to view mode: the session is dead
        // and scrollback is preserved, but no "unexpected disconnect" overlay is
        // shown for something the user asked for (#1121).
        terminalViewMode:
          info?.reason === "killed"
            ? { ...state.terminalViewMode, [tabId]: true }
            : state.terminalViewMode,
        // Clear any stale reconnecting flag — session is definitively dead now
        terminalReconnectingTabs: omitKey(state.terminalReconnectingTabs, tabId),
        terminalReconnectTriggerErrors: omitKey(state.terminalReconnectTriggerErrors, tabId),
      }));
      // Stop monitoring when the terminal session dies — the stats are no
      // longer being updated and the overlay hides the terminal anyway.
      if (get().monitoringSessionId) {
        get().disconnectMonitoring();
      }
    },
    markSessionKilled: (sessionId) =>
      set((state) => ({
        intentionallyKilledSessions: {
          ...state.intentionallyKilledSessions,
          [sessionId]: true,
        },
      })),
    consumeSessionKilled: (sessionId) => {
      const wasKilled = !!get().intentionallyKilledSessions[sessionId];
      if (wasKilled) {
        set((state) => ({
          intentionallyKilledSessions: omitKey(state.intentionallyKilledSessions, sessionId),
        }));
      }
      return wasKilled;
    },
    setTerminalDisconnectWithError: (tabId, error) => {
      set((state) => ({
        terminalExitedTabs: { ...state.terminalExitedTabs, [tabId]: true },
        terminalDisconnectErrors: { ...state.terminalDisconnectErrors, [tabId]: error },
        terminalReconnectingTabs: omitKey(state.terminalReconnectingTabs, tabId),
      }));
      if (get().monitoringSessionId) {
        get().disconnectMonitoring();
      }
    },
    setTerminalReconnecting: (tabId, reconnecting) =>
      set((state) =>
        reconnecting
          ? { terminalReconnectingTabs: { ...state.terminalReconnectingTabs, [tabId]: true } }
          : {
              terminalReconnectingTabs: omitKey(state.terminalReconnectingTabs, tabId),
              terminalReconnectTriggerErrors: omitKey(state.terminalReconnectTriggerErrors, tabId),
            }
      ),
    setTerminalReattaching: (tabId, reattaching) =>
      set((state) => ({
        terminalReattaching: reattaching
          ? { ...state.terminalReattaching, [tabId]: true }
          : omitKey(state.terminalReattaching, tabId),
      })),
    setTerminalReconnectTriggerError: (tabId, error) =>
      set((state) => ({
        terminalReconnectTriggerErrors:
          error === null
            ? omitKey(state.terminalReconnectTriggerErrors, tabId)
            : { ...state.terminalReconnectTriggerErrors, [tabId]: error },
      })),
    dismissTerminalDisconnect: (tabId) =>
      set((state) => ({
        // Keep terminalExitedTabs[tabId] = true so the banner can detect the dead session;
        // only flip the overlay off by entering view mode.
        terminalViewMode: { ...state.terminalViewMode, [tabId]: true },
      })),
    reconnectTerminal: (tabId) =>
      set((state) => ({
        terminalExitedTabs: omitKey(state.terminalExitedTabs, tabId),
        terminalExitInfo: omitKey(state.terminalExitInfo, tabId),
        terminalDisconnectErrors: omitKey(state.terminalDisconnectErrors, tabId),
        terminalViewMode: omitKey(state.terminalViewMode, tabId),
        terminalReconnectPrompt: omitKey(state.terminalReconnectPrompt, tabId),
        terminalReconnectingTabs: omitKey(state.terminalReconnectingTabs, tabId),
        terminalAutoRetryCount: omitKey(state.terminalAutoRetryCount, tabId),
        terminalWaitingForAgent: omitKey(state.terminalWaitingForAgent, tabId),
        terminalSpawnErrors: omitKey(state.terminalSpawnErrors, tabId),
        terminalReconnectTriggerErrors: omitKey(state.terminalReconnectTriggerErrors, tabId),
        // Set connecting immediately so the "Connecting…" overlay appears at once,
        // without a gap between the disconnect overlay disappearing and the effect
        // re-running to call setTerminalConnecting().
        terminalConnecting: { ...state.terminalConnecting, [tabId]: true },
        terminalRetryCounters: {
          ...state.terminalRetryCounters,
          [tabId]: (state.terminalRetryCounters[tabId] ?? 0) + 1,
        },
      })),
    showTerminalReconnectPrompt: (tabId) =>
      set((state) => ({
        terminalReconnectPrompt: { ...state.terminalReconnectPrompt, [tabId]: true },
      })),
    dismissTerminalReconnectPrompt: (tabId) =>
      set((state) => ({ terminalReconnectPrompt: omitKey(state.terminalReconnectPrompt, tabId) })),

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
      persistAgent({
        id: agent.id,
        name: agent.name,
        config: agent.config,
        agentSettings: agent.agentSettings,
      }).catch((err) => console.error("Failed to persist new agent:", err));
    },

    updateRemoteAgent: (agent) => {
      set((state) => ({
        remoteAgents: state.remoteAgents.map((a) => (a.id === agent.id ? agent : a)),
      }));
      persistAgent({
        id: agent.id,
        name: agent.name,
        config: agent.config,
        agentSettings: agent.agentSettings,
      }).catch((err) => console.error("Failed to persist agent update:", err));
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
        const result = await apiConnectAgent(agentId, config, agent.agentSettings);

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

    clearAgentSessions: (agentId) => {
      set((s) => ({
        agentSessions: { ...s.agentSessions, [agentId]: [] },
      }));
    },

    setAgentCapabilities: (agentId, capabilities) => {
      set((state) => ({
        remoteAgents: state.remoteAgents.map((a) =>
          a.id === agentId ? { ...a, capabilities } : a
        ),
      }));
    },

    updateAgentSettings: async (agentId, settings) => {
      await apiApplyAgentSettings(agentId, settings);
      set((state) => ({
        remoteAgents: state.remoteAgents.map((a) =>
          a.id === agentId ? { ...a, agentSettings: settings } : a
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

    duplicateAgentDef: async (agentId, definitionId) => {
      const original = useAppStore
        .getState()
        .agentDefinitions[agentId]?.find((d) => d.id === definitionId);
      if (!original) return;
      await useAppStore.getState().saveAgentDef(agentId, {
        name: `Copy of ${original.name}`,
        type: original.sessionType,
        config: original.config,
        persistent: original.persistent,
        folder_id: original.folderId,
        terminal_options: original.terminalOptions ?? null,
        icon: original.icon ?? null,
      });
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

    moveAgentDefToFolder: async (agentId, defId, folderId) => {
      await get().updateAgentDef(agentId, { id: defId, folder_id: folderId });
    },

    bulkMoveAgentDefsToFolder: async (agentId, defIds, folderId) => {
      await Promise.all(
        defIds.map((defId) => get().moveAgentDefToFolder(agentId, defId, folderId))
      );
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
        toast.success(`Created folder ${folder.name}`);
      } catch (err) {
        console.error(`Failed to create agent folder on ${agentId}:`, err);
        toast.error(`Failed to create folder: ${err instanceof Error ? err.message : String(err)}`);
      }
    },

    updateAgentFolder: async (agentId, params) => {
      // A rename carries a new `name`; other prop updates (e.g. expansion state)
      // stay silent so we do not toast on bookkeeping writes.
      const isRename = typeof params.name === "string";
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
        if (isRename) toast.success(`Renamed folder to ${updated.name}`);
      } catch (err) {
        console.error(`Failed to update agent folder on ${agentId}:`, err);
        if (isRename) {
          toast.error(
            `Failed to rename folder: ${err instanceof Error ? err.message : String(err)}`
          );
        }
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

    resolveAgentErrorTabs: (agentId) => {
      const defs = get().agentDefinitions[agentId] ?? [];

      const convertPanel = (panel: PanelNode): PanelNode => {
        if (panel.type === "split") {
          return { ...panel, children: panel.children.map(convertPanel) };
        }
        const updatedTabs = panel.tabs.map((tab) => {
          if (tab.contentType !== "agent-error" || tab.agentErrorMeta?.agentId !== agentId) {
            return tab;
          }
          const def = defs.find((d) => d.id === tab.agentErrorMeta!.definitionId);
          if (!def) return tab; // definition still missing — keep error tab
          const config: ConnectionConfig = {
            type: "remote-session",
            config: {
              agentId,
              sessionType: def.sessionType,
              shell: def.config["shell"] as string | undefined,
              serialPort: def.config["port"] as string | undefined,
              persistent: def.persistent,
              title: def.name,
            },
          };
          return {
            ...tab,
            contentType: "terminal" as const,
            connectionType: "remote-session" as const,
            config,
            sessionId: null,
            agentErrorMeta: undefined,
            initialCommand: tab.agentErrorMeta!.initialCommand,
          };
        });
        return { ...panel, tabs: updatedTabs };
      };

      set((s) => ({
        rootPanel: convertPanel(s.rootPanel),
        tabGroups: s.tabGroups.map((g) => ({ ...g, rootPanel: convertPanel(g.rootPanel) })),
      }));
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
    monitoringSampleCount: 0,
    monitoringCancelled: false,
    monitoringStatsCache: {},
    sessionCapabilities: {},

    clearMonitoringError: () => set({ monitoringError: null }),
    setMonitoringCancelled: (cancelled) => set({ monitoringCancelled: cancelled }),

    setSessionCapabilities: (sessionId, caps) =>
      set((state) => ({
        sessionCapabilities: { ...state.sessionCapabilities, [sessionId]: caps },
      })),

    connectMonitoring: async (config: Record<string, unknown>) => {
      const { monitoringStatsCache } = useAppStore.getState();
      try {
        // Session-based monitoring: config carries sessionId for "remote-session" tabs.
        // The agent pushes stats via "session-monitoring-stats" Tauri events.
        if (config._sessionBased) {
          const sessionId = config._sessionId as string;
          const cachedStats = monitoringStatsCache[sessionId] ?? null;
          set({
            monitoringLoading: true,
            monitoringError: null,
            monitoringStats: cachedStats,
            monitoringHost: cachedStats ? sessionId : null,
            // Fresh connection: reset the sample counter so CPU shows the
            // priming indicator until the second push arrives (audit gap G10).
            monitoringSampleCount: 0,
            // Clear any stale cancel affordance from a previous attempt (G8).
            monitoringCancelled: false,
          });

          const unlisten = await onSessionMonitoringStats((sid, stats) => {
            if (sid === sessionId) {
              useAppStore.setState((state) => ({
                monitoringStats: stats,
                monitoringError: null,
                monitoringSampleCount: state.monitoringSampleCount + 1,
                monitoringStatsCache: { ...state.monitoringStatsCache, [sessionId]: stats },
              }));
            }
          });
          // Store unlisten in a module-level variable so disconnectMonitoring can call it.
          _monitoringUnlisten = unlisten;

          await sessionMonitoringOpen(sessionId);
          set({
            monitoringSessionId: sessionId,
            monitoringHost: sessionId,
            monitoringLoading: false,
          });
          return;
        }

        // Standard SSH-based monitoring (direct connection from desktop).
        const hostKey = `${config.username as string}@${config.host as string}:${config.port as number}`;
        const cachedStats = monitoringStatsCache[hostKey] ?? null;
        set({
          monitoringLoading: true,
          monitoringError: null,
          monitoringStats: cachedStats,
          monitoringHost: cachedStats ? hostKey : null,
          // Fresh connection: reset the sample counter so CPU shows the priming
          // indicator until the second fetch arrives (audit gap G10).
          monitoringSampleCount: 0,
          // Clear any stale cancel affordance from a previous attempt (G8).
          monitoringCancelled: false,
        });

        const sessionId = await monitoringOpen(config);
        const stats = await monitoringFetchStats(sessionId);
        set((state) => ({
          monitoringSessionId: sessionId,
          monitoringHost: hostKey,
          monitoringStats: stats,
          monitoringLoading: false,
          monitoringSampleCount: state.monitoringSampleCount + 1,
          monitoringStatsCache: { ...state.monitoringStatsCache, [hostKey]: stats },
        }));
      } catch (err) {
        // The session-based branch attaches the stats listener before the open
        // that may throw here. Detach it so a failed open never leaks a dangling
        // Tauri listener (monitoringSessionId stays null, so disconnectMonitoring
        // would not clean it up either). See audit gap G5.
        if (_monitoringUnlisten) {
          frontendLog("monitoring", "detaching stats listener after failed monitoring open");
          _monitoringUnlisten();
          _monitoringUnlisten = null;
        }
        set({
          monitoringLoading: false,
          monitoringError: err instanceof Error ? err.message : String(err),
        });
      }
    },

    disconnectMonitoring: async () => {
      const { monitoringSessionId, monitoringHost, monitoringStats, sessionCapabilities } =
        useAppStore.getState();
      if (monitoringSessionId) {
        try {
          // If this was a session-based monitoring, stop it; otherwise close SSH session.
          if (sessionCapabilities[monitoringSessionId] !== undefined) {
            await sessionMonitoringClose(monitoringSessionId);
          } else {
            await monitoringClose(monitoringSessionId);
          }
        } catch {
          // Ignore close errors
        }
      }
      if (_monitoringUnlisten) {
        _monitoringUnlisten();
        _monitoringUnlisten = null;
      }
      set((state) => ({
        monitoringSessionId: null,
        monitoringHost: null,
        monitoringStats: null,
        monitoringError: null,
        monitoringSampleCount: 0,
        monitoringCancelled: false,
        // Preserve last-known stats so the UI can show them instantly on reconnect.
        monitoringStatsCache:
          monitoringHost && monitoringStats
            ? { ...state.monitoringStatsCache, [monitoringHost]: monitoringStats }
            : state.monitoringStatsCache,
      }));
    },

    refreshMonitoring: async () => {
      const { monitoringSessionId, monitoringHost, sessionCapabilities } = useAppStore.getState();
      if (!monitoringSessionId) return;
      // Session-based monitoring is push-based; no explicit refresh needed.
      if (sessionCapabilities[monitoringSessionId] !== undefined) return;
      try {
        const stats = await monitoringFetchStats(monitoringSessionId);
        set((state) => ({
          monitoringStats: stats,
          monitoringError: null,
          monitoringSampleCount: state.monitoringSampleCount + 1,
          monitoringStatsCache: monitoringHost
            ? { ...state.monitoringStatsCache, [monitoringHost]: stats }
            : state.monitoringStatsCache,
        }));
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
      const name = get().tunnels.find((t) => t.id === tunnelId)?.name ?? "tunnel";
      const toastId = toast.loading(`Deleting ${name}…`);
      try {
        await apiDeleteTunnel(tunnelId);
        set((state) => ({
          tunnels: state.tunnels.filter((t) => t.id !== tunnelId),
          tunnelStates: Object.fromEntries(
            Object.entries(state.tunnelStates).filter(([k]) => k !== tunnelId)
          ),
        }));
        toast.success(`Deleted ${name}`, { id: toastId });
      } catch (err) {
        toast.error(
          `Failed to delete ${name}: ${err instanceof Error ? err.message : String(err)}`,
          { id: toastId }
        );
        throw err;
      }
    },

    startTunnel: async (tunnelId) => {
      // GAP 4 (#1141): ignore a re-entrant start while a prior start for the
      // same tunnel is still in flight, so a rapid double-click can't fire a
      // second backend call (spurious "already connecting/active" toast).
      if (_tunnelStartInFlight.has(tunnelId)) return;
      _tunnelStartInFlight.add(tunnelId);
      const name = get().tunnels.find((t) => t.id === tunnelId)?.name ?? "tunnel";
      const toastId = toast.loading(`Starting ${name}…`);
      try {
        await apiStartTunnel(tunnelId);
        toast.success(`Started ${name}`, { id: toastId });
      } catch (err) {
        console.error("Failed to start tunnel:", err);
        toast.error(
          `Failed to start ${name}: ${err instanceof Error ? err.message : String(err)}`,
          { id: toastId }
        );
        throw err;
      } finally {
        _tunnelStartInFlight.delete(tunnelId);
      }
    },

    stopTunnel: async (tunnelId) => {
      // GAP 4 (#1141): ignore a re-entrant stop while a prior stop for the same
      // tunnel is still in flight (see startTunnel).
      if (_tunnelStopInFlight.has(tunnelId)) return;
      _tunnelStopInFlight.add(tunnelId);
      const name = get().tunnels.find((t) => t.id === tunnelId)?.name ?? "tunnel";
      const toastId = toast.loading(`Stopping ${name}…`);
      try {
        await apiStopTunnel(tunnelId);
        toast.success(`Stopped ${name}`, { id: toastId });
      } catch (err) {
        console.error("Failed to stop tunnel:", err);
        toast.error(`Failed to stop ${name}: ${err instanceof Error ? err.message : String(err)}`, {
          id: toastId,
        });
        throw err;
      } finally {
        _tunnelStopInFlight.delete(tunnelId);
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

    // Embedded Servers
    embeddedServers: [],
    embeddedServerStates: {},

    loadEmbeddedServers: async () => {
      try {
        const servers = await listEmbeddedServers();
        const stateList = await getEmbeddedServerStates();
        const embeddedServerStates: Record<string, EmbeddedServerState> = {};
        for (const s of stateList) {
          embeddedServerStates[s.serverId] = s;
        }
        set({ embeddedServers: servers, embeddedServerStates });
      } catch (err) {
        console.error("Failed to load embedded servers:", err);
      }
    },

    refreshEmbeddedServerStates: async () => {
      try {
        const stateList = await getEmbeddedServerStates();
        const embeddedServerStates: Record<string, EmbeddedServerState> = {};
        for (const s of stateList) {
          embeddedServerStates[s.serverId] = s;
        }
        set({ embeddedServerStates });
      } catch (err) {
        frontendLog("embedded_server", `Failed to refresh embedded server states: ${err}`);
      }
    },

    saveEmbeddedServer: async (config) => {
      try {
        await apiSaveEmbeddedServer(config);
        set((state) => {
          const exists = state.embeddedServers.some((s) => s.id === config.id);
          const embeddedServers = exists
            ? state.embeddedServers.map((s) => (s.id === config.id ? config : s))
            : [...state.embeddedServers, config];
          return { embeddedServers };
        });
      } catch (err) {
        console.error("Failed to save embedded server:", err);
        throw err;
      }
    },

    deleteEmbeddedServer: async (serverId) => {
      try {
        await apiDeleteEmbeddedServer(serverId);
        set((state) => ({
          embeddedServers: state.embeddedServers.filter((s) => s.id !== serverId),
          embeddedServerStates: Object.fromEntries(
            Object.entries(state.embeddedServerStates).filter(([k]) => k !== serverId)
          ),
        }));
      } catch (err) {
        console.error("Failed to delete embedded server:", err);
      }
    },

    startEmbeddedServer: async (serverId) => {
      try {
        await apiStartEmbeddedServer(serverId);
      } catch (err) {
        frontendLog("embedded_server", `Failed to start embedded server ${serverId}: ${err}`);
        throw err;
      }
    },

    stopEmbeddedServer: async (serverId) => {
      try {
        await apiStopEmbeddedServer(serverId);
      } catch (err) {
        frontendLog("embedded_server", `Failed to stop embedded server ${serverId}: ${err}`);
        throw err;
      }
    },

    updateEmbeddedServerState: (state) => {
      set((s) => ({
        embeddedServerStates: { ...s.embeddedServerStates, [state.serverId]: state },
      }));
    },

    quickShareServer: async (path, protocol) => {
      const config: EmbeddedServerConfig = {
        id: "",
        name: `Quick Share (${protocol.toUpperCase()})`,
        serverType: protocol,
        rootDirectory: path,
        bindHost: "127.0.0.1",
        port: DEFAULT_PORTS[protocol],
        autoStart: false,
        readOnly: false,
        directoryListing: protocol === "http" ? true : undefined,
      };
      const serverId = await apiCreateAndStartServer(config);
      // Refresh server list so the new entry shows up in the sidebar.
      await get().loadEmbeddedServers();
      return serverId;
    },

    // Workspaces
    workspaces: [],
    activeWorkspaceName: null,
    launchingWorkspaceId: null,

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
      // Only mutate local state after the backend delete resolves, and rethrow
      // on failure so the caller can surface the error (GAP G7). A swallowed
      // failure would optimistically remove the item, then silently "un-delete"
      // it on the next loadWorkspaces with no explanation.
      await apiDeleteWorkspace(workspaceId);
      set((state) => ({
        workspaces: state.workspaces.filter((ws) => ws.id !== workspaceId),
      }));
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
      // In-flight guard (GAP G6, #1146): launching a workspace awaits several
      // multi-second phases (credential unlock, agent connects). Without this
      // guard a second double-click / Play press starts a concurrent launch,
      // racing the two `set(...)` calls and orphaning sessions. Ignore any
      // re-entrant launch (of this or any other workspace) while one is running.
      if (get().launchingWorkspaceId !== null) {
        frontendLog(
          "workspace",
          `launchWorkspace(${workspaceId}) ignored: a launch is already in flight`
        );
        return;
      }
      set({ launchingWorkspaceId: workspaceId });
      try {
        const definition = await apiLoadWorkspace(workspaceId);
        const state = get();

        // Collect every tab def referenced in this workspace once.
        const allTabDefs = definition.tabGroups.flatMap((g) =>
          getWorkspaceLeaves(g.layout).flatMap((leaf) => leaf.tabs)
        );

        // Collect disconnected agents referenced by agentRef tabs that use stored credentials.
        const referencedAgentIds = new Set(
          allTabDefs.filter((t) => t.agentRef).map((t) => t.agentRef!.agentId)
        );
        const disconnectedAgentsNeedingCreds = state.remoteAgents.filter((agent) => {
          if (!referencedAgentIds.has(agent.id)) return false;
          if (agent.connectionState === "connected") return false;
          return (
            agent.config.authMethod === "password" ||
            (agent.config.authMethod === "key" && agent.config.savePassword)
          );
        });

        // Before opening any tabs, check whether the credential store needs to be
        // unlocked for any connection in this workspace. If so, prompt once upfront
        // so that all tabs can connect immediately after unlock rather than failing
        // and prompting individually.
        const credStatus = state.credentialStoreStatus;
        if (credStatus?.mode === "master_password" && credStatus?.status === "locked") {
          const needsStoredCredential =
            allTabDefs.some((tabDef) => {
              if (!tabDef.connectionRef) return false;
              const saved = state.connections.find((c) => c.id === tabDef.connectionRef);
              if (!saved) return false;
              const cfg = saved.config.config as Record<string, unknown>;
              const authMethod = cfg.authMethod as string | undefined;
              const savePassword = cfg.savePassword as boolean | undefined;
              return authMethod === "password" || (authMethod === "key" && savePassword);
            }) || disconnectedAgentsNeedingCreds.length > 0;
          if (needsStoredCredential) {
            const unlocked = await get().requestUnlock();
            if (!unlocked) return;
          }
        }

        // Connect any disconnected agents that have stored credentials so that
        // buildTabGroupsFromWorkspace can resolve their tabs to live terminals.
        if (disconnectedAgentsNeedingCreds.length > 0) {
          await Promise.all(
            disconnectedAgentsNeedingCreds.map(async (agent) => {
              try {
                const resolution = await resolveConnectionCredential(
                  agent.id,
                  agent.config.authMethod,
                  agent.config.savePassword
                );
                const password =
                  resolution.usedStoredCredential && resolution.password
                    ? resolution.password
                    : undefined;
                await get().connectRemoteAgent(agent.id, password);
              } catch {
                // Connection failure is surfaced as agent-error tabs below
              }
            })
          );
        }

        // After the store is unlocked (or was already unlocked), resolve stored
        // credentials for all referenced connections. Inject resolved passwords
        // into the connection configs so that Terminal.tsx can connect immediately
        // without the backend having to prompt interactively.
        const referencedIds = new Set(
          allTabDefs.filter((t) => t.connectionRef).map((t) => t.connectionRef!)
        );
        const resolvedConnections = await Promise.all(
          state.connections.map(async (conn) => {
            if (!referencedIds.has(conn.id)) return conn;
            const cfg = conn.config.config as Record<string, unknown>;
            const authMethod = cfg.authMethod as string | undefined;
            const savePassword = cfg.savePassword as boolean | undefined;
            if (!authMethod) return conn;
            const resolution = await resolveConnectionCredential(conn.id, authMethod, savePassword);
            if (!resolution.usedStoredCredential || !resolution.password) return conn;
            return {
              ...conn,
              config: {
                ...conn.config,
                config: { ...cfg, password: resolution.password },
              },
            };
          })
        );

        // Re-read agent state so newly-connected agents are reflected in tab resolution.
        const freshState = get();
        const agentContext = {
          agents: freshState.remoteAgents.map((a) => ({
            id: a.id,
            name: a.name,
            connected: a.connectionState === "connected",
          })),
          definitions: freshState.agentDefinitions,
        };

        const builtGroups = buildTabGroupsFromWorkspace(
          definition.tabGroups,
          resolvedConnections,
          state.defaultShell,
          agentContext
        );
        // GAP G3 (#1146): a workspace that builds no launchable tabs (e.g. its
        // referenced connections were all deleted, or it was saved empty) used
        // to return silently, leaving the user with an unchanged window and no
        // explanation. `buildTabGroupsFromWorkspace` maps one group per def, so
        // "empty" means either zero groups or zero tabs across every group.
        const builtTabCount = builtGroups.reduce(
          (n, g) => n + getAllLeaves(g.rootPanel).reduce((m, leaf) => m + leaf.tabs.length, 0),
          0
        );
        if (builtGroups.length === 0 || builtTabCount === 0) {
          frontendLog(
            "workspace",
            `launchWorkspace(${workspaceId}): "${definition.name}" produced no launchable tabs`
          );
          toast.info(`Workspace "${definition.name}" had no launchable tabs`);
          return;
        }
        const firstGroup = builtGroups[0];
        // GAP G1 (#1146): tear down the currently-open live sessions BEFORE the
        // `set` replaces the layout, otherwise their PTY/SSH/agent sessions are
        // dropped from the store and orphaned into the Open Connections panel.
        teardownAllSessions(get());
        // GAP G5 (#1146): raise the guard BEFORE placing the layout so the
        // auto-save subscription that fires from this `set` — and the per-tab
        // connects that follow — do not persist a mid-launch snapshot over the
        // previously-good session.
        beginRestoreGuard(set);
        set({
          tabGroups: builtGroups,
          activeTabGroupId: firstGroup.id,
          rootPanel: firstGroup.rootPanel,
          activePanelId: firstGroup.activePanelId,
          activeWorkspaceName: definition.name,
        });
      } catch (err) {
        // GAP G3 (#1146): a failed load used to be a silent console.error, so a
        // launch that could not open anything looked like nothing happened.
        frontendLog("workspace", `Failed to launch workspace ${workspaceId}: ${String(err)}`);
        toast.error("Could not launch workspace");
      } finally {
        set({ launchingWorkspaceId: null });
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

    restoreInProgress: false,

    saveLastSession: async () => {
      const state = get();
      // Respect the setting at save time so toggling it takes effect immediately.
      if (state.settings.restoreLastSessionOnStartup === false) return;
      const tabGroups = captureAllTabGroups(
        state.tabGroups,
        state.activeTabGroupId,
        state.rootPanel,
        state.connections
      );
      // Only persist when there is at least one real tab to restore. An empty
      // payload tells the backend to clear the stored session instead.
      const totalTabs = tabGroups.reduce(
        (n, g) => n + getWorkspaceLeaves(g.layout).reduce((m, leaf) => m + leaf.tabs.length, 0),
        0
      );
      const activeGroupIndex = Math.max(
        0,
        state.tabGroups.findIndex((g) => g.id === state.activeTabGroupId)
      );
      try {
        await apiSaveLastSession({
          version: "1",
          tabGroups: totalTabs > 0 ? tabGroups : [],
          activeGroupIndex,
        });
      } catch (err) {
        console.error("Failed to save last session:", err);
      }
    },

    scheduleLastSessionSave: () => {
      // GAP G5 (#1146): while a restore/launch is settling, a manual tab action
      // or an in-flight per-tab connect fires this via the layout subscription.
      // Saving now would recapture the whole live tree — including tabs still
      // connecting or in agent-error — over the previously-good session. Skip it
      // until the restored cohort settles (see beginRestoreGuard).
      if (get().restoreInProgress) return;
      if (lastSessionPersistTimer) clearTimeout(lastSessionPersistTimer);
      lastSessionPersistTimer = setTimeout(() => {
        lastSessionPersistTimer = null;
        void get().saveLastSession();
      }, LAST_SESSION_SAVE_DEBOUNCE_MS);
    },

    restoreLastSession: async () => {
      try {
        const session = await apiLoadLastSession();
        if (!session || session.tabGroups.length === 0) return false;
        const state = get();
        // Agents are all disconnected at startup, so agentRef tabs resolve to
        // agent-error tabs rather than silently disappearing.
        const agentContext = {
          agents: state.remoteAgents.map((a) => ({
            id: a.id,
            name: a.name,
            connected: a.connectionState === "connected",
          })),
          definitions: state.agentDefinitions,
        };
        const builtGroups = buildTabGroupsFromWorkspace(
          session.tabGroups,
          state.connections,
          state.defaultShell,
          agentContext
        );
        // GAP G3 (#1146): a stored session whose tabs all fail to build (e.g.
        // every referenced connection was deleted) used to return silently,
        // leaving the user at an empty window indistinguishable from "nothing
        // was saved". `buildTabGroupsFromWorkspace` maps one group per def, so
        // "empty" means either zero groups or zero tabs across every group.
        const builtTabCount = builtGroups.reduce(
          (n, g) => n + getAllLeaves(g.rootPanel).reduce((m, leaf) => m + leaf.tabs.length, 0),
          0
        );
        if (builtGroups.length === 0 || builtTabCount === 0) {
          frontendLog(
            "workspace",
            "restoreLastSession: stored session produced no launchable tabs"
          );
          toast.info("Previous session had no launchable tabs");
          return false;
        }
        const idx = Math.min(Math.max(session.activeGroupIndex, 0), builtGroups.length - 1);
        const activeGroup = builtGroups[idx];
        // GAP G1 (#1146): tear down any currently-open live sessions BEFORE the
        // `set` replaces the layout (e.g. a CLI-opened workspace at startup that
        // runs before restore), otherwise those sessions are orphaned.
        teardownAllSessions(get());
        // GAP G5 (#1146): raise the guard BEFORE placing the layout so the
        // auto-save subscription that fires from this very `set` — and the
        // per-tab connects that follow — are skipped until the cohort settles.
        beginRestoreGuard(set);
        set({
          tabGroups: builtGroups,
          activeTabGroupId: activeGroup.id,
          rootPanel: activeGroup.rootPanel,
          activePanelId: activeGroup.activePanelId,
        });
        return true;
      } catch (err) {
        // GAP G3 (#1146): a corrupt/failed last-session load used to be a silent
        // console.error, so a user who had a populated session opened to a blank
        // window with no explanation. Surface a recoverable error toast.
        frontendLog("workspace", `Failed to restore last session: ${String(err)}`);
        toast.error("Could not restore last session");
        return false;
      }
    },

    clearLastSession: async () => {
      if (lastSessionPersistTimer) {
        clearTimeout(lastSessionPersistTimer);
        lastSessionPersistTimer = null;
      }
      try {
        await apiClearLastSession();
      } catch (err) {
        console.error("Failed to clear last session:", err);
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
    setUnlockDialogOpen: (open) => {
      const prevOpen = get().unlockDialogOpen;
      set({ unlockDialogOpen: open });
      // If the dialog was closed without a prior resolveUnlock(true) call (i.e. the
      // user clicked Skip or dismissed the dialog), cancel any pending request.
      if (prevOpen && !open) {
        get().resolveUnlock(false);
      }
    },
    unlockResolvers: [],
    requestUnlock: () =>
      new Promise<boolean>((resolve) => {
        // Append rather than replace: two concurrent connect flows may both await
        // requestUnlock() before the dialog resolves. Every awaiting caller must
        // settle on the single dialog exit (G1) — overwriting a single resolver
        // would leave the earlier connect wedged forever.
        set((state) => ({
          unlockDialogOpen: true,
          unlockResolvers: [...state.unlockResolvers, resolve],
        }));
      }),
    resolveUnlock: (unlocked) => {
      const { unlockResolvers } = get();
      if (unlockResolvers.length === 0) return;
      // Clear first so a re-entrant resolveUnlock() (e.g. the unlocked event and a
      // dialog-close both firing) is a harmless no-op — every promise settles once.
      set({ unlockResolvers: [] });
      for (const resolve of unlockResolvers) {
        resolve(unlocked);
      }
    },
    masterPasswordSetupOpen: false,
    masterPasswordSetupMode: "setup",
    openMasterPasswordSetup: (mode) =>
      set({ masterPasswordSetupOpen: true, masterPasswordSetupMode: mode }),
    closeMasterPasswordSetup: () => set({ masterPasswordSetupOpen: false }),

    // Portable mode
    isPortableMode: false,
    portableDataDir: null,
    loadAppMode: async () => {
      try {
        const info = await apiGetAppMode();
        set({ isPortableMode: info.isPortable, portableDataDir: info.dataDir });
      } catch (err) {
        console.error("Failed to load app mode:", err);
      }
    },

    // Update checker
    updateCheckState: "idle",
    updateInfo: null,
    updateNotificationDismissed: false,
    checkForUpdates: async (force: boolean) => {
      set({ updateCheckState: "checking" });
      try {
        const info = await apiCheckForUpdates(force);
        if (info.available) {
          const currentSettings = get().settings;
          const skippedVersion = currentSettings.updates?.skippedVersion;
          // If the update is available but the user previously skipped this exact
          // version (and it's not a security patch), keep the dot visible but don't
          // reset the dismissed flag so no popup re-appears.
          const isSkipped = !info.isSecurity && skippedVersion === info.latestVersion;
          set({
            updateCheckState: "available",
            updateInfo: info,
            // Reset dismissed flag so the popup shows for newly detected versions,
            // unless the user already skipped this version.
            updateNotificationDismissed: isSkipped,
          });
        } else {
          set({ updateCheckState: "up-to-date", updateInfo: info });
        }
      } catch {
        set({ updateCheckState: "error" });
        frontendLog("update", "Update check failed");
      }
    },
    dismissUpdateNotification: () => set({ updateNotificationDismissed: true }),
    skipUpdate: async () => {
      const { updateInfo } = get();
      if (!updateInfo) return;
      try {
        await apiSkipUpdateVersion(updateInfo.latestVersion);
        // Refresh the settings in the store so skippedVersion is current.
        const updatedSettings = await import("@/services/storage").then((m) => m.getSettings());
        set({
          settings: updatedSettings,
          savedSettings: updatedSettings,
          updateNotificationDismissed: true,
        });
      } catch (err) {
        frontendLog("update", `Failed to skip version: ${err}`);
      }
    },
    clearSkippedUpdateVersion: async () => {
      try {
        await apiClearSkippedVersion();
        const updatedSettings = await import("@/services/storage").then((m) => m.getSettings());
        set({ settings: updatedSettings, savedSettings: updatedSettings });
      } catch (err) {
        frontendLog("update", `Failed to clear skipped version: ${err}`);
      }
    },
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
