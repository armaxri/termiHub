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
  EditorSessionRef,
  ConnectionEditorMeta,
  TunnelEditorMeta,
  WorkspaceEditorMeta,
  EditorStatus,
  EditorActions,
  NetworkDiagnosticMeta,
  NetworkTool,
  TabGroup,
  TerminalExitInfo,
  SessionCloseConfirmRequest,
} from "@/types/terminal";
import type { HttpMonitorState } from "@/types/network";
import {
  SavedConnection,
  ConnectionFolder,
  FileEntry,
  SftpStatus,
  SftpSessionEntry,
  TransferState,
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
  ShellIntegrationSettings,
  ShellIntegrationStatus,
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
  getSessionHistory,
  recordSession as apiRecordSession,
  setHistoryEntryPinned as apiSetHistoryEntryPinned,
  markHistoryEntryPromoted as apiMarkHistoryEntryPromoted,
  removeHistoryEntry as apiRemoveHistoryEntry,
  clearSessionHistory as apiClearSessionHistory,
} from "@/services/sessionHistoryApi";
import { SessionHistoryEntry } from "@/types/sessionHistory";
import { sessionHistoryTitle } from "@/utils/sessionHistoryTitle";
import {
  sftpOpen,
  sftpClose,
  sftpCancelTransfer,
  sftpListDir,
  sftpRealpath,
  sessionListFiles,
  localListDir,
  vscodeAvailable as checkVscode,
  sessionGetCapabilities,
  sessionMonitoringOpen,
  sessionMonitoringClose,
  sessionMonitoringSetPaused,
  sessionMonitoringSetInterval,
  sessionMonitoringCancel,
  listAvailableShells,
  getDefaultShell,
  connectAgent as apiConnectAgent,
  disconnectAgent as apiDisconnectAgent,
  shutdownAgent as apiShutdownAgent,
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
  saveShellIntegrationSettings,
  localReadFile,
  listSerialPorts,
  openWindow,
  sendHandoffToWindow,
  claimSession,
  releaseSession,
  takePendingHandoffs,
  reportWindowLayout,
  collectWindowLayouts,
  takePendingWindowRestore,
} from "@/services/api";
import type {
  MoveWindowTarget,
  TabHandoffRecord,
  HandoffTab,
  WindowInfo,
  WindowCloseRequest,
  WindowRestorePayload,
} from "@/types/window";
import { MAIN_WINDOW_LABEL } from "@/types/window";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  stampWindowId,
  buildWindowsMeta,
  planWindowRestore,
  hasWindowDimension,
  assembleWindowedGroups,
} from "@/utils/windowPersistence";
import type { CapturedWindowLayout, WindowRestorePlanEntry } from "@/utils/windowPersistence";
import { classifyWindowCloseSessions, windowCloseWouldLoseData } from "@/utils/windowClose";
import type {
  ConnectionTypeInfo,
  ContainerSpawn,
  ShellSpawn,
  TransferProgress,
  TransferSnapshot,
} from "@/services/api";
import type { SpawnRequestPayload } from "@/services/events";
import {
  isTerminalTransferState,
  transferEntryFromProgress,
  transferEntryFromSeed,
  transferEntryFromSnapshot,
  type TransferEntry,
  type TransferSeed,
} from "@/types/transfer";
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
import {
  WorkspaceSummary,
  WorkspaceDefinition,
  type WorkspaceTabGroupDef,
  type WorkspaceWindowDef,
} from "@/types/workspace";
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
  filterSessionBySelection,
  resolveRestoreMode,
  summarizeLastSession,
  type RestorePrompt,
} from "@/utils/restoreMode";
import { probeRestoreTargets } from "@/utils/restoreReachability";
import { probeTargetReachable } from "@/services/networkApi";
import { Macro, MacroStep } from "@/types/macro";
import {
  listMacros as apiListMacros,
  saveMacro as apiSaveMacro,
  deleteMacro as apiDeleteMacro,
} from "@/services/macroApi";
import { parseMacroEnvelope, resolveImportCollisions } from "@/services/macroIo";
import {
  runMacroPlayback,
  getTerminalInputInjector,
  type MacroTimingMode,
  type MacroInjector,
  type MacroPlaybackHandle,
} from "@/services/macroPlayback";
import { Workflow } from "@/types/workflow";
import {
  listWorkflows as apiListWorkflows,
  saveWorkflow as apiSaveWorkflow,
  deleteWorkflow as apiDeleteWorkflow,
} from "@/services/workflowApi";
import {
  parseWorkflowEnvelope,
  resolveImportCollisions as resolveWorkflowImportCollisions,
  summarizeLocalProcessSteps,
  type WorkflowImportResult,
} from "@/services/workflowIo";
import {
  runWorkflow as runWorkflowSteps,
  type WorkflowSendSeam,
  type WorkflowRunMacroSeam,
  type WorkflowRunHandle,
  type WorkflowAuthorizeLocalProcessSeam,
  type WorkflowRunLocalProcessSeam,
} from "@/services/workflowRunner";
import { dispatchOnConnectTriggers } from "@/services/workflowTriggers";
import {
  invokeRunLocalProcess,
  cancelLocalProcess,
  subscribeLocalProcessOutput,
} from "@/services/localProcessApi";
import {
  saveLastSession as apiSaveLastSession,
  loadLastSession as apiLoadLastSession,
  clearLastSession as apiClearLastSession,
} from "@/services/lastSessionApi";
import { resolveConnectionCredential } from "@/utils/resolveConnectionCredential";
import {
  connectTimeoutMessage,
  connectTimeoutMs,
  type ConnectTimeoutKind,
} from "@/utils/connectTimeout";
import { DEFAULT_MONITORING_INTERVAL_MS, MonitoringEntry, SystemStats } from "@/types/monitoring";
import {
  onSessionMonitoringStats,
  onSessionMonitoringStatus,
  onPersistentSessionStateChanged,
} from "@/services/events";
import { applyTheme, onThemeChange } from "@/themes";
import { setOverrides as setKeybindingOverrides } from "@/services/keybindings";
import {
  registerAdditionalLanguagePackages,
  registerCustomGrammars,
} from "@/utils/monacoCustomLanguages";
import { frontendLog } from "@/utils/frontendLog";
import { quotePath } from "@/utils/quotePath";
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
  | "macros"
  | "workflows"
  | "network-tools"
  | "recent-sessions";

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
 * Optional settings for {@link AppState.addTab}. Every field is optional — omit
 * the whole object (or any individual field) to accept the documented defaults.
 * Collapsing these trailing flags into one object keeps call sites from having
 * to thread placeholder `undefined`s to reach a later argument (#1467).
 */
export interface AddTabOptions {
  /** Panel to add the tab to. Defaults to the active panel (or first leaf). */
  panelId?: string;
  /** Tab content kind. Defaults to `"terminal"`. */
  contentType?: TabContentType;
  /** Per-tab terminal appearance/behavior overrides. */
  terminalOptions?: TerminalOptions;
  /** Pre-existing backend session id to attach to. Defaults to `null`. */
  sessionId?: string | null;
  /** Persistent-connection id this tab is attached to, if any. */
  persistentConnectionId?: string;
  /**
   * Saved-connection id this tab is opened from, if any. Threaded onto the tab
   * so the on-connect workflow trigger (#1855) can match the freshly opened
   * session back to its connection.
   */
  connectionId?: string;
  /**
   * Marks the tab as an externally spawned session with no saved connection
   * (#1446). Defaults to `false`.
   */
  spawned?: boolean;
  /**
   * Command to send after the terminal session connects (via `send_input`).
   * Used by an SSH spawn to `cd` into the target directory, since SSH cannot
   * set a start cwd at spawn (#1511).
   */
  initialCommand?: string;
}

/** Return a new Record with `key` removed. */
function omitKey<V>(rec: Record<string, V>, key: string): Record<string, V> {
  const { [key]: _, ...rest } = rec;
  return rest;
}

/**
 * A per-tab wall-clock deadline for a timed pre-connect state. Stored so the
 * connect/waiting timeout survives an overlay remount (tab drag, split re-key):
 * the deadline is set once on entry and the overlay only reads it, so
 * unmounting/remounting the overlay can never restart the countdown (#1263).
 */
type ConnectDeadline = { kind: ConnectTimeoutKind; at: number };

/**
 * Arm the connect deadline for `tabId`, idempotently: if a deadline for the
 * same kind already exists it is kept (so re-entering the state — or the
 * overlay remounting and the effect re-running — does not push the deadline
 * out). A different kind (connecting -> waiting-for-agent) arms a fresh one.
 */
function armConnectDeadline(
  deadlines: Record<string, ConnectDeadline>,
  tabId: string,
  kind: ConnectTimeoutKind
): Record<string, ConnectDeadline> {
  const current = deadlines[tabId];
  if (current && current.kind === kind) return deadlines;
  return { ...deadlines, [tabId]: { kind, at: Date.now() + connectTimeoutMs(kind) } };
}

/**
 * Failed-state message shown when the user aborts an in-flight connect from the
 * connecting / waiting / auto-retry overlay. The tab stays open on a retryable
 * Failed state rather than closing (#1128).
 */
export const ABORTED_CONNECT_MESSAGE = "Connection aborted.";

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

/** Config keys that hold secrets and must never be written to session history. */
const HISTORY_SECRET_KEYS = ["password", "passphrase", "keyPassphrase"];

/**
 * Return a copy of a connection config with all secret fields removed, for
 * safe storage in the session history (which never holds credentials).
 */
function stripHistorySecrets(config: ConnectionConfig): ConnectionConfig {
  const inner = { ...(config.config as Record<string, unknown>) };
  for (const key of HISTORY_SECRET_KEYS) {
    delete inner[key];
  }
  return { type: config.type, config: inner };
}

/**
 * A staged/available update reported by a connected agent via its
 * `agent.update_available` notification (#1352). Recorded per agent id so the
 * deferred-update banner can offer "Apply Now".
 */
export interface AgentPendingUpdate {
  currentVersion: string;
  availableVersion: string;
  /** `true` when a verified new binary is staged and ready to apply/defer. */
  staged: boolean;
}

/**
 * A coordinated update in progress on an agent, initiated by *another* host
 * (#1602). Recorded per agent id from the `agent.update_pending` notification so
 * the "being updated by another host" notice can show restart progress while the
 * connection is suspended and a reconnect is queued.
 */
export interface AgentUpdatePending {
  /** Version of the desktop that requested the update (`"unknown"` if unread). */
  requestedByVersion: string;
  /** The agent's estimate of how long it will be unavailable, in seconds. */
  estimatedRestartSecs: number;
  /** `Date.now()` when the notice arrived — drives the restart progress bar. */
  since: number;
}

/**
 * Extra seconds added to the agent's own restart estimate before the queued
 * auto-reconnect fires (#1602). The agent only begins its restart once every
 * host has disconnected (or a 10 s window closes), so reconnecting exactly at
 * the estimate would race the process still coming up; a small buffer avoids a
 * wasted failing attempt.
 */
const AGENT_UPDATE_RECONNECT_BUFFER_SECS = 3;

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
  /**
   * Open a new tab and make it active.
   * @param title Tab title.
   * @param connectionType Connection type key (e.g. `"local"`, `"ssh"`, `"remote-session"`).
   * @param config Connection config; defaults to a local shell when omitted.
   * @param options Optional tab settings — see {@link AddTabOptions}.
   * @returns The id of the created tab.
   */
  addTab: (
    title: string,
    connectionType: string,
    config?: ConnectionConfig,
    options?: AddTabOptions
  ) => string;
  /**
   * Open a Docker session tab for a resolved external container spawn (#1446).
   * Reuses the standard {@link addTab} open path with the spawn's Docker
   * settings + tab title and marks the tab `spawned` (no saved connection id).
   * Returns the created tab id.
   */
  openSpawnedContainer: (spawn: ContainerSpawn) => string;
  /**
   * Open a session tab for a resolved external local/WSL/SSH spawn (#1365 local,
   * #1511 WSL/SSH). Branches on the spawn's `type`: a `local` shell or `wsl`
   * distribution opens at the resolved `startingDirectory`; an `ssh` saved
   * connection opens and `cd`s into `cdPath` after connect (via the tab's
   * `initialCommand`). Reuses the standard {@link addTab} open path and marks the
   * tab `spawned` (no saved connection id). Returns the created tab id.
   */
  openSpawnedShell: (spawn: ShellSpawn) => string;

  // Session Picker (SI-3, #1366)
  /**
   * Whether the interactive Session Picker is showing. Raised by a `--pick`
   * spawn arriving on `spawn-picker-requested`, which defers the decision to the
   * user instead of opening a session outright.
   */
  spawnPickerVisible: boolean;
  /**
   * The request the visible picker is deciding, or `undefined` when it is
   * closed. Carries the `location` the picker shows in its header, plus the
   * `entry_id` / `new_window` context the confirmed choice inherits.
   */
  spawnPickerRequest: SpawnRequestPayload | undefined;
  /** Show the Session Picker for `request`, replacing any request it was showing. */
  showSpawnPicker: (request: SpawnRequestPayload) => void;
  /** Close the Session Picker and drop the request it was deciding. */
  hideSpawnPicker: () => void;

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
  /**
   * Open (or focus) an editor tab for a file.
   *
   * A remote tab is backed by exactly one transport: pass `sftpSessionId` for
   * the legacy SFTP path (SSH), or `sessionBrowser` for the protocol-agnostic
   * session layer (FTP, Docker, agent sessions — #1557).
   */
  openEditorTab: (
    filePath: string,
    isRemote: boolean,
    sftpSessionId?: string,
    permissions?: string | null,
    sessionBrowser?: EditorSessionRef
  ) => void;
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
  /**
   * Confirmation request shown before tearing down a live session by closing a
   * tab (X / middle-click) or a split panel, while
   * `settings.confirmCloseLiveSession` is enabled. Null when no dialog is open.
   * The `tab` variant carries an optional `reopen` payload so the follow-up
   * toast can offer an Undo/Reopen affordance when the connection is known.
   */
  pendingSessionCloseConfirm: SessionCloseConfirmRequest | null;
  setPendingSessionCloseConfirm: (req: SessionCloseConfirmRequest | null) => void;
  /**
   * One-time notice shown when the user closes a tab attached to a persistent
   * background session, while `settings.confirmCloseAttachedTab` is enabled.
   * Closing such a tab only detaches it — the session keeps running — so the
   * notice reassures the user rather than warning of data loss. Null when no
   * dialog is open.
   */
  pendingAttachedTabCloseConfirm: { tabId: string; panelId: string; label: string } | null;
  setPendingAttachedTabCloseConfirm: (
    req: { tabId: string; panelId: string; label: string } | null
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
  /** Clear a tab's one-shot scrollback-replay flag after a re-parent (#1900). */
  clearPendingScrollbackReplay: (tabId: string) => void;

  // ── Multi-window foundation (#1900) ──
  /**
   * Session ids currently being re-parented to another window. While a session
   * is in this set, the source window's {@link Terminal} must NOT close the
   * backend session on unmount — the destination window is adopting it. The flag
   * is consumed once by the source's deferred close.
   */
  movingSessionIds: string[];
  /** Whether a session is mid-move (read by the source Terminal's unmount cleanup). */
  isSessionMoving: (sessionId: string) => boolean;
  /** Clear a session's moving flag once the source has released its view. */
  clearMovingSession: (sessionId: string) => void;
  /**
   * Re-parent a session-bearing tab into another window (a brand-new window or
   * an existing one). The backend session keeps running; the source view is
   * disposed and the destination re-attaches with scrollback replay. This is the
   * store seam the "Move to Window" UI (#1901) builds on.
   */
  moveTabToWindow: (tabId: string, fromPanelId: string, target: MoveWindowTarget) => Promise<void>;
  /**
   * Hydrate a handed-off tab into this window's active group (destination side).
   * The tab re-attaches to its live backend session and replays scrollback.
   */
  hydrateHandoffTab: (record: TabHandoffRecord) => void;
  /** Drain and hydrate any hand-off records queued for this window. */
  receivePendingHandoffs: () => Promise<void>;
  /**
   * Drain and hydrate the tab groups a restore-spawned secondary window was
   * seeded with (#1925). A no-op for a window not spawned by a multi-window
   * restore. Rebuilds this window's layout from the saved groups just as the
   * main window rebuilds its own in {@link restoreLastSession}.
   */
  receivePendingWindowRestore: () => Promise<void>;
  /**
   * Report this (secondary) window's captured layout slice to the backend
   * aggregation authority (#1925) so the main window can persist a document that
   * spans every window. Debounced via {@link scheduleWindowLayoutReport}.
   */
  reportOwnWindowLayout: () => Promise<void>;
  /** Debounced trigger for {@link reportOwnWindowLayout} on a layout change. */
  scheduleWindowLayoutReport: () => void;
  /**
   * Open a brand-new, empty native window (no hand-off) — the top-level "New
   * Window" command (#1902). The window boots into the empty-window CTA state.
   * Failures are surfaced as a recoverable toast rather than thrown.
   */
  openNewWindow: () => Promise<void>;

  /**
   * Pending close-with-live-tabs decision (#1903). Non-null while the
   * detach-vs-terminate dialog is open for this window; set by
   * {@link prepareWindowClose} and cleared when the dialog resolves.
   */
  pendingWindowClose: WindowCloseRequest | null;
  /** Set or clear the pending close-with-live-tabs decision (#1903). */
  setPendingWindowClose: (request: WindowCloseRequest | null) => void;
  /**
   * Assess this window's owned live sessions when the OS requests its close
   * (#1903) and pick the next step:
   *
   * - `"proceed"` — nothing would be lost: the window is empty, or every live
   *   session is persistent/agent and is detached here (kept running) with a
   *   toast. The caller may destroy the window.
   * - `"prompt"` — at least one non-persistent session would be terminated, so
   *   the decision dialog is raised ({@link pendingWindowClose}); the caller
   *   must NOT destroy the window — the dialog resolves it.
   */
  prepareWindowClose: (otherWindows: WindowInfo[]) => Promise<"proceed" | "prompt">;
  /**
   * Destructive close outcome (#1903): detach every persistent/agent session
   * and terminate every non-persistent one owned by this window.
   */
  endWindowSessions: () => Promise<void>;
  /**
   * Safe close outcome (#1903): re-parent every owned live session tab into
   * another window so nothing is lost, reusing the #1900 hand-off seam.
   */
  moveWindowSessionsToWindow: (target: MoveWindowTarget) => Promise<void>;

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

  // Command palette (Cmd/Ctrl+P) — fuzzy-find commands + saved connections
  commandPaletteOpen: boolean;
  setCommandPaletteOpen: (open: boolean) => void;

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

  /**
   * Per-session temporary syntax-highlighting toggle (runtime-only, never
   * persisted). Keyed by session id. Set by the status-bar quick toggle
   * (epic #1696, child #1704) to override the resolved config for a single
   * live session without touching saved settings. A missing entry means
   * "follow the resolved config"; `setSessionHighlighting(id, undefined)`
   * clears the override back to that state.
   */
  sessionHighlighting: Record<string, boolean>;
  setSessionHighlighting: (sessionId: string, enabled: boolean | undefined) => void;

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
  /**
   * Re-fetch the connection-type registry from the backend and replace
   * {@link connectionTypes}. The registry embeds backend-detected data such as
   * the local shell field's option list, so refreshing it lets a just-installed
   * shell (e.g. guided Git Bash, #1692) become selectable without an app
   * restart. A backend failure leaves the current registry untouched.
   */
  refreshConnectionTypes: () => Promise<void>;
  updateSettings: (settings: AppSettings) => Promise<void>;
  /**
   * Persist edited shell-integration settings through the dedicated
   * `save_shell_integration_settings` command, keeping `settings` and
   * `savedSettings` in lockstep (as {@link updateSettings} does for general
   * settings). Optimistically writes `nextSi` into both, then on backend
   * failure rolls both back to the previously-persisted shell-integration value
   * and re-throws so the caller can surface the error. Resolves with the
   * refreshed {@link ShellIntegrationStatus} reporting the recomputed
   * registration / staleness state.
   */
  updateShellIntegration: (nextSi: ShellIntegrationSettings) => Promise<ShellIntegrationStatus>;
  reloadExternalConnections: () => Promise<void>;
  /** Reload connections from the backend using the versioned reload guard. */
  reloadConnectionsFromBackend: () => void;
  toggleFolder: (folderId: string) => void;
  addConnection: (connection: SavedConnection) => void;
  bulkAddConnections: (connections: SavedConnection[]) => void;

  // --- Session history (#1883) ---
  /** Recorded session history, ordered pinned-first then most-recently-used. */
  sessionHistory: SessionHistoryEntry[];
  /** Load session history from the backend. */
  loadSessionHistory: () => Promise<void>;
  /**
   * Record a session open in history (deduplicated + evicted in the backend).
   * A no-op when `sessionHistoryEnabled` is off. Failures are logged, not thrown.
   */
  recordSession: (connectionType: string, config: ConnectionConfig) => Promise<void>;
  /** Pin or unpin a history entry. */
  pinHistoryEntry: (dedupKey: string, pinned: boolean) => Promise<void>;
  /** Mark a history entry as promoted to a saved connection. */
  markHistoryPromoted: (dedupKey: string) => Promise<void>;
  /** Remove a single history entry. */
  removeHistoryEntry: (dedupKey: string) => Promise<void>;
  /** Clear all session history. */
  clearSessionHistory: () => Promise<void>;
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
  /**
   * Host label (`user@host:port`) of the session the browser is currently
   * viewing. Derived from `sftpSessions[sftpSessionId]`; kept as its own field
   * so the file browser and status UI can read the active host cheaply.
   */
  sftpConnectedHost: string | null;
  /**
   * Every live backend SFTP session, keyed by its session-id / UUID (Decision 1
   * of the sftp-session-and-transfers concept, issue #1241). `hostLabel` is
   * display metadata; `owningTabId` binds the session to the tab that opened it
   * so it can be closed when that tab closes (the L1 leak fix). `sftpSessionId`
   * above is the derived "active" pointer into this map for the current browser.
   */
  sftpSessions: Record<string, SftpSessionEntry>;
  /**
   * The last config passed to `connectSftp`, retained so a failed connect can be
   * retried (audit gap S1). Cleared on `disconnectSftp`.
   */
  sftpLastConfig: Record<string, unknown> | null;
  setCurrentPath: (path: string) => void;
  setFileEntries: (entries: FileEntry[]) => void;
  connectSftp: (config: Record<string, unknown>, owningTabId?: string) => Promise<void>;
  disconnectSftp: () => Promise<void>;
  navigateSftp: (path: string) => Promise<void>;
  refreshSftp: () => Promise<void>;
  /** Re-invoke `connectSftp` with the persisted last config (audit gap S1). */
  retrySftp: () => Promise<void>;
  /** Clear the SFTP error so the failed-connect placeholder resets (audit gap S1). */
  dismissSftpError: () => void;
  /**
   * Close a single tracked SFTP session (`sftp_close`) and drop it from
   * `sftpSessions`. When it is the active browser session, the browser is reset
   * to idle. Drives the per-session Kill in the Open Connections panel (#1241).
   */
  closeSftpSession: (sessionId: string) => Promise<void>;

  /**
   * Live in-flight SFTP transfers keyed by `transferId` (concept "SFTP session
   * tracking + transfers", issue #1247). Fed purely by `transfer-progress`
   * events (#1245) through {@link applyTransferProgress}; a terminal phase
   * clears the row. Rendered as the Open Connections "Transfers" section, the
   * file-browser footer, and the status-bar aggregate.
   */
  transfers: Record<string, TransferState>;
  /**
   * Apply a `transfer-progress` event to the {@link transfers} map: a
   * `transferring` phase upserts the row; a terminal phase
   * (`done`/`cancelled`/`error`) removes it (D2 done/error toasts are handled
   * separately).
   */
  applyTransferProgress: (progress: TransferState) => void;
  /** Request cancellation of an in-flight transfer (`sftp_cancel_transfer`). */
  cancelTransfer: (transferId: string) => Promise<void>;

  /**
   * Transfer Queue panel rows keyed by `transferId` (Transfer Queue panel,
   * Epic #1331 / #1337). Unlike {@link transfers} (which clears terminal rows),
   * this queue **retains** completed/failed/cancelled rows until the user clears
   * or removes them, so the panel can offer Retry / Remove / Clear Completed.
   * Fed by the same `transfer-progress` event via
   * {@link applyTransferProgressToQueue}.
   */
  transferQueue: Record<string, TransferEntry>;
  /** Whether the Transfer Queue panel is collapsed to its status-bar indicator. */
  transferQueueMinimized: boolean;
  /** Insert (or replace) a queue row keyed by its id. */
  addTransfer: (entry: TransferEntry) => void;
  /** Merge a partial patch into an existing queue row (no-op for unknown ids). */
  updateTransfer: (id: string, patch: Partial<TransferEntry>) => void;
  /** Remove a single queue row (per-row Remove control). */
  removeTransfer: (id: string) => void;
  /** Remove every `completed` row (footer Clear Completed); failed/cancelled stay. */
  clearCompleted: () => void;
  /** Collapse/expand the panel to/from its status-bar indicator. */
  setTransferQueueMinimized: (minimized: boolean) => void;
  /** Fold a `transfer-progress` event into the queue (upsert, retaining terminal rows). */
  applyTransferProgressToQueue: (progress: TransferProgress) => void;
  /**
   * Seed a `queued` queue row from a transfer's registration snapshot (#1632),
   * so the panel opens without waiting for a `transfer-progress` event that may
   * be dropped/delayed under memory pressure. Idempotent: a no-op when a row for
   * the id already exists, so it never clobbers a further-along event-fed row.
   */
  seedTransferQueue: (seed: TransferSeed) => void;
  /**
   * Reconcile the queue against a backend `transfer_list` snapshot (#1645), the
   * backstop for a dropped *terminal* `transfer-progress` event. Settles any
   * still-open row whose backend snapshot reports a terminal state to that
   * state. Idempotent and conservative: it never resurrects a removed row,
   * never clobbers an already-terminal row, and never moves a live (active)
   * row — event delivery owns live progress; this only settles stuck rows.
   */
  reconcileTransferQueue: (snapshots: TransferSnapshot[]) => void;

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
  /**
   * Per-tab wall-clock deadline (epoch ms + kind) for the active timed
   * pre-connect state. Set on entry to `Connecting` / `WaitingForAgent` and
   * cleared on every exit; the overlay reads it so the timeout survives a
   * remount instead of restarting the countdown (#1263).
   */
  terminalConnectDeadline: Record<string, ConnectDeadline>;
  setTerminalSpawnError: (tabId: string, error: string | null) => void;
  retryTerminalSpawn: (tabId: string) => void;
  setTerminalConnecting: (tabId: string, connecting: boolean) => void;
  /** Auto-retry attempt count for agent sessions (> 0 = actively auto-retrying). */
  terminalAutoRetryCount: Record<string, number>;
  /** Tab is parked waiting for its parent agent to connect; value = agentId. */
  terminalWaitingForAgent: Record<string, string>;
  setTerminalAutoRetrying: (tabId: string, count: number) => void;
  setTerminalWaitingForAgent: (tabId: string, agentId: string | null) => void;
  /**
   * Client-side timeout for a pre-connect state. Transitions the tab to Failed
   * with a contextual hint, but only if it is still in the given state — a
   * stale timer that fires after the tab connected or was woken is a no-op.
   */
  failTerminalConnectTimeout: (tabId: string, kind: ConnectTimeoutKind) => void;
  /**
   * User-initiated abort of an in-flight connect (from the connecting, waiting,
   * or auto-retry overlay). Transitions the tab to a retryable Failed state and
   * keeps the tab open — distinct from Cancel, which closes the tab (#1128).
   */
  abortTerminalConnect: (tabId: string) => void;

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

  /**
   * Aggregate feedback for a fan-out restore/launch (#1146, audit G4). When a
   * restore or workspace launch places N tabs, each reconnects independently
   * inside its own Terminal.tsx mount, so failures are otherwise only visible
   * per-tab. This cohort tracks the set of tab ids placed by one restore/launch
   * and settles them as each connects ({@link setTabSessionId}) or fails
   * ({@link setTerminalDisconnectWithError}); when the last one settles a single
   * summary toast is raised. `null` when no restore/launch is in flight.
   *
   * `failedTabIds` is the subset of settled tabs that failed and can be
   * re-driven through the per-tab reconnect path — it feeds the bulk
   * "Reconnect failed tabs" control (#1227). `toastId`, when present, is the
   * id of a pending toast this cohort should resolve in place on settle
   * (used by {@link reconnectFailedRestoreTabs} for pending → result feedback).
   */
  restoreCohort: {
    pending: Set<string>;
    total: number;
    failed: number;
    failedTabIds: Set<string>;
    toastId?: string | number;
  } | null;
  /**
   * The failed terminal tab ids captured from the most recently settled
   * restore/launch (or bulk-reconnect) cohort. Drives the bulk "Reconnect
   * failed tabs" control (#1227, audit M2); empty when there is nothing to
   * retry. Consumed (cleared) by {@link reconnectFailedRestoreTabs}.
   */
  failedRestoreTabIds: string[];
  /**
   * Register the cohort of tabs placed by a restore/launch. `pendingTabIds` are
   * the live terminal tabs that will attempt to connect; `preFailedCount` counts
   * tabs already known to have failed at build time (e.g. agent-error tabs that
   * never emit a connect/fail signal). `toastId`, when given, is a pending toast
   * the settle should resolve in place instead of raising a fresh one. If
   * nothing is pending, the summary is raised immediately.
   */
  beginRestoreCohort: (
    pendingTabIds: string[],
    preFailedCount: number,
    toastId?: string | number
  ) => void;
  /** Settle one tab of the active restore cohort; raises the summary once the cohort empties. */
  settleRestoreTab: (tabId: string, outcome: "connected" | "failed") => void;
  /** Raise the single aggregate summary toast for the settled cohort and clear it. Internal. */
  settleRestoreCohort: () => void;
  /**
   * Bulk-retry every failed tab remembered from the last partial restore
   * ({@link failedRestoreTabIds}) in one action (#1227, audit M2). Re-drives
   * only those tabs through the existing per-tab {@link reconnectTerminal}
   * path, registers a fresh cohort so the outcome re-summarizes, and shows a
   * pending toast that resolves into the aggregate result.
   */
  reconnectFailedRestoreTabs: () => void;
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
  /** Staged/available agent updates by agent id, from `agent.update_available` (#1352). */
  agentUpdates: Record<string, AgentPendingUpdate>;
  /** Per-agent dismissal of the deferred-update banner (#1352). */
  agentUpdatesDismissed: Record<string, boolean>;
  /** Record (or clear) a staged/available update for an agent. */
  setAgentUpdateAvailable: (agentId: string, update: AgentPendingUpdate) => void;
  /** Hide the deferred-update banner for an agent for this session. */
  dismissAgentUpdate: (agentId: string) => void;
  /**
   * Coordinated updates in progress on an agent, initiated by another host,
   * from `agent.update_pending` (#1602). Keyed by agent id.
   */
  agentUpdatePending: Record<string, AgentUpdatePending>;
  /**
   * Handle an incoming `agent.update_pending` (#1602): record the notice,
   * suspend the affected agent connection (the disconnect *is* the ack the
   * updating host waits for), and queue an auto-reconnect to the new version
   * once the agent's restart window has elapsed. Sessions survive in detached
   * daemons and are recovered on reconnect, so only the connection is suspended.
   */
  handleAgentUpdatePending: (
    agentId: string,
    requestedByVersion: string,
    estimatedRestartSecs: number
  ) => void;
  /** Clear a recorded coordinated-update-pending notice for an agent. */
  clearAgentUpdatePending: (agentId: string) => void;
  addRemoteAgent: (agent: RemoteAgentDefinition) => void;
  updateRemoteAgent: (agent: RemoteAgentDefinition) => void;
  deleteRemoteAgent: (agentId: string) => void;
  reorderRemoteAgents: (oldIndex: number, newIndex: number) => void;
  toggleRemoteAgent: (agentId: string) => void;
  connectRemoteAgent: (agentId: string, password?: string) => Promise<void>;
  disconnectRemoteAgent: (agentId: string) => Promise<void>;
  /**
   * Gracefully shut down a remote agent (stop remote sessions) and disconnect.
   * Resolves to the number of sessions the agent reported as detached/killed.
   */
  shutdownRemoteAgent: (agentId: string) => Promise<number>;
  setAgentConnectionState: (
    agentId: string,
    state: RemoteAgentDefinition["connectionState"],
    error?: string
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
  /**
   * Per-host/session monitoring state, keyed by {@link MonitoringEntry.key}
   * (audit gap G6, #1231). Replaces the former global singleton so multiple
   * hosts can be monitored at once: the status bar renders the active tab's
   * entry (see {@link selectActiveMonitor}) while Open Connections iterates
   * every entry.
   */
  monitors: Record<string, MonitoringEntry>;
  /** Last-known stats per MonitorKey, persisted across tab switches for instant display on reconnect. */
  monitoringStatsCache: Record<string, SystemStats>;
  /**
   * Subscribe the terminal session `sessionId` to its `MonitoringProvider` push
   * path, keying the entry by `sessionId`. `host` is the human-readable label
   * shown in the status bar. All monitors — desktop-direct SSH and
   * remote-session alike — flow through this single path (#1232).
   */
  connectMonitoring: (sessionId: string, host?: string | null) => Promise<void>;
  /** Disconnect one monitor by key, or every monitor when `key` is omitted. */
  disconnectMonitoring: (key?: string) => Promise<void>;
  /** Clear a lingering error on one entry so a stale tooltip cannot persist (audit gap G9). */
  clearMonitoringError: (key: string) => void;
  /**
   * Pause or resume one monitor (#1233). Signals the backend session monitoring
   * loop to stop/resume collecting; the transport stays open either way.
   */
  setMonitoringPaused: (key: string, paused: boolean) => Promise<void>;
  /**
   * Change one monitor's refresh interval in milliseconds (#1233), reconfiguring
   * the backend session monitoring loop cadence.
   */
  setMonitoringInterval: (key: string, intervalMs: number) => Promise<void>;
  /**
   * Cancel a monitor that is still connecting (#1233). Aborts the backend connect
   * and tears the entry down so the picker/Retry is reachable again.
   */
  cancelMonitoring: (key: string) => Promise<void>;
  /** Per-session capabilities fetched after session creation (keyed by sessionId). */
  sessionCapabilities: Record<string, { monitoring: boolean; fileBrowser: boolean }>;
  setSessionCapabilities: (
    sessionId: string,
    caps: { monitoring: boolean; fileBrowser: boolean }
  ) => void;

  /**
   * Live framebuffer resolution of each active graphical remote-desktop session,
   * keyed by session id (#1709). Fed from the `remote-desktop-frame` /
   * `onDimensions` path so the shared status-bar segment can show `WxH` for the
   * active tab. Cleared when the session ends.
   */
  remoteDesktopResolutions: Record<string, { width: number; height: number }>;
  setRemoteDesktopResolution: (sessionId: string, width: number, height: number) => void;
  clearRemoteDesktopResolution: (sessionId: string) => void;

  // SSH Tunnels
  tunnels: TunnelConfig[];
  tunnelStates: Record<string, TunnelState>;
  loadTunnels: () => Promise<void>;
  saveTunnel: (config: TunnelConfig) => Promise<void>;
  deleteTunnel: (tunnelId: string) => Promise<void>;
  startTunnel: (tunnelId: string) => Promise<void>;
  stopTunnel: (tunnelId: string) => Promise<void>;
  /** Force-reconnect a connected tunnel (stop + start), for a stale-but-green tunnel (#1243). */
  reconnectTunnel: (tunnelId: string) => Promise<void>;
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

  // Macros
  macros: Macro[];
  loadMacros: () => Promise<void>;
  /** Save (add or update) a macro, then refresh the list. Returns the stored macro. */
  saveMacroToBackend: (macro: Macro) => Promise<Macro>;
  /** Delete a macro by ID; only mutates local state after the backend delete resolves. */
  deleteMacroFromBackend: (macroId: string) => Promise<void>;
  /**
   * Import macros from an exported-macro file's JSON, merging them into the
   * library. Malformed/incompatible files reject with a clear error and leave
   * the library untouched; imported macros get fresh ids and de-duplicated
   * names (see {@link resolveImportCollisions}). Returns the number imported.
   */
  importMacros: (json: string) => Promise<number>;

  // Macro recording (#1674)
  /** Whether terminal input is currently being captured into a macro. */
  macroRecording: boolean;
  /** The steps captured so far in the in-progress (or just-stopped) recording. */
  macroRecordingSteps: MacroStep[];
  /**
   * Timestamp (ms) of the last captured chunk, used to derive the next step's
   * `delayMs`. Internal to the recorder; `null` before the first chunk.
   */
  macroRecordingLastTime: number | null;
  /** Whether the post-recording "name & save" dialog is open. */
  macroSaveDialogOpen: boolean;
  /** Begin a fresh recording, discarding any prior buffer. */
  startMacroRecording: () => void;
  /**
   * Append one chunk of user input to the in-progress recording. No-op unless a
   * recording is active. `delayMs` is the elapsed time since the previous chunk
   * (0 for the first).
   */
  recordMacroInput: (data: string) => void;
  /**
   * Stop capturing. If anything was recorded, opens the save dialog; otherwise
   * discards the empty recording and notifies the user.
   */
  stopMacroRecording: () => void;
  /** Toggle recording: start if idle, stop (and prompt to save) if active. */
  toggleMacroRecording: () => void;
  /** Abort recording and discard the captured buffer without saving. */
  cancelMacroRecording: () => void;
  /** Persist the just-recorded steps as a named macro, then reset the recorder. */
  saveRecordedMacro: (meta: {
    name: string;
    description?: string;
    tags: string[];
  }) => Promise<void>;
  /** Close the save dialog and drop the captured buffer without persisting. */
  discardRecordedMacro: () => void;

  // Macro playback (#1675)
  /** Metadata for the in-flight playback, or `null` when nothing is playing. */
  macroPlayback: MacroPlaybackState | null;
  /**
   * Play a stored macro's recorded input into a target terminal, injecting each
   * step through the existing `send_input` seam and honouring the timing mode.
   * Defaults the target to the active terminal tab. Resolves when playback
   * finishes (completed, cancelled, or errored). Only one playback runs at a
   * time — a fresh call cancels any in-flight playback first. Surfaces a
   * recoverable toast when the macro is missing/empty or the target terminal is
   * not connected.
   */
  playMacro: (macroId: string, opts?: PlayMacroOptions) => Promise<void>;
  /** Cancel the in-flight macro playback, if any. Idempotent. */
  cancelMacroPlayback: () => void;

  // Workflows (#1852) — the foundation of the Workflow Automation epic (#1851).
  /** All stored workflows. */
  workflows: Workflow[];
  /** Load the workflow library from the backend into the store. */
  loadWorkflows: () => Promise<void>;
  /** Save (add or update) a workflow, then refresh the list. Returns the stored workflow. */
  saveWorkflowToBackend: (workflow: Workflow) => Promise<Workflow>;
  /** Delete a workflow by ID; only mutates local state after the backend delete resolves. */
  deleteWorkflowFromBackend: (workflowId: string) => Promise<void>;
  /**
   * Import workflows from an exported-workflow file's JSON, merging them into the
   * library. Malformed/incompatible files reject with a clear error and leave
   * the library untouched; imported workflows get fresh ids and de-duplicated
   * names. Returns a {@link WorkflowImportResult} that also flags how many
   * imported workflows carry a (guarded, never auto-authorized) `run-local-process`
   * step so the caller can surface a security warning.
   */
  importWorkflows: (json: string) => Promise<WorkflowImportResult>;
  /** Metadata for the in-flight workflow run, or `null` when nothing is running. */
  workflowRun: WorkflowRunState | null;
  /**
   * Run a stored workflow's steps against a target terminal, dispatching each
   * step through the shared `send_input` seam and surfacing live progress.
   * Defaults the target to the active terminal tab. Only one run happens at a
   * time — a fresh call cancels any in-flight run first. Surfaces a recoverable
   * toast when the workflow is missing/empty, the target terminal is not
   * connected, or a step fails.
   */
  runWorkflow: (workflowId: string, opts?: RunWorkflowOptions) => Promise<void>;
  /** Cancel the in-flight workflow run, if any. Idempotent. */
  cancelWorkflowRun: () => void;
  /**
   * Inline output surface for a `run-local-process` step (#1865): the streamed
   * stdout/stderr and the final exit outcome, kept visible after the run ends
   * until dismissed. `null` when no local process has run this session (or the
   * surface was dismissed).
   */
  workflowRunOutput: WorkflowRunOutputState | null;
  /** Dismiss the inline run-output surface. */
  dismissWorkflowRunOutput: () => void;
  /**
   * Pending authorization prompt for a guarded `run-local-process` step (#1857),
   * or `null` when none is open. Set when a workflow reaches such a step whose
   * program is not yet on the allowlist; resolved by the user via the dialog.
   */
  localProcessPrompt: LocalProcessPromptState | null;
  /** Resolve the open local-process authorization prompt with the user's choice. */
  resolveLocalProcessPrompt: (decision: LocalProcessAuthDecision) => void;

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
  /**
   * Restore the persisted last session into the live layout. Returns true if a
   * session was restored. When `selectedIndices` is given, only the tabs at
   * those flat indices (as produced by `summarizeLastSession`) are restored —
   * the partial-restore path from the restore dialog (#1931).
   */
  restoreLastSession: (selectedIndices?: readonly number[]) => Promise<boolean>;
  /** Clear the persisted last session (e.g. when restore-on-startup is disabled). */
  clearLastSession: () => Promise<void>;
  /**
   * Pending "restore previous session?" prompt for `ask` mode: a summary of the
   * stored last session shown by the {@link SessionRestoreDialog}. `null` when
   * no prompt is showing.
   */
  restorePrompt: RestorePrompt | null;
  /**
   * `ask`-mode startup step: peek the stored last session and, when it has
   * tabs, raise {@link restorePrompt} so the dialog can offer to restore. A
   * no-op when nothing is stored.
   */
  promptRestore: () => Promise<void>;
  /**
   * Resolve the restore prompt with "Restore": optionally persist
   * `restoreLastSessionMode: "always"` (when `remember`), then restore the
   * stored session. `selectedIndices` restricts the restore to the checked tabs
   * (#1931); omitting it restores every stored tab.
   */
  confirmRestorePrompt: (remember: boolean, selectedIndices?: readonly number[]) => Promise<void>;
  /**
   * Resolve the restore prompt with "Start Fresh": optionally persist
   * `restoreLastSessionMode: "never"` (when `remember`), then clear the stored
   * session.
   */
  dismissRestorePrompt: (remember: boolean) => Promise<void>;

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

/** UI-facing metadata describing an in-flight macro playback (#1675). */
export interface MacroPlaybackState {
  /** The macro being played. */
  macroId: string;
  /** The macro's name, for the progress indicator. */
  macroName: string;
  /** The terminal tab receiving the injected input. */
  tabId: string;
  /** The timing mode this run is using. */
  timingMode: MacroTimingMode;
  /** Total number of steps in the macro. */
  total: number;
  /** Steps injected so far. */
  played: number;
}

/** Options for {@link AppState.playMacro}. */
export interface PlayMacroOptions {
  /** Tab to inject into; defaults to the active terminal tab. */
  targetTabId?: string;
  /** Timing mode; defaults to `"real-time"`. */
  timingMode?: MacroTimingMode;
  /** Per-step delay (ms) for the `"fixed"` timing mode. */
  fixedDelayMs?: number;
}

/**
 * Handle for the currently-running macro playback, held at module scope so
 * {@link AppState.cancelMacroPlayback} can stop it without threading the handle
 * through store state (it is not serializable). `null` when nothing is playing.
 */
let activeMacroPlayback: MacroPlaybackHandle | null = null;

/** Generate a unique macro id, falling back when `crypto.randomUUID` is absent. */
function generateMacroId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") {
    return `macro-${c.randomUUID()}`;
  }
  return `macro-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/** UI-facing metadata describing an in-flight workflow run (#1852). */
export interface WorkflowRunState {
  /** The workflow being run. */
  workflowId: string;
  /** The workflow's name, for the progress indicator. */
  workflowName: string;
  /** The terminal tab the workflow is running against. */
  tabId: string;
  /** Total number of steps in the workflow. */
  total: number;
  /** Steps completed so far. */
  completed: number;
}

/** A single streamed line of a local process's output, tagged by its stream. */
export interface WorkflowRunOutputLine {
  /** Monotonic id within the current process, so React can key incremental appends. */
  id: number;
  /** Which stream produced the line. */
  stream: "stdout" | "stderr";
  /** The line of text (no trailing newline). */
  text: string;
}

/** Live status of the inline run-output surface (#1865). */
export type WorkflowRunOutputStatus = "running" | "completed" | "cancelled" | "failed";

/**
 * The inline run-output surface for a `run-local-process` step (#1865).
 *
 * Unlike {@link WorkflowRunState}, which is cleared the instant a run ends, this
 * persists after the run finishes so the streamed stdout/stderr and the final
 * exit outcome stay visible in the workflow panel until the user dismisses it or
 * starts another run. It is created lazily — only when a run actually spawns a
 * local process — so terminal-native workflows never surface an empty panel. It
 * reuses the exact `subscribeLocalProcessOutput` stream #1857 already emits; no
 * new backend channel is added.
 */
export interface WorkflowRunOutputState {
  /** The workflow whose local process produced this output. */
  workflowId: string;
  /** The workflow's name, for the panel header. */
  workflowName: string;
  /** The program the (most recent) `run-local-process` step spawned. */
  program: string;
  /** The discrete arguments it was spawned with. */
  args: string[];
  /** Streamed stdout/stderr lines, in arrival order. */
  lines: WorkflowRunOutputLine[];
  /** Live status: `running` until the run reaches a terminal state. */
  status: WorkflowRunOutputStatus;
  /** The process exit code once known (`null` when killed before it reported one). */
  exitCode: number | null;
  /** `true` when the process was killed for exceeding its timeout. */
  timedOut: boolean;
  /** A human-readable failure reason when `status` is `failed`. */
  error?: string;
}

/** Options for {@link AppState.runWorkflow}. */
export interface RunWorkflowOptions {
  /** Tab to run against; defaults to the active terminal tab. */
  targetTabId?: string;
}

/**
 * The user's choice at a local-process authorization prompt (#1857):
 * `"once"` allows this single run, `"always"` allows it and adds the program to
 * the persisted allowlist, `"cancel"` refuses (the step does not run).
 */
export type LocalProcessAuthDecision = "once" | "always" | "cancel";

/** State backing the open local-process authorization dialog (#1857). */
export interface LocalProcessPromptState {
  /** The program the step wants to spawn. */
  program: string;
  /** The discrete arguments it would be spawned with. */
  args: string[];
  /** The name of the workflow requesting it, for the prompt copy. */
  workflowName: string;
  /** Resolver wired to the pending authorization promise. */
  resolve: (decision: LocalProcessAuthDecision) => void;
}

/**
 * Default timeout (ms) applied to a `run-local-process` step from the frontend.
 * The backend clamps to its own hard cap regardless.
 */
const LOCAL_PROCESS_TIMEOUT_MS = 60_000;

/** How often (ms) a running local process polls the workflow cancel signal. */
const LOCAL_PROCESS_CANCEL_POLL_MS = 200;

/**
 * Cap on retained inline run-output lines (#1865). A chatty process can emit
 * thousands of lines; the surface keeps only the most recent so run state cannot
 * grow unbounded. The full stream still lands in the LogViewer.
 */
const WORKFLOW_RUN_OUTPUT_MAX_LINES = 1000;

/**
 * Handle for the currently-running workflow, held at module scope so
 * {@link AppState.cancelWorkflowRun} can stop it without threading the handle
 * through store state (it is not serializable). `null` when nothing is running.
 */
let activeWorkflowRun: WorkflowRunHandle | null = null;

/** Generate a unique workflow id, falling back when `crypto.randomUUID` is absent. */
function generateWorkflowId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") {
    return `workflow-${c.randomUUID()}`;
  }
  return `workflow-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

let layoutPersistTimer: ReturnType<typeof setTimeout> | null = null;
/** Debounce timer for auto-saving the last session on layout changes. */
let lastSessionPersistTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * The runtime label of the window this store belongs to (multi-window
 * persistence, #1905), used to stamp captured tab groups with their owning
 * window. Falls back to {@link MAIN_WINDOW_LABEL} when the Tauri window API is
 * unavailable (e.g. browser dev mode) so capture never throws.
 */
function currentWindowLabel(): string {
  try {
    return getCurrentWindow().label;
  } catch {
    return MAIN_WINDOW_LABEL;
  }
}

/**
 * Capture the full multi-window layout for persistence (#1925): refresh this
 * window's slice in the backend aggregation authority, pull every window's
 * reported slice, and assemble the windowId-stamped groups + `windows[]` set.
 *
 * Falls back to **this window's groups only** if the cross-window commands are
 * unavailable (e.g. browser dev mode, or an IPC error) so a save never throws —
 * a single-window app then produces the byte-identical legacy shape.
 */
async function captureAllWindows(
  ownGroups: WorkspaceTabGroupDef[],
  activeGroupIndex: number
): Promise<{ tabGroups: WorkspaceTabGroupDef[]; windows?: WorkspaceWindowDef[] }> {
  let layouts: CapturedWindowLayout[] = [{ windowId: currentWindowLabel(), tabGroups: ownGroups }];
  try {
    await reportWindowLayout(ownGroups, activeGroupIndex);
    const reports = await collectWindowLayouts();
    if (reports.length > 0) {
      layouts = reports.map((r) => ({ windowId: r.label, tabGroups: r.tabGroups }));
    }
  } catch (err) {
    frontendLog(
      "multi_window",
      `window layout aggregation unavailable, saving own window only: ${String(err)}`
    );
  }
  return assembleWindowedGroups(layouts);
}

/**
 * Spawn a native window for each non-main entry of a restore plan and seed it
 * with its assigned tab groups (#1925). Each spawned window hydrates its layout
 * on boot from the backend pending-restore queue; an entry that owns no groups
 * spawns an empty window so the #1902 empty-window state round-trips.
 *
 * Best-effort per window: a single window's spawn failure is logged and skipped
 * rather than aborting the whole restore.
 */
async function spawnPlanSecondaryWindows(plan: WindowRestorePlanEntry[]): Promise<void> {
  for (const entry of plan) {
    if (entry.isMain) continue;
    try {
      if (entry.tabGroups.length > 0) {
        await openWindow(undefined, { tabGroups: entry.tabGroups });
      } else {
        await openWindow();
      }
    } catch (err) {
      frontendLog("multi_window", `spawn restore window ${entry.windowId} failed: ${String(err)}`);
    }
  }
}

/**
 * Restore a windowed layout (#1925): spawn + hydrate the saved secondary windows
 * and return the tab group defs that belong in **this** (main) window, in saved
 * order. A legacy save with no window dimension yields a single main entry, so
 * this returns every group and spawns nothing — the back-compat path.
 */
async function restoreWindowedLayout(
  plan: WindowRestorePlanEntry[]
): Promise<WorkspaceTabGroupDef[]> {
  await spawnPlanSecondaryWindows(plan);
  const mainEntry = plan.find((entry) => entry.isMain);
  return mainEntry ? mainEntry.tabGroups : plan.flatMap((entry) => entry.tabGroups);
}

const LAST_SESSION_SAVE_DEBOUNCE_MS = 500;
/** Debounce timer for reporting a secondary window's layout slice (#1925). */
let windowLayoutReportTimer: ReturnType<typeof setTimeout> | null = null;
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
 * Probe reachability for a pending restore prompt and patch its tabs with the
 * results (#1931). Runs in the background after the dialog opens so the prompt
 * shows immediately; when the probe resolves, the prompt is updated in place so
 * the dialog can flag unreachable targets. Stale results (the prompt changed or
 * was dismissed meanwhile) are dropped by identity check.
 */
async function probeRestorePromptReachability(
  prompt: RestorePrompt,
  getState: () => AppState,
  setState: (partial: Partial<AppState>) => void
): Promise<void> {
  const targets = prompt.tabs.map((t) => t.target ?? { kind: "local" as const });
  try {
    const results = await probeRestoreTargets(targets, {
      listSerialPorts,
      probeHost: (host, port) => probeTargetReachable(host, port),
    });
    // Only apply if this exact prompt is still the active one.
    if (getState().restorePrompt !== prompt) return;
    setState({
      restorePrompt: {
        ...prompt,
        tabs: prompt.tabs.map((tab, i) => ({
          ...tab,
          reachability: results[i]?.reachability ?? "unknown",
          unreachableReason: results[i]?.reason,
        })),
      },
    });
  } catch (err) {
    // A probe failure leaves reachability unknown — never blocks restore.
    frontendLog("workspace", `restore reachability probe failed: ${String(err)}`);
  }
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
/**
 * Every tab across all of this window's tab groups, with the active group read
 * from the live `rootPanel` (the inactive groups keep their snapshot tree).
 * Used wherever a "whole window" operation must span groups — session teardown
 * on restore/launch and the close-with-live-tabs decision (#1903).
 */
function collectWindowTabs(state: {
  tabGroups: TabGroup[];
  activeTabGroupId: string;
  rootPanel: PanelNode;
}): TerminalTab[] {
  const trees = state.tabGroups.map((g) =>
    g.id === state.activeTabGroupId ? state.rootPanel : g.rootPanel
  );
  return trees.flatMap((tree) => getAllLeaves(tree).flatMap((leaf) => leaf.tabs));
}

/**
 * Fire a multi-window ownership call (claim/release, #1939) as a best-effort
 * signal: a rejected IPC promise is swallowed, and a synchronous throw — which
 * only happens when a unit test stubs `@/services/api` without the command — is
 * caught. Ownership is advisory (it feeds the #1926 owning-window badge and
 * resize gating), so it must never disrupt the session assignment that triggered
 * it.
 */
function bestEffortOwnership(op: () => Promise<unknown>): void {
  try {
    void op().catch(() => {});
  } catch {
    // api layer unavailable (unit tests stub @/services/api).
  }
}

function teardownAllSessions(state: {
  tabGroups: TabGroup[];
  activeTabGroupId: string;
  rootPanel: PanelNode;
}): void {
  const tabs = collectWindowTabs(state);
  let closed = 0;
  for (const tab of tabs) {
    if (!tab.sessionId) continue;
    const sessionId = tab.sessionId;
    closed++;
    if (tab.persistentConnectionId) {
      // Persistent session — detach so the background process keeps running.
      apiDetachPersistentTab(sessionId, tab.id).catch(() => {});
    } else {
      apiCloseTerminal(sessionId).catch(() => {});
    }
    // This window stops rendering the session, so relinquish its ownership
    // (#1939) — the window is not being destroyed here (a restore/launch is
    // replacing its tabs in place), so the backend's window-destroy
    // `release_all_for_window` will not fire.
    bestEffortOwnership(() => releaseSession(sessionId));
  }
  if (closed > 0) {
    frontendLog("workspace", `tore down ${closed} live session(s) before restore/launch`);
  }
}

/**
 * Partition the tabs of freshly-built restore/launch groups into the cohort that
 * feeds the aggregate partial-restore summary (GAP G4, #1146). Only `terminal`
 * tabs will attempt a live connect (settling via {@link setTabSessionId} /
 * {@link setTerminalDisconnectWithError}); `agent-error` tabs are resolved as
 * failed at build time and never emit a settle signal, so they are pre-counted
 * as failed. All other content types (editors, settings, …) are not connections
 * and are ignored.
 */
function collectRestoreCohort(groups: TabGroup[]): {
  pendingTabIds: string[];
  preFailedCount: number;
} {
  const tabs = groups.flatMap((g) => getAllLeaves(g.rootPanel).flatMap((leaf) => leaf.tabs));
  const pendingTabIds = tabs.filter((t) => t.contentType === "terminal").map((t) => t.id);
  const preFailedCount = tabs.filter((t) => t.contentType === "agent-error").length;
  return { pendingTabIds, preFailedCount };
}

/**
 * Resolve the stable identity of the remote session backing an editor tab, used
 * as part of the {@link AppState.openEditorTab} dedup key (#1599).
 *
 * The raw session id is deliberately *not* used: it changes when a connection
 * reconnects, which would spawn a duplicate tab instead of refreshing the
 * existing one. Instead this returns a value that stays constant across a
 * reconnect of the same logical connection but differs between distinct
 * connections, so opening the same path on two different hosts yields two tabs
 * while reconnecting one host refreshes its tab:
 *
 * - SFTP (`sftpSessionId`) → the session's `hostLabel` (`user@host:port`). A
 *   reconnect mints a new session id under the same label.
 * - Session layer (`sessionBrowser`) → the id of the terminal tab that owns the
 *   session. A reconnect swaps the session id but keeps the same tab.
 *
 * Returns `undefined` for local tabs and for remote tabs whose identity cannot
 * be resolved (unknown host, or no owning tab found); callers then fall back to
 * path-only dedup, preserving the pre-#1599 behaviour.
 */
function resolveEditorSessionKey(
  state: { rootPanel: PanelNode; sftpSessions: Record<string, SftpSessionEntry> },
  isRemote: boolean,
  sftpSessionId?: string,
  sessionBrowser?: EditorSessionRef
): string | undefined {
  if (!isRemote) return undefined;
  if (sftpSessionId) {
    const hostLabel = state.sftpSessions[sftpSessionId]?.hostLabel;
    return hostLabel ? `sftp:${hostLabel}` : undefined;
  }
  if (sessionBrowser) {
    const owner = getAllLeaves(state.rootPanel)
      .flatMap((l) => l.tabs)
      .find((t) => t.sessionId === sessionBrowser.sessionId);
    return owner ? `session:${owner.id}` : undefined;
  }
  return undefined;
}

/**
 * Enumerate every live tab across all tab groups (the active group is
 * represented by the live `rootPanel`, the others by their stored trees). Used
 * by the bulk-reconnect control to filter captured failed ids down to tabs that
 * still exist and can actually be re-driven (#1227).
 */
function collectLiveTabs(state: {
  tabGroups: TabGroup[];
  activeTabGroupId: string;
  rootPanel: PanelNode;
}): TerminalTab[] {
  const trees = state.tabGroups.map((g) =>
    g.id === state.activeTabGroupId ? state.rootPanel : g.rootPanel
  );
  return trees.flatMap((tree) => getAllLeaves(tree).flatMap((leaf) => leaf.tabs));
}

/**
 * Per-key unlisten functions for session-based monitoring subscriptions, keyed
 * by MonitorKey. Since multiple hosts can be monitored simultaneously (#1231),
 * each session monitor owns its own stats + status subscription that must be
 * detached individually when that host is disconnected (or its open fails).
 */
const _monitoringStatsUnlisten = new Map<string, () => void>();
const _monitoringStatusUnlisten = new Map<string, () => void>();

/** Detach and forget both subscriptions for one session-based monitor key. */
function detachMonitorListeners(key: string): void {
  _monitoringStatsUnlisten.get(key)?.();
  _monitoringStatsUnlisten.delete(key);
  _monitoringStatusUnlisten.get(key)?.();
  _monitoringStatusUnlisten.delete(key);
}

/** Build a fresh, idle {@link MonitoringEntry} for a key. */
function emptyMonitor(key: string, host: string | null): MonitoringEntry {
  return {
    key,
    host,
    monitorSessionId: null,
    stats: null,
    loading: false,
    error: null,
    status: null,
    sampleCount: 0,
    paused: false,
    intervalMs: DEFAULT_MONITORING_INTERVAL_MS,
  };
}

/** Merge a partial patch into the entry for `key`, creating it if absent. */
function upsertMonitor(key: string, patch: Partial<MonitoringEntry>): void {
  useAppStore.setState((state) => {
    const entry = state.monitors[key] ?? emptyMonitor(key, patch.host ?? key);
    return { monitors: { ...state.monitors, [key]: { ...entry, ...patch } } };
  });
}

/**
 * Derive the {@link MonitoringEntry} key for a tab: the id of the terminal
 * session that owns the monitor. Every monitor — desktop-direct SSH and
 * remote-session alike — routes through the session-based `MonitoringProvider`
 * push path (#1232), so the key is uniformly the session id. Returns `null`
 * when the tab has no session yet (so it cannot be monitored).
 */
export function monitorKeyForTab(tab: TerminalTab | null | undefined): string | null {
  return tab?.sessionId ?? null;
}

/** Select one monitor entry by key, or `null` when none exists. */
export function selectMonitor(state: AppState, key: string | null): MonitoringEntry | null {
  if (!key) return null;
  return state.monitors[key] ?? null;
}

/** Select the monitor entry for the currently active tab, or `null`. */
export function selectActiveMonitor(state: AppState): MonitoringEntry | null {
  return selectMonitor(state, monitorKeyForTab(getActiveTab(state)));
}

/**
 * Select every monitor with a live backend subscription (a non-null
 * `monitorSessionId`) — the set Open Connections lists and can kill. Entries
 * that only carry a transient error/cancelled state (never connected) are
 * excluded so nothing unkillable-yet-invisible is shown.
 */
export function selectOpenMonitors(state: AppState): MonitoringEntry[] {
  return Object.values(state.monitors).filter((m) => m.monitorSessionId !== null);
}

function createTab(
  title: string,
  connectionType: string,
  config: ConnectionConfig,
  panelId: string,
  contentType: TabContentType = "terminal",
  sessionId: string | null = null,
  persistentConnectionId?: string,
  spawned?: boolean,
  initialCommand?: string
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
    ...(spawned ? { spawned: true } : {}),
    ...(initialCommand ? { initialCommand } : {}),
  };
}

/**
 * Serialize a tab into the view-model carried across a native-window boundary
 * (#1900). Placement (`panelId`/`isActive`) is dropped — the destination window
 * re-assigns it on hydrate — while `sessionId` anchors the re-attach to the same
 * live backend session.
 */
function serializeHandoffTab(tab: TerminalTab): HandoffTab {
  return {
    sessionId: tab.sessionId,
    title: tab.title,
    connectionType: tab.connectionType,
    contentType: tab.contentType,
    config: tab.config,
    ...(tab.initialCommand ? { initialCommand: tab.initialCommand } : {}),
    ...(tab.persistentConnectionId ? { persistentConnectionId: tab.persistentConnectionId } : {}),
    ...(tab.connectionId ? { connectionId: tab.connectionId } : {}),
    ...(tab.spawned ? { spawned: true } : {}),
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

    // ── Multi-window foundation (#1900) ──
    movingSessionIds: [],
    isSessionMoving: (sessionId) => get().movingSessionIds.includes(sessionId),
    clearMovingSession: (sessionId) =>
      set((state) => ({
        movingSessionIds: state.movingSessionIds.filter((id) => id !== sessionId),
      })),

    moveTabToWindow: async (tabId, fromPanelId, target) => {
      // Locate the tab in the active group's live rootPanel.
      const sourceLeaf = getAllLeaves(get().rootPanel).find((l) => l.id === fromPanelId);
      const tab = sourceLeaf?.tabs.find((t) => t.id === tabId);
      if (!tab) return;

      const record: TabHandoffRecord = { tab: serializeHandoffTab(tab) };
      const sessionId = tab.sessionId;

      // Mark the live session as moving so the source window's Terminal does NOT
      // close the backend session when its view unmounts — the destination
      // window adopts the still-running session.
      if (sessionId) {
        set((state) => ({
          movingSessionIds: state.movingSessionIds.includes(sessionId)
            ? state.movingSessionIds
            : [...state.movingSessionIds, sessionId],
        }));
      }

      // Hand the tab off to the destination window (create it, or queue + nudge).
      try {
        if (target.kind === "new") {
          await openWindow(record);
        } else {
          await sendHandoffToWindow(target.label, record);
        }
      } catch (err) {
        // Hand-off failed: clear the moving flag so a later close still tears the
        // session down rather than leaking it.
        if (sessionId) get().clearMovingSession(sessionId);
        frontendLog("multi_window", `move tab to window failed: ${String(err)}`);
        return;
      }

      // Remove the tab from the source window's tree. The Terminal unmount sees
      // the moving flag and skips closeTerminal, keeping the backend session
      // alive for the destination to re-attach and replay.
      set((state) => {
        let newRootPanel = updateLeaf(state.rootPanel, fromPanelId, (leaf) =>
          removeTabFromLeaf(leaf, tabId)
        );
        const updatedSource = findLeaf(newRootPanel, fromPanelId);
        const allLeaves = getAllLeaves(newRootPanel);
        if (updatedSource && updatedSource.tabs.length === 0 && allLeaves.length > 1) {
          const removed = removeLeaf(newRootPanel, fromPanelId);
          newRootPanel = removed ? simplifyTree(removed) : newRootPanel;
        }
        const newActivePanelId =
          state.activePanelId === fromPanelId
            ? (getAllLeaves(newRootPanel)[0]?.id ?? null)
            : state.activePanelId;
        const tabGroups = state.tabGroups.map((g) =>
          g.id === state.activeTabGroupId
            ? { ...g, rootPanel: newRootPanel, activePanelId: newActivePanelId }
            : g
        );
        return { rootPanel: newRootPanel, tabGroups, activePanelId: newActivePanelId };
      });
    },

    hydrateHandoffTab: (record) =>
      set((state) => {
        const h = record.tab;
        const targetLeaf = getAllLeaves(state.rootPanel)[0];
        if (!targetLeaf) return state;

        tabCounter++;
        const newTab: TerminalTab = {
          id: `tab-${tabCounter}`,
          sessionId: h.sessionId,
          title: h.title,
          connectionType: h.connectionType,
          contentType: h.contentType,
          config: h.config,
          panelId: targetLeaf.id,
          isActive: true,
          ...(h.initialCommand ? { initialCommand: h.initialCommand } : {}),
          ...(h.persistentConnectionId ? { persistentConnectionId: h.persistentConnectionId } : {}),
          ...(h.connectionId ? { connectionId: h.connectionId } : {}),
          ...(h.spawned ? { spawned: true } : {}),
          // Repaint history from the backend ring buffer once the fresh xterm
          // (re)attaches to the live session.
          ...(h.sessionId ? { pendingScrollbackReplay: true } : {}),
        };

        const newRootPanel = updateLeaf(state.rootPanel, targetLeaf.id, (leaf) => ({
          ...leaf,
          tabs: [...leaf.tabs.map((t) => ({ ...t, isActive: false })), newTab],
          activeTabId: newTab.id,
        }));
        const tabGroups = state.tabGroups.map((g) =>
          g.id === state.activeTabGroupId ? { ...g, rootPanel: newRootPanel } : g
        );
        return { rootPanel: newRootPanel, tabGroups, activePanelId: targetLeaf.id };
      }),

    receivePendingHandoffs: async () => {
      let records: TabHandoffRecord[];
      try {
        records = await takePendingHandoffs();
      } catch (err) {
        frontendLog("multi_window", `takePendingHandoffs failed: ${String(err)}`);
        return;
      }
      for (const record of records) {
        // Claim ownership for this window so the backend `session → window` map
        // points here (single-owner invariant + resize gating).
        if (record.tab.sessionId) {
          try {
            await claimSession(record.tab.sessionId);
          } catch (err) {
            frontendLog("multi_window", `claimSession failed: ${String(err)}`);
          }
        }
        get().hydrateHandoffTab(record);
      }
    },

    receivePendingWindowRestore: async () => {
      let payload: WindowRestorePayload | null;
      try {
        payload = await takePendingWindowRestore();
      } catch (err) {
        frontendLog("multi_window", `takePendingWindowRestore failed: ${String(err)}`);
        return;
      }
      if (!payload || payload.tabGroups.length === 0) return;
      const state = get();
      // Agents are all disconnected at startup, so agentRef tabs resolve to
      // agent-error tabs rather than silently disappearing (mirrors restore).
      const agentContext = {
        agents: state.remoteAgents.map((a) => ({
          id: a.id,
          name: a.name,
          connected: a.connectionState === "connected",
        })),
        definitions: state.agentDefinitions,
      };
      const builtGroups = buildTabGroupsFromWorkspace(
        payload.tabGroups,
        state.connections,
        state.defaultShell,
        agentContext
      );
      const builtTabCount = builtGroups.reduce(
        (n, g) => n + getAllLeaves(g.rootPanel).reduce((m, leaf) => m + leaf.tabs.length, 0),
        0
      );
      if (builtGroups.length === 0 || builtTabCount === 0) {
        frontendLog(
          "multi_window",
          "receivePendingWindowRestore: seeded groups produced no launchable tabs"
        );
        return;
      }
      const firstGroup = builtGroups[0];
      // GAP G5 (#1146): raise the guard before placing the layout so this
      // window's auto-report subscription does not report a mid-hydrate tree.
      beginRestoreGuard(set);
      set({
        tabGroups: builtGroups,
        activeTabGroupId: firstGroup.id,
        rootPanel: firstGroup.rootPanel,
        activePanelId: firstGroup.activePanelId,
      });
      const { pendingTabIds, preFailedCount } = collectRestoreCohort(builtGroups);
      get().beginRestoreCohort(pendingTabIds, preFailedCount);
    },

    reportOwnWindowLayout: async () => {
      const state = get();
      const tabGroups = captureAllTabGroups(
        state.tabGroups,
        state.activeTabGroupId,
        state.rootPanel,
        state.connections
      );
      const activeGroupIndex = Math.max(
        0,
        state.tabGroups.findIndex((g) => g.id === state.activeTabGroupId)
      );
      try {
        await reportWindowLayout(tabGroups, activeGroupIndex);
      } catch (err) {
        frontendLog("multi_window", `reportWindowLayout failed: ${String(err)}`);
      }
    },

    scheduleWindowLayoutReport: () => {
      // While a restore/hydrate is settling, the layout tree is mid-flight; a
      // report now would push a transient slice to the aggregation authority and
      // nudge the main window to persist it (GAP G5, #1146). Hold until settled.
      if (get().restoreInProgress) return;
      if (windowLayoutReportTimer) clearTimeout(windowLayoutReportTimer);
      windowLayoutReportTimer = setTimeout(() => {
        windowLayoutReportTimer = null;
        void get().reportOwnWindowLayout();
      }, LAST_SESSION_SAVE_DEBOUNCE_MS);
    },

    openNewWindow: async () => {
      // No hand-off record: the new window boots empty and shows the
      // empty-window CTA (#1902). Window creation is a fast native op, so no
      // pending toast — only a recoverable error toast if it fails.
      try {
        await openWindow();
      } catch (err) {
        frontendLog("multi_window", `openNewWindow failed: ${String(err)}`);
        toast.error("Could not open a new window");
      }
    },

    // ── Close-with-live-tabs decision surface (#1903) ────────────────────
    pendingWindowClose: null,
    setPendingWindowClose: (request) => set({ pendingWindowClose: request }),

    prepareWindowClose: async (otherWindows) => {
      const sessions = classifyWindowCloseSessions(collectWindowTabs(get()));
      if (sessions.length === 0) {
        // Empty window (no live sessions) — nothing to decide, just close.
        return "proceed";
      }
      if (!windowCloseWouldLoseData(sessions)) {
        // Every owned session detaches cleanly — no data is lost, so close with
        // just a toast instead of a dialog (concept: "All-persistent → no
        // dialog").
        await get().endWindowSessions();
        toast.success(
          `${sessions.length} session${sessions.length === 1 ? "" : "s"} detached — still running`
        );
        return "proceed";
      }
      // At least one non-persistent session would be terminated — raise the
      // detach-vs-terminate decision surface.
      set({ pendingWindowClose: { sessions, otherWindows } });
      return "prompt";
    },

    endWindowSessions: async () => {
      const tabs = collectWindowTabs(get()).filter((tab) => tab.sessionId);
      await Promise.all(
        tabs.map((tab) => {
          const sessionId = tab.sessionId as string;
          return tab.persistentConnectionId
            ? apiDetachPersistentTab(sessionId, tab.id).catch(() => {})
            : apiCloseTerminal(sessionId).catch(() => {});
        })
      );
    },

    moveWindowSessionsToWindow: async (target) => {
      const tabs = collectWindowTabs(get()).filter((tab) => tab.sessionId);
      if (tabs.length === 0) return;

      // Mark every session as moving up front so a source Terminal unmounting
      // during the window teardown does NOT tear down the backend session — the
      // destination window adopts each still-running session (#1900 seam).
      const sessionIds = tabs.map((tab) => tab.sessionId as string);
      set((state) => ({
        movingSessionIds: Array.from(new Set([...state.movingSessionIds, ...sessionIds])),
      }));

      const records: TabHandoffRecord[] = tabs.map((tab) => ({ tab: serializeHandoffTab(tab) }));
      try {
        if (target.kind === "new") {
          // Create the destination window seeded with the first tab, then queue
          // the rest for it to drain on boot / on the nudge.
          const label = await openWindow(records[0]);
          for (const record of records.slice(1)) {
            await sendHandoffToWindow(label, record);
          }
        } else {
          for (const record of records) {
            await sendHandoffToWindow(target.label, record);
          }
        }
      } catch (err) {
        // Hand-off failed: clear the moving flags so a later close still tears
        // the sessions down rather than leaking them.
        for (const sessionId of sessionIds) get().clearMovingSession(sessionId);
        frontendLog("multi_window", `move window sessions failed: ${String(err)}`);
        throw err;
      }
    },

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
      const tabId = get().addTab(conn.name, conn.config.type, conn.config, {
        panelId,
        contentType: "terminal",
        terminalOptions: conn.terminalOptions,
        sessionId: entry.sessionId,
        persistentConnectionId: connectionId,
      });
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
        {
          panelId,
          contentType: "terminal",
          terminalOptions: def.terminalOptions,
          sessionId: entry.sessionId,
          persistentConnectionId: connectionId,
        }
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

    clearPendingScrollbackReplay: (tabId) =>
      set((state) => {
        const leaf = findLeafByTab(state.rootPanel, tabId);
        if (!leaf) return state;
        const rootPanel = updateLeaf(state.rootPanel, leaf.id, (l) => ({
          ...l,
          tabs: l.tabs.map((t) =>
            t.id === tabId && t.pendingScrollbackReplay
              ? { ...t, pendingScrollbackReplay: false }
              : t
          ),
        }));
        const tabGroups = state.tabGroups.map((g) =>
          g.id === state.activeTabGroupId ? { ...g, rootPanel } : g
        );
        return { rootPanel, tabGroups };
      }),

    setTabSessionId: (tabId, sessionId) => {
      // The tab as it stands *before* this update — used both to skip work for an
      // unknown tab and to capture the session id this tab is superseding, so a
      // replaced/cleared session releases its ownership as the new one is claimed.
      const existingTab = getAllLeaves(get().rootPanel)
        .flatMap((l) => l.tabs)
        .find((t) => t.id === tabId);
      const prevSessionId = existingTab?.sessionId ?? null;

      // For remote-session tabs gaining a session ID, fetch capabilities so
      // monitoring knows whether this session supports stats collection.
      if (sessionId && existingTab?.connectionType === "remote-session") {
        sessionGetCapabilities(sessionId)
          .then((caps) => get().setSessionCapabilities(sessionId, caps))
          .catch(() => {});
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

      // Multi-window ownership (#1939): the window that renders a session owns it
      // in the backend `session → window` map (#1900). Claiming here — the single
      // choke point every rendered session flows through (terminal, file browser,
      // remote desktop, restore reconnect) — makes the Open Connections
      // owning-window badge (#1926) appear for *every* session, not only ones
      // moved between windows. Releasing a superseded/cleared session keeps the
      // map from leaking dead entries. A session mid-move is skipped so the
      // claim/release handshake with the destination window is not disturbed: the
      // destination grants first, so the source must never release the moved
      // session out from under it. Best-effort (see `bestEffortOwnership`).
      if (existingTab) {
        if (prevSessionId && prevSessionId !== sessionId && !get().isSessionMoving(prevSessionId)) {
          bestEffortOwnership(() => releaseSession(prevSessionId));
        }
        if (sessionId) {
          bestEffortOwnership(() => claimSession(sessionId));
        }
      }
      // A non-null session id means this tab has connected — settle it in any
      // in-flight restore/launch cohort so the aggregate summary can fire (#1146).
      if (sessionId) {
        get().settleRestoreTab(tabId, "connected");

        // On-connect workflow triggers (#1855): a terminal session that opened
        // for a saved connection runs any workflow bound to that connection,
        // once per session open (interactive shells only — file-browser and
        // remote-desktop tabs are excluded here). Matching/guarding lives in the
        // workflowTriggers service; the store only supplies state and the run.
        const connectedTab = getAllLeaves(get().rootPanel)
          .flatMap((l) => l.tabs)
          .find((t) => t.id === tabId);
        if (connectedTab?.contentType === "terminal" && connectedTab.connectionId) {
          dispatchOnConnectTriggers({
            connectionId: connectedTab.connectionId,
            tabId,
            sessionId,
            workflows: get().workflows,
            run: (workflowId, targetTabId) => {
              void get().runWorkflow(workflowId, { targetTabId });
            },
          });
        }
      }
    },

    addTab: (title, connectionType, config, options) => {
      const {
        panelId,
        contentType,
        terminalOptions,
        sessionId,
        persistentConnectionId,
        connectionId,
        spawned,
        initialCommand,
      } = options ?? {};
      let createdTabId = "";
      set((state) => {
        const allLeaves = getAllLeaves(state.rootPanel);
        const targetPanelId = panelId ?? state.activePanelId ?? allLeaves[0]?.id;
        if (!targetPanelId) return state;

        const defaultConfig: ConnectionConfig = config ?? {
          type: "local",
          config: { shell: state.defaultShell },
        };
        const baseTab = createTab(
          title,
          connectionType,
          defaultConfig,
          targetPanelId,
          contentType,
          sessionId ?? null,
          persistentConnectionId,
          spawned,
          initialCommand
        );
        const newTab: TerminalTab = connectionId ? { ...baseTab, connectionId } : baseTab;
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
      // Record real terminal connections in the session history (#1883). Only
      // genuine connections carry a config; settings/editor/etc. tabs (which
      // pass a non-terminal contentType) are skipped. Fire-and-forget so tab
      // creation never blocks on the history write.
      if ((contentType ?? "terminal") === "terminal" && config) {
        void get().recordSession(connectionType, config);
      }
      return createdTabId;
    },

    openSpawnedContainer: (spawn) =>
      get().addTab(
        spawn.title,
        "docker",
        { type: "docker", config: spawn.settings },
        { contentType: "terminal", spawned: true }
      ),

    openSpawnedShell: (spawn) => {
      // The resolved backend type decides which session opens: a local shell, a
      // WSL distribution, or an SSH saved connection (#1511). Legacy payloads
      // without a `type` are treated as local (#1365).
      const sessionType = spawn.type ?? "local";
      // SSH cannot set a start cwd at spawn, so `cd` into the target after the
      // session connects, via the tab's `initialCommand` (Terminal.tsx runs it
      // through `send_input`). Local/WSL set a real startingDirectory instead.
      const initialCommand = spawn.cdPath ? `cd ${quotePath(spawn.cdPath)}` : undefined;
      return get().addTab(
        spawn.title,
        sessionType,
        { type: sessionType, config: spawn.settings },
        { contentType: "terminal", spawned: true, initialCommand }
      );
    },

    // Session Picker (SI-3, #1366)
    spawnPickerVisible: false,
    spawnPickerRequest: undefined,
    showSpawnPicker: (request) => set({ spawnPickerVisible: true, spawnPickerRequest: request }),
    hideSpawnPicker: () => set({ spawnPickerVisible: false, spawnPickerRequest: undefined }),

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
          "ping-sweep": "Ping Sweep",
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

    openEditorTab: (filePath, isRemote, sftpSessionId, permissions, sessionBrowser) =>
      set((state) => {
        const allLeaves = getAllLeaves(state.rootPanel);

        // Stable identity of the backing session, so the same path opened from
        // two different remote sessions gets two tabs while a reconnect of the
        // same connection refreshes one (#1599).
        const sessionKey = resolveEditorSessionKey(state, isRemote, sftpSessionId, sessionBrowser);

        // Look for an existing editor tab for this file on the same session.
        for (const leaf of allLeaves) {
          const existing = leaf.tabs.find(
            (t) =>
              t.contentType === "editor" &&
              t.editorMeta?.filePath === filePath &&
              t.editorMeta?.isRemote === isRemote &&
              t.editorMeta?.sessionKey === sessionKey
          );
          if (existing) {
            const rootPanel = updateLeaf(state.rootPanel, leaf.id, (l) => ({
              ...l,
              tabs: l.tabs.map((t) => {
                if (t.id !== existing.id) return { ...t, isActive: false };
                // Refresh the backing session so a reconnected session works.
                // Only the transport actually supplied is refreshed, and the
                // other is cleared with it: a tab must never carry both an
                // sftpSessionId and a sessionBrowser, or the editor's
                // SFTP-first branch would shadow the session-layer one. (#1557)
                let updatedMeta = t.editorMeta;
                if (isRemote && t.editorMeta) {
                  if (sftpSessionId) {
                    updatedMeta = {
                      ...t.editorMeta,
                      sftpSessionId,
                      sessionBrowser: undefined,
                      sessionKey,
                    };
                  } else if (sessionBrowser) {
                    updatedMeta = {
                      ...t.editorMeta,
                      sessionBrowser,
                      sftpSessionId: undefined,
                      sessionKey,
                    };
                  }
                }
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
        const editorMeta: EditorTabMeta = {
          filePath,
          isRemote,
          sftpSessionId,
          permissions,
          sessionBrowser,
          sessionKey,
        };
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

    pendingSessionCloseConfirm: null,
    setPendingSessionCloseConfirm: (req) => set({ pendingSessionCloseConfirm: req }),
    pendingAttachedTabCloseConfirm: null,
    setPendingAttachedTabCloseConfirm: (req) => set({ pendingAttachedTabCloseConfirm: req }),

    closeTab: (tabId, panelId) => {
      // Relinquish backend ownership of this tab's live session (#1939). A closed
      // tab's session is torn down here (or already exited), so its
      // `session → window` entry (#1900) must be dropped or it leaks a stale
      // owning-window badge (#1926). Skipped for a session mid-move — that tab is
      // removed via the move path, not closed, and the destination window now
      // owns it. Best-effort (see `bestEffortOwnership`).
      const closingSessionId = getAllLeaves(useAppStore.getState().rootPanel)
        .flatMap((l) => l.tabs)
        .find((t) => t.id === tabId)?.sessionId;
      if (closingSessionId && !get().isSessionMoving(closingSessionId)) {
        bestEffortOwnership(() => releaseSession(closingSessionId));
      }

      // Close every SFTP session owned by this tab and drop it from the map —
      // the L1 leak fix (#1241). Fire the async closes here (fire-and-forget)
      // so the state updater below stays pure; the entries are removed regardless.
      const ownedSftp = Object.entries(useAppStore.getState().sftpSessions)
        .filter(([, entry]) => entry.owningTabId === tabId)
        .map(([sessionId]) => sessionId);
      ownedSftp.forEach((sessionId) => {
        sftpClose(sessionId).catch(() => {});
      });

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
        const remainingConnectDeadline = omitKey(state.terminalConnectDeadline, tabId);
        const remainingExited = omitKey(state.terminalExitedTabs, tabId);
        const remainingExitInfo = omitKey(state.terminalExitInfo, tabId);
        const remainingDiscErr = omitKey(state.terminalDisconnectErrors, tabId);
        const remainingView = omitKey(state.terminalViewMode, tabId);
        const remainingReconn = omitKey(state.terminalReconnectingTabs, tabId);
        const remainingReattach = omitKey(state.terminalReattaching, tabId);
        const remainingPrompt = omitKey(state.terminalReconnectPrompt, tabId);
        const remainingAutoRetry = omitKey(state.terminalAutoRetryCount, tabId);
        const remainingWaiting = omitKey(state.terminalWaitingForAgent, tabId);

        // Drop the SFTP sessions owned by this tab (closed above) from the map,
        // and reset the browser when the active session was one of them (#1241).
        const remainingSftp = ownedSftp.reduce(
          (acc, sessionId) => omitKey(acc, sessionId),
          state.sftpSessions
        );
        const activeSftpClosed =
          state.sftpSessionId != null && ownedSftp.includes(state.sftpSessionId);
        const sftpBrowserReset = activeSftpClosed
          ? {
              sftpSessionId: null,
              sftpConnectedHost: null,
              sftpStatus: "idle" as SftpStatus,
              fileEntries: [],
              currentPath: "/",
              sftpError: null,
            }
          : {};

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
            terminalConnectDeadline: remainingConnectDeadline,
            terminalExitedTabs: remainingExited,
            terminalExitInfo: remainingExitInfo,
            terminalDisconnectErrors: remainingDiscErr,
            terminalViewMode: remainingView,
            terminalReconnectingTabs: remainingReconn,
            terminalReattaching: remainingReattach,
            terminalReconnectPrompt: remainingPrompt,
            terminalAutoRetryCount: remainingAutoRetry,
            terminalWaitingForAgent: remainingWaiting,
            sftpSessions: remainingSftp,
            ...sftpBrowserReset,
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
          terminalConnectDeadline: remainingConnectDeadline,
          terminalExitedTabs: remainingExited,
          terminalExitInfo: remainingExitInfo,
          terminalDisconnectErrors: remainingDiscErr,
          terminalViewMode: remainingView,
          terminalReconnectingTabs: remainingReconn,
          terminalReattaching: remainingReattach,
          terminalReconnectPrompt: remainingPrompt,
          terminalAutoRetryCount: remainingAutoRetry,
          terminalWaitingForAgent: remainingWaiting,
          sftpSessions: remainingSftp,
          ...sftpBrowserReset,
        };
      });
    },

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
      confirmCloseLiveSession: true,
      confirmCloseAttachedTab: true,
      askOpenSavedFileInTab: true,
      warnLargePortScan: true,
      warnLargePingSweep: true,
    },
    savedSettings: {
      version: "1",
      externalConnectionFiles: [],
      powerMonitoringEnabled: true,
      fileBrowserEnabled: true,
      confirmCloseTabOnShortcut: true,
      confirmCloseLiveSession: true,
      confirmCloseAttachedTab: true,
      askOpenSavedFileInTab: true,
      warnLargePortScan: true,
      warnLargePingSweep: true,
    },

    // Layout
    layoutConfig: DEFAULT_LAYOUT,
    layoutDialogOpen: false,

    setLayoutDialogOpen: (open) => set({ layoutDialogOpen: open }),

    // Shortcuts overlay
    shortcutsOverlayOpen: false,
    setShortcutsOverlayOpen: (open) => set({ shortcutsOverlayOpen: open }),

    commandPaletteOpen: false,
    setCommandPaletteOpen: (open) => set({ commandPaletteOpen: open }),

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

    // Per-session syntax-highlighting toggle (runtime-only, never persisted)
    sessionHighlighting: {},
    setSessionHighlighting: (sessionId, enabled) =>
      set((s) =>
        enabled === undefined
          ? { sessionHighlighting: omitKey(s.sessionHighlighting, sessionId) }
          : { sessionHighlighting: { ...s.sessionHighlighting, [sessionId]: enabled } }
      ),

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
        applyTheme(settings.theme, settings.customThemes);
        void get().loadSessionHistory();
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
      // Load macros
      get().loadMacros();
      // Load workflows
      get().loadWorkflows();
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

        // Re-apply when the selection changes or when the active custom theme's
        // colors were edited (the customThemes array reference changes on save).
        if (
          oldSettings.theme !== newSettings.theme ||
          oldSettings.customThemes !== newSettings.customThemes
        ) {
          applyTheme(newSettings.theme, newSettings.customThemes);
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

    updateShellIntegration: async (nextSi) => {
      // Capture the previously-persisted value for rollback. Both the optimistic
      // write and the rollback merge into the CURRENT settings (read at call
      // time), so a concurrent general-settings edit landing mid-persist is
      // preserved rather than clobbered.
      const prevSi = get().settings.shellIntegration;
      const optimistic = { ...get().settings, shellIntegration: nextSi };
      set({ settings: optimistic, savedSettings: optimistic });
      try {
        return await saveShellIntegrationSettings(nextSi);
      } catch (err) {
        const rolledBack = { ...get().settings, shellIntegration: prevSi };
        set({ settings: rolledBack, savedSettings: rolledBack });
        throw err;
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
          persistFolder(toggled).catch((err) => {
            console.error("Failed to persist folder toggle:", err);
            toast.error(
              `Failed to save folder state: ${err instanceof Error ? err.message : String(err)}`
            );
          });
        }
        return { folders };
      });
    },

    reloadConnectionsFromBackend: () => {
      frontendLog("connection_sync", "focus reload: triggered by external event");
      void applyConnectionReload();
    },

    // --- Session history (#1883) ---
    sessionHistory: [],

    loadSessionHistory: async () => {
      try {
        const entries = await getSessionHistory();
        set({ sessionHistory: entries });
      } catch (err) {
        frontendLog(
          "session_history",
          `Failed to load session history: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    },

    recordSession: async (connectionType, config) => {
      const settings = get().settings;
      if (settings.sessionHistoryEnabled === false) return;
      // Privacy: passwords/passphrases are NEVER written to history, regardless
      // of the connection's savePassword flag (they live in the credential store).
      const safeConfig = stripHistorySecrets(config);
      const title = sessionHistoryTitle(connectionType, safeConfig);
      const limit = settings.sessionHistoryLimit ?? 50;
      try {
        const entries = await apiRecordSession(connectionType, safeConfig, title, limit);
        set({ sessionHistory: entries });
      } catch (err) {
        frontendLog(
          "session_history",
          `Failed to record session: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    },

    pinHistoryEntry: async (dedupKey, pinned) => {
      const entries = await apiSetHistoryEntryPinned(dedupKey, pinned);
      set({ sessionHistory: entries });
    },

    markHistoryPromoted: async (dedupKey) => {
      const entries = await apiMarkHistoryEntryPromoted(dedupKey);
      set({ sessionHistory: entries });
    },

    removeHistoryEntry: async (dedupKey) => {
      const entries = await apiRemoveHistoryEntry(dedupKey);
      set({ sessionHistory: entries });
    },

    clearSessionHistory: async () => {
      const entries = await apiClearSessionHistory();
      set({ sessionHistory: entries });
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

    bulkAddConnections: (newConnections) => {
      if (newConnections.length === 0) return;
      set((state) => ({ connections: [...state.connections, ...newConnections] }));
      frontendLog(
        "connection_sync",
        `bulkAddConnections: persisting ${newConnections.length} connections`
      );
      Promise.all(
        newConnections.map((c) =>
          persistConnection(stripPassword(c)).then((persistedId) =>
            reconcileConnectionId(c.id, persistedId)
          )
        )
      )
        .then(() => {
          toast.success(
            `Imported ${newConnections.length} ${newConnections.length === 1 ? "connection" : "connections"}`
          );
          return applyConnectionReload();
        })
        .catch((err) => {
          console.error("Failed to persist imported connections:", err);
          toast.error(
            `Failed to import connections: ${err instanceof Error ? err.message : String(err)}`
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
          toast.success(
            `Deleted ${toDelete.length} ${toDelete.length === 1 ? "connection" : "connections"}`
          );
          return applyConnectionReload();
        })
        .catch((err) => {
          console.error("Failed to persist bulk connection deletion:", err);
          toast.error(
            `Failed to delete connections: ${err instanceof Error ? err.message : String(err)}`
          );
        });
    },

    addFolder: (folder) => {
      set((state) => ({ folders: [...state.folders, folder] }));
      frontendLog("connection_sync", `addFolder: persisting ${folder.id}`);
      persistFolder(folder)
        .then(() => applyConnectionReload())
        .catch((err) => {
          console.error("Failed to persist new folder:", err);
          toast.error(
            `Failed to create folder ${folder.name}: ${err instanceof Error ? err.message : String(err)}`
          );
        });
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
        .catch((err) => {
          console.error("Failed to persist folder deletion:", err);
          toast.error(
            `Failed to delete folder: ${err instanceof Error ? err.message : String(err)}`
          );
        });
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
        .catch((err) => {
          console.error("Failed to persist duplicated connection:", err);
          toast.error(
            `Failed to duplicate ${original.name}: ${err instanceof Error ? err.message : String(err)}`
          );
        });
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
        toast.error(
          `Failed to move ${conn.name}: ${err instanceof Error ? err.message : String(err)}`
        );
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
          .catch((err) => {
            console.error("Failed to persist connection move:", err);
            toast.error(
              `Failed to move ${moved.name}: ${err instanceof Error ? err.message : String(err)}`
            );
          });
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
        .catch((err) => {
          console.error("Failed to persist bulk connection move:", err);
          toast.error(
            `Failed to move connections: ${err instanceof Error ? err.message : String(err)}`
          );
        });
    },

    // File browser / SFTP
    fileEntries: [],
    currentPath: "/",
    sftpSessionId: null,
    sftpStatus: "idle",
    sftpError: null,
    sftpConnectedHost: null,
    sftpSessions: {},
    sftpLastConfig: null,
    transfers: {},
    transferQueue: {},
    transferQueueMinimized: false,

    setCurrentPath: (path) => set({ currentPath: path }),
    setFileEntries: (entries) => set({ fileEntries: entries }),

    connectSftp: async (config: Record<string, unknown>, owningTabId?: string) => {
      // Host switch: do not silently overwrite the previous active session.
      // Close it only when its owning tab is gone (orphan cleanup); otherwise
      // leave it registered so it stays visible/killable (issue #1241, L1).
      const prev = useAppStore.getState();
      const prevId = prev.sftpSessionId;
      if (prevId) {
        const prevEntry = prev.sftpSessions[prevId];
        const ownerAlive =
          prevEntry != null && collectLiveTabs(prev).some((t) => t.id === prevEntry.owningTabId);
        if (!ownerAlive) {
          try {
            await sftpClose(prevId);
          } catch {
            // Ignore close errors — the entry is dropped regardless.
          }
          set((state) => ({ sftpSessions: omitKey(state.sftpSessions, prevId) }));
        }
      }
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
        const hostLabel = `${config.username as string}@${config.host as string}:${config.port as number}`;
        // One SFTP session per owning tab: close any prior session the same tab
        // owned (e.g. revisiting the tab or reconnecting to a new host) so
        // sessions don't accumulate for a single browser (#1241).
        const staleForTab = owningTabId
          ? Object.entries(useAppStore.getState().sftpSessions)
              .filter(([sid, e]) => e.owningTabId === owningTabId && sid !== sessionId)
              .map(([sid]) => sid)
          : [];
        staleForTab.forEach((sid) => {
          sftpClose(sid).catch(() => {});
        });
        set((state) => {
          let sessions = state.sftpSessions;
          if (owningTabId) {
            sessions = staleForTab.reduce((acc, sid) => omitKey(acc, sid), sessions);
            sessions = { ...sessions, [sessionId]: { hostLabel, owningTabId } };
          }
          return {
            sftpSessionId: sessionId,
            sftpStatus: "connected" as SftpStatus,
            currentPath: activePath,
            fileEntries: entries,
            sftpConnectedHost: hostLabel,
            sftpSessions: sessions,
          };
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
      set((state) => ({
        sftpSessionId: null,
        sftpStatus: "idle",
        fileEntries: [],
        currentPath: "/",
        sftpError: null,
        sftpConnectedHost: null,
        sftpLastConfig: null,
        sftpSessions: sessionId ? omitKey(state.sftpSessions, sessionId) : state.sftpSessions,
      }));
    },

    closeSftpSession: async (sessionId: string) => {
      // Kill-cascade (concept "Edge cases"): cancel every in-flight transfer
      // owned by this session *before* closing it, so no transfer keeps a dead
      // session's channel alive. The `cancelled` events D1 emits back clear the
      // rows; we also drop them optimistically below.
      const owned = Object.values(useAppStore.getState().transfers).filter(
        (t) => t.sessionId === sessionId
      );
      await Promise.all(
        owned.map((t) =>
          sftpCancelTransfer(t.transferId).catch((err) => {
            frontendLog(
              "sftp_transfer",
              `closeSftpSession: cancel of ${t.transferId} failed: ${
                err instanceof Error ? err.message : String(err)
              }`
            );
          })
        )
      );
      if (owned.length > 0) {
        const cancelledIds = new Set(owned.map((t) => t.transferId));
        set((state) => ({
          transfers: Object.fromEntries(
            Object.entries(state.transfers).filter(([id]) => !cancelledIds.has(id))
          ),
        }));
      }
      try {
        await sftpClose(sessionId);
      } catch {
        // Ignore close errors — the entry is dropped regardless.
      }
      set((state) => {
        const isActive = state.sftpSessionId === sessionId;
        return {
          sftpSessions: omitKey(state.sftpSessions, sessionId),
          // When the killed session was the one the browser is viewing, reset
          // the browser to idle so it stops looking connected.
          ...(isActive
            ? {
                sftpSessionId: null,
                sftpConnectedHost: null,
                sftpStatus: "idle" as SftpStatus,
                fileEntries: [],
                currentPath: "/",
                sftpError: null,
              }
            : {}),
        };
      });
    },

    applyTransferProgress: (progress: TransferState) =>
      set((state) => {
        // A terminal phase clears the row (D1 already removed any partial local
        // file on cancel/error). done/error toasts are the D2 follow-up.
        if (progress.phase !== "transferring") {
          if (!(progress.transferId in state.transfers)) return {};
          return { transfers: omitKey(state.transfers, progress.transferId) };
        }
        return {
          transfers: { ...state.transfers, [progress.transferId]: progress },
        };
      }),

    cancelTransfer: async (transferId: string) => {
      try {
        await sftpCancelTransfer(transferId);
      } catch (err) {
        frontendLog(
          "sftp_transfer",
          `cancelTransfer: cancel of ${transferId} failed: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
        throw err;
      }
    },

    // --- Transfer Queue panel slice (#1337) ---

    addTransfer: (entry: TransferEntry) =>
      set((state) => ({ transferQueue: { ...state.transferQueue, [entry.id]: entry } })),

    updateTransfer: (id: string, patch: Partial<TransferEntry>) =>
      set((state) => {
        const existing = state.transferQueue[id];
        if (!existing) return {};
        return { transferQueue: { ...state.transferQueue, [id]: { ...existing, ...patch } } };
      }),

    removeTransfer: (id: string) =>
      set((state) => {
        if (!(id in state.transferQueue)) return {};
        return { transferQueue: omitKey(state.transferQueue, id) };
      }),

    clearCompleted: () =>
      set((state) => ({
        transferQueue: Object.fromEntries(
          Object.entries(state.transferQueue).filter(([, t]) => t.state !== "completed")
        ),
      })),

    setTransferQueueMinimized: (minimized: boolean) => set({ transferQueueMinimized: minimized }),

    applyTransferProgressToQueue: (progress: TransferProgress) =>
      set((state) => {
        const prev = state.transferQueue[progress.transferId];
        const entry = transferEntryFromProgress(progress, prev, Date.now());
        return { transferQueue: { ...state.transferQueue, [entry.id]: entry } };
      }),

    seedTransferQueue: (seed: TransferSeed) =>
      set((state) => {
        // Idempotent: never overwrite a row an event already advanced (#1632).
        if (seed.id in state.transferQueue) return {};
        const entry = transferEntryFromSeed(seed, Date.now());
        return { transferQueue: { ...state.transferQueue, [entry.id]: entry } };
      }),

    reconcileTransferQueue: (snapshots: TransferSnapshot[]) =>
      set((state) => {
        const now = Date.now();
        let next: Record<string, TransferEntry> | null = null;
        for (const snap of snapshots) {
          // Only a *genuinely settled* terminal snapshot settles a row. A live
          // rich `failed` handle mid auto-retry (or awaiting a manual retry)
          // reports `settled: false` though its state is `failed`, so a
          // transient failure is never folded into a terminal row the reconcile
          // guard would then never re-settle (#1657). Events own live progress,
          // so a non-terminal snapshot must never move an active row anyway.
          if (!snap.settled || !isTerminalTransferState(snap.state)) continue;
          const prev = state.transferQueue[snap.transferId];
          // Seed owns row creation; do not resurrect a row the user removed.
          if (!prev) continue;
          // Already settled (an event beat us here): idempotent no-op.
          if (isTerminalTransferState(prev.state)) continue;
          next ??= { ...state.transferQueue };
          next[snap.transferId] = transferEntryFromSnapshot(snap, prev, now);
        }
        return next ? { transferQueue: next } : {};
      }),

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
        set((state) => ({
          sftpStatus: "error",
          sftpError: message,
          ...(sessionDead
            ? {
                sftpSessionId: null,
                sftpConnectedHost: null,
                sftpSessions: omitKey(state.sftpSessions, sessionId),
              }
            : {}),
        }));
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
        set((state) => ({
          sftpStatus: "error",
          sftpError: message,
          ...(sessionDead
            ? {
                sftpSessionId: null,
                sftpConnectedHost: null,
                sftpSessions: sftpSessionId
                  ? omitKey(state.sftpSessions, sftpSessionId)
                  : state.sftpSessions,
              }
            : {}),
        }));
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
    terminalConnectDeadline: {},
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
        terminalConnectDeadline: omitKey(state.terminalConnectDeadline, tabId),
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
        terminalConnectDeadline: connecting
          ? armConnectDeadline(state.terminalConnectDeadline, tabId, "connecting")
          : omitKey(state.terminalConnectDeadline, tabId),
      })),
    setTerminalAutoRetrying: (tabId, count) =>
      set((state) => ({
        terminalConnecting: omitKey(state.terminalConnecting, tabId),
        terminalConnectDeadline: omitKey(state.terminalConnectDeadline, tabId),
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
        terminalConnectDeadline:
          agentId === null
            ? omitKey(state.terminalConnectDeadline, tabId)
            : armConnectDeadline(state.terminalConnectDeadline, tabId, "waiting-for-agent"),
      })),
    failTerminalConnectTimeout: (tabId, kind) =>
      set((state) => {
        // Guard against stale timers: only fail the tab if it is still in the
        // state the timeout was armed for. A connect that succeeded, an agent
        // that came online, or a cancelled tab all clear the relevant flag
        // first, making this a no-op.
        const stillArmed =
          kind === "waiting-for-agent"
            ? state.terminalWaitingForAgent[tabId] !== undefined
            : state.terminalConnecting[tabId] === true;
        if (!stillArmed) {
          return {};
        }
        frontendLog(
          "disconnect",
          `connect timeout (${kind}) for tab=${tabId} — transitioning to Failed`
        );
        return {
          terminalConnecting: omitKey(state.terminalConnecting, tabId),
          terminalWaitingForAgent: omitKey(state.terminalWaitingForAgent, tabId),
          terminalConnectDeadline: omitKey(state.terminalConnectDeadline, tabId),
          terminalAutoRetryCount: omitKey(state.terminalAutoRetryCount, tabId),
          terminalSpawnErrors: {
            ...state.terminalSpawnErrors,
            [tabId]: connectTimeoutMessage(kind),
          },
        };
      }),
    abortTerminalConnect: (tabId) =>
      set((state) => {
        frontendLog(
          "disconnect",
          `connect aborted by user for tab=${tabId} — transitioning to Failed`
        );
        // Clear every in-flight pre-connect flag and land on a retryable Failed
        // state (spawn error set) so the overlay shows Retry and the tab stays
        // open. Distinct from closeTab, which tears the tab down entirely.
        return {
          terminalConnecting: omitKey(state.terminalConnecting, tabId),
          terminalWaitingForAgent: omitKey(state.terminalWaitingForAgent, tabId),
          terminalConnectDeadline: omitKey(state.terminalConnectDeadline, tabId),
          terminalAutoRetryCount: omitKey(state.terminalAutoRetryCount, tabId),
          terminalSpawnErrors: {
            ...state.terminalSpawnErrors,
            [tabId]: ABORTED_CONNECT_MESSAGE,
          },
        };
      }),

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
      // Stop monitoring the dying tab's host — its stats are no longer updated
      // and the overlay hides the terminal anyway. Other hosts keep monitoring.
      const deadKey = monitorKeyForTab(collectLiveTabs(get()).find((t) => t.id === tabId));
      if (deadKey && get().monitors[deadKey]) {
        get().disconnectMonitoring(deadKey);
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
      // A failed (re)connect settles this tab as failed in any in-flight
      // restore/launch cohort so the aggregate summary reflects it (#1146).
      get().settleRestoreTab(tabId, "failed");
      const deadKey = monitorKeyForTab(collectLiveTabs(get()).find((t) => t.id === tabId));
      if (deadKey && get().monitors[deadKey]) {
        get().disconnectMonitoring(deadKey);
      }
    },

    // Aggregate partial-restore feedback (#1146, audit G4) + bulk retry (#1227, M2).
    restoreCohort: null,
    failedRestoreTabIds: [],
    beginRestoreCohort: (pendingTabIds, preFailedCount, toastId) => {
      const pending = new Set(pendingTabIds);
      const total = pending.size + preFailedCount;
      if (total === 0) return;
      frontendLog(
        "workspace_restore",
        `restore cohort started: ${total} tab(s), ${pending.size} pending, ${preFailedCount} pre-failed`
      );
      // A fresh cohort supersedes any leftover retry set from the prior one.
      set({
        restoreCohort: { pending, total, failed: preFailedCount, failedTabIds: new Set(), toastId },
        failedRestoreTabIds: [],
      });
      // A cohort with no live tabs to wait on (e.g. all agent-error) settles now.
      if (pending.size === 0) get().settleRestoreCohort();
    },
    settleRestoreTab: (tabId, outcome) => {
      const cohort = get().restoreCohort;
      if (!cohort || !cohort.pending.has(tabId)) return;
      const pending = new Set(cohort.pending);
      pending.delete(tabId);
      const failed = cohort.failed + (outcome === "failed" ? 1 : 0);
      // Remember which terminal tabs failed so they can be bulk-reconnected.
      const failedTabIds = new Set(cohort.failedTabIds);
      if (outcome === "failed") failedTabIds.add(tabId);
      set({ restoreCohort: { ...cohort, pending, failed, failedTabIds } });
      if (pending.size === 0) get().settleRestoreCohort();
    },
    settleRestoreCohort: () => {
      const cohort = get().restoreCohort;
      if (!cohort) return;
      // Restrict the retry set to tabs that still exist as live terminal tabs.
      const liveTerminalIds = new Set(
        collectLiveTabs(get())
          .filter((t) => t.contentType === "terminal")
          .map((t) => t.id)
      );
      const retryTabIds = [...cohort.failedTabIds].filter((id) => liveTerminalIds.has(id));
      // Clear first (and record the retry set) so this fires exactly once even
      // if a stray settle races in.
      set({ restoreCohort: null, failedRestoreTabIds: retryTabIds });
      const { total, failed, toastId } = cohort;
      const restored = total - failed;
      frontendLog(
        "workspace_restore",
        `restore cohort settled: ${restored}/${total} connected, ${failed} failed`
      );
      if (failed === 0) {
        // Resolve the pending bulk-retry toast in place when present.
        toast.success(`Restored ${total} ${total === 1 ? "tab" : "tabs"}`, { id: toastId });
      } else {
        // No toast.warning primitive — use info for the partial-failure case.
        // Offer a one-tap bulk retry when there are reconnectable failed tabs.
        const action =
          retryTabIds.length > 0
            ? { label: "Reconnect failed tabs", onClick: () => get().reconnectFailedRestoreTabs() }
            : undefined;
        toast.info(`Restored ${restored} of ${total} tabs — ${failed} could not reconnect`, {
          id: toastId,
          action,
          // Persist while a bulk retry is offered so the action is not lost to
          // auto-dismiss (matches the "recoverable" feedback pillar).
          duration: action ? Infinity : undefined,
        });
      }
    },
    reconnectFailedRestoreTabs: () => {
      const captured = get().failedRestoreTabIds;
      // Consume the captured set regardless of outcome.
      set({ failedRestoreTabIds: [] });
      if (captured.length === 0) return;
      // Only re-drive tabs that still exist as live terminal tabs.
      const liveTerminalIds = new Set(
        collectLiveTabs(get())
          .filter((t) => t.contentType === "terminal")
          .map((t) => t.id)
      );
      const targets = captured.filter((id) => liveTerminalIds.has(id));
      if (targets.length === 0) return;
      frontendLog(
        "workspace_restore",
        `bulk reconnect: re-driving ${targets.length} failed tab(s)`
      );
      // Pending feedback that resolves into the aggregate cohort summary.
      const toastId = toast.loading(
        `Reconnecting ${targets.length} ${targets.length === 1 ? "tab" : "tabs"}…`
      );
      // Register the fresh cohort before re-driving so each settle lands in it.
      get().beginRestoreCohort(targets, 0, toastId);
      for (const id of targets) {
        get().reconnectTerminal(id);
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
        // Fresh reconnect attempt: arm a new connecting deadline (any prior one
        // was cleared on disconnect) so the wall-clock timeout starts now.
        terminalConnectDeadline: {
          ...state.terminalConnectDeadline,
          [tabId]: { kind: "connecting" as const, at: Date.now() + connectTimeoutMs("connecting") },
        },
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
    agentUpdates: {},
    agentUpdatesDismissed: {},

    setAgentUpdateAvailable: (agentId, update) => {
      set((s) => ({
        agentUpdates: { ...s.agentUpdates, [agentId]: update },
        // A freshly reported update re-arms the banner even if a prior one was
        // dismissed this session.
        agentUpdatesDismissed: { ...s.agentUpdatesDismissed, [agentId]: false },
      }));
    },

    dismissAgentUpdate: (agentId) => {
      set((s) => ({
        agentUpdatesDismissed: { ...s.agentUpdatesDismissed, [agentId]: true },
      }));
    },

    agentUpdatePending: {},

    handleAgentUpdatePending: (agentId, requestedByVersion, estimatedRestartSecs) => {
      // Ignore a duplicate notice for an agent already suspended for this
      // coordinated update — its reconnect is already queued.
      if (get().agentUpdatePending[agentId]) return;

      const agentName = get().remoteAgents.find((a) => a.id === agentId)?.name ?? "Agent";
      const toastId = `agent-update-pending-${agentId}`;

      set((s) => ({
        agentUpdatePending: {
          ...s.agentUpdatePending,
          [agentId]: { requestedByVersion, estimatedRestartSecs, since: Date.now() },
        },
      }));

      // Surface the "being updated by another host" notice. A loading toast is
      // the design system's long-running-work affordance (the "reactive"
      // pillar): it shows the suspend/restart is in progress and resolves in
      // place to success/error when the reconnect settles.
      toast.loading(`${agentName} is being updated by another host…`, {
        id: toastId,
        description: "Sessions are paused briefly and reconnect automatically.",
      });

      // Suspend the connection: disconnecting is the ack the updating host waits
      // for (there is no reply frame — see docs/remote-protocol.md
      // `agent.update_pending`). Sessions live on in detached daemons and are
      // recovered on reconnect, so only the transport goes away here.
      void get().disconnectRemoteAgent(agentId);

      // Queue the auto-reconnect once the agent has had its restart window.
      const delayMs =
        (Math.max(estimatedRestartSecs, 1) + AGENT_UPDATE_RECONNECT_BUFFER_SECS) * 1000;
      setTimeout(() => {
        // Skip if the notice was cleared meanwhile (e.g. a manual reconnect).
        if (!get().agentUpdatePending[agentId]) return;
        get().clearAgentUpdatePending(agentId);
        get()
          .connectRemoteAgent(agentId)
          .then(() => {
            toast.success(`${agentName} reconnected to the updated version.`, {
              id: toastId,
            });
          })
          .catch(() => {
            toast.error(`Couldn't reconnect to ${agentName} after the update.`, {
              id: toastId,
            });
          });
      }, delayMs);
    },

    clearAgentUpdatePending: (agentId) => {
      set((s) => {
        if (!(agentId in s.agentUpdatePending)) return {};
        const next = { ...s.agentUpdatePending };
        delete next[agentId];
        return { agentUpdatePending: next };
      });
    },

    addRemoteAgent: (agent) => {
      set((state) => ({ remoteAgents: [...state.remoteAgents, agent] }));
      persistAgent({
        id: agent.id,
        name: agent.name,
        config: agent.config,
        agentSettings: agent.agentSettings,
      }).catch((err) => {
        console.error("Failed to persist new agent:", err);
        toast.error(
          `Failed to save agent ${agent.name}: ${err instanceof Error ? err.message : String(err)}`
        );
      });
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
      }).catch((err) => {
        console.error("Failed to persist agent update:", err);
        toast.error(
          `Failed to save agent ${agent.name}: ${err instanceof Error ? err.message : String(err)}`
        );
      });
    },

    reorderRemoteAgents: (oldIndex, newIndex) => {
      set((state) => {
        const agents = [...state.remoteAgents];
        const [moved] = agents.splice(oldIndex, 1);
        agents.splice(newIndex, 0, moved);
        return { remoteAgents: agents };
      });
      const agentIds = get().remoteAgents.map((a) => a.id);
      persistAgentOrder(agentIds).catch((err) => {
        console.error("Failed to persist agent reorder:", err);
        toast.error(
          `Failed to save agent order: ${err instanceof Error ? err.message : String(err)}`
        );
      });
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
      removeAgent(agentId).catch((err) => {
        console.error("Failed to persist agent deletion:", err);
        toast.error(
          `Failed to delete agent ${agent?.name ?? ""}: ${err instanceof Error ? err.message : String(err)}`
        );
      });
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

      // Single-writer rule (G4/#1234): `connectionState` is written ONLY by the
      // backend `agent-state-change` event (via `setAgentConnectionState`). This
      // action just kicks off the request and consumes the returned
      // `capabilities` — it writes no `connecting`/`connected`/`disconnected`
      // states. The backend is authoritative for every transition (it emits
      // "connecting" up front and "connected"/"disconnected" on the outcome),
      // so an optimistic write here could clobber a fast drop → "reconnecting"
      // event that arrives before this promise settles.
      try {
        const config: RemoteAgentConfig = { ...agent.config };
        if (password && config.authMethod === "password") {
          config.password = password;
        }
        const result = await apiConnectAgent(agentId, config, agent.agentSettings);

        // Consume capabilities only (no connectionState write). Use a functional
        // update so a state the event set in the meantime is preserved.
        set((s) => ({
          remoteAgents: s.remoteAgents.map((a) =>
            a.id === agentId ? { ...a, capabilities: result.capabilities, isExpanded: true } : a
          ),
        }));

        // The session/definition refresh is owned by the "connected" event
        // (`setAgentConnectionState`), so it runs exactly once per connect and
        // also covers the reconnect path — do not refresh here (de-dup, G4).
      } catch (err) {
        console.error(`Failed to connect agent ${agentId}:`, err);
        // No optimistic "disconnected" write: the backend emits "disconnected"
        // on every connect-failure path, so the event will drive the state.
        throw err;
      }
    },

    disconnectRemoteAgent: async (agentId) => {
      try {
        await apiDisconnectAgent(agentId);
      } catch (err) {
        console.error(`Failed to disconnect agent ${agentId}:`, err);
        toast.error(
          `Failed to disconnect agent: ${err instanceof Error ? err.message : String(err)}`
        );
      }
      set((s) => ({
        remoteAgents: s.remoteAgents.map((a) =>
          a.id === agentId ? { ...a, connectionState: "disconnected" as const } : a
        ),
        agentSessions: { ...s.agentSessions, [agentId]: [] },
        agentFolders: { ...s.agentFolders, [agentId]: [] },
      }));
    },

    shutdownRemoteAgent: async (agentId) => {
      // Unlike disconnect (detach), shutdown stops the remote sessions and then
      // drops the transport. The backend returns how many sessions were
      // detached/killed so the UI can report the impact.
      const detached = await apiShutdownAgent(agentId);
      set((s) => ({
        remoteAgents: s.remoteAgents.map((a) =>
          a.id === agentId ? { ...a, connectionState: "disconnected" as const } : a
        ),
        agentSessions: { ...s.agentSessions, [agentId]: [] },
        agentFolders: { ...s.agentFolders, [agentId]: [] },
      }));
      return detached;
    },

    setAgentConnectionState: (agentId, connectionState, error) => {
      // Single writer for `connectionState` (G4/#1234): only the backend
      // `agent-state-change` event reaches this setter.
      const previous = get().remoteAgents.find((a) => a.id === agentId)?.connectionState;
      // Track the terminal error across auto-reconnect exhaustion (G3/#1236):
      // record it on `disconnected` so the header's Reconnect button can surface
      // it, and clear it once a fresh attempt starts (`connecting`) or succeeds
      // (`connected`). Other transitions leave the stored value untouched.
      const nextLastError = (agent: RemoteAgentDefinition): string | undefined => {
        if (connectionState === "disconnected") return error ?? agent.lastError;
        if (connectionState === "connecting" || connectionState === "connected") return undefined;
        return agent.lastError;
      };
      set((state) => ({
        remoteAgents: state.remoteAgents.map((a) =>
          a.id === agentId ? { ...a, connectionState, lastError: nextLastError(a) } : a
        ),
      }));

      // The refresh of sessions/definitions is owned by the transition INTO
      // "connected" — this is the single, de-duped refresh per connect (G4).
      // Guarding on the previous state keeps a redundant/duplicate "connected"
      // event from triggering a second refresh, and it also covers the
      // reconnect path (reconnecting → connected) which never runs
      // `connectRemoteAgent`.
      if (connectionState === "connected" && previous !== "connected") {
        void get().refreshAgentSessions(agentId);
      }
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
        toast.error(
          `Failed to load agent sessions: ${err instanceof Error ? err.message : String(err)}`
        );
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
        toast.error(
          `Failed to save connection: ${err instanceof Error ? err.message : String(err)}`
        );
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
        toast.error(
          `Failed to delete connection: ${err instanceof Error ? err.message : String(err)}`
        );
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
        toast.error(
          `Failed to update connection: ${err instanceof Error ? err.message : String(err)}`
        );
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
        toast.error(`Failed to delete folder: ${err instanceof Error ? err.message : String(err)}`);
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

    // Monitoring — per-host/session keyed slice (audit gap G6, #1231).
    monitors: {},
    monitoringStatsCache: {},
    sessionCapabilities: {},
    remoteDesktopResolutions: {},

    clearMonitoringError: (key) =>
      set((state) => {
        const entry = state.monitors[key];
        if (!entry || entry.error === null) return {};
        return { monitors: { ...state.monitors, [key]: { ...entry, error: null } } };
      }),

    setSessionCapabilities: (sessionId, caps) =>
      set((state) => ({
        sessionCapabilities: { ...state.sessionCapabilities, [sessionId]: caps },
      })),

    setRemoteDesktopResolution: (sessionId, width, height) =>
      set((state) => {
        const prev = state.remoteDesktopResolutions[sessionId];
        if (prev && prev.width === width && prev.height === height) return {};
        return {
          remoteDesktopResolutions: {
            ...state.remoteDesktopResolutions,
            [sessionId]: { width, height },
          },
        };
      }),

    clearRemoteDesktopResolution: (sessionId) =>
      set((state) => {
        if (!(sessionId in state.remoteDesktopResolutions)) return {};
        return {
          remoteDesktopResolutions: omitKey(state.remoteDesktopResolutions, sessionId),
        };
      }),

    connectMonitoring: async (sessionId: string, host: string | null = null) => {
      const { monitoringStatsCache, monitors } = useAppStore.getState();

      // Unified session-based (push) monitoring: the key is the id of the
      // terminal session that owns the monitor. The backend subscribes the
      // session's `MonitoringProvider` and pushes stats/status as
      // "session-monitoring-stats" / "session-monitoring-status" events (#1232).
      const key = sessionId;
      const cachedStats = monitoringStatsCache[key] ?? null;

      // Preserve a previously-chosen refresh interval across a reconnect so the
      // user's rate selection is not silently reset (#1233).
      const intervalMs = monitors[key]?.intervalMs ?? DEFAULT_MONITORING_INTERVAL_MS;

      // Upsert a fresh loading entry keyed by MonitorKey. monitorSessionId stays
      // null until the backend subscription is established, which the UI reads as
      // "not yet connected".
      upsertMonitor(key, {
        ...emptyMonitor(key, host ?? key),
        stats: cachedStats,
        loading: true,
        status: "connecting",
        intervalMs,
      });

      try {
        // Attach the stats listener; it filters by sessionId and folds fresh
        // samples into this entry + the shared cache.
        const statsUnlisten = await onSessionMonitoringStats((sid, stats) => {
          if (sid !== key) return;
          useAppStore.setState((state) => {
            const entry = state.monitors[key];
            if (!entry) return {};
            return {
              monitors: {
                ...state.monitors,
                [key]: { ...entry, stats, error: null, sampleCount: entry.sampleCount + 1 },
              },
              monitoringStatsCache: { ...state.monitoringStatsCache, [key]: stats },
            };
          });
        });
        _monitoringStatsUnlisten.set(key, statsUnlisten);

        // The status stream flips the indicator to `stale` on a mid-stream
        // drop (and back to `live` on recovery) so frozen stats are never
        // shown as live (#1229, audit gap G1).
        const statusUnlisten = await onSessionMonitoringStatus((sid, status) => {
          if (sid !== key) return;
          useAppStore.setState((state) => {
            const entry = state.monitors[key];
            if (!entry) return {};
            return { monitors: { ...state.monitors, [key]: { ...entry, status } } };
          });
        });
        _monitoringStatusUnlisten.set(key, statusUnlisten);

        await sessionMonitoringOpen(key, intervalMs);
        upsertMonitor(key, { monitorSessionId: key, loading: false, status: "live" });
      } catch (err) {
        // The stats/status listeners are attached before the open that may throw
        // here. Detach them so a failed open never leaks a dangling Tauri
        // listener (monitorSessionId stays null, so disconnectMonitoring would
        // not clean it up either). See audit gap G5.
        frontendLog("monitoring", "detaching monitoring listeners after failed open");
        detachMonitorListeners(key);
        upsertMonitor(key, {
          monitorSessionId: null,
          loading: false,
          error: err instanceof Error ? err.message : String(err),
          status: null,
        });
      }
    },

    disconnectMonitoring: async (key) => {
      // Kill exactly one entry when a key is given, or every entry otherwise
      // (Open Connections "Kill All", global toggle-off).
      const { monitors } = useAppStore.getState();
      const keys = key !== undefined ? [key] : Object.keys(monitors);

      for (const k of keys) {
        const entry = monitors[k];
        if (entry?.monitorSessionId) {
          try {
            await sessionMonitoringClose(entry.monitorSessionId);
          } catch {
            // Ignore close errors — the entry is torn down regardless.
          }
        }
        detachMonitorListeners(k);
      }

      set((state) => {
        const nextMonitors = { ...state.monitors };
        const nextCache = { ...state.monitoringStatsCache };
        for (const k of keys) {
          const entry = state.monitors[k];
          // Preserve last-known stats so the UI can show them instantly on reconnect.
          if (entry?.stats) nextCache[k] = entry.stats;
          delete nextMonitors[k];
        }
        return { monitors: nextMonitors, monitoringStatsCache: nextCache };
      });
    },

    setMonitoringPaused: async (key, paused) => {
      const entry = useAppStore.getState().monitors[key];
      if (!entry) return;
      // Optimistically flag the entry; the backend session loop drives the
      // authoritative `status`, but the flag gates the local UI (neutral badge +
      // dimmed stats) immediately (#1233).
      upsertMonitor(key, { paused, status: paused ? "paused" : "live" });
      if (entry.monitorSessionId) {
        try {
          await sessionMonitoringSetPaused(entry.monitorSessionId, paused);
        } catch (err) {
          frontendLog("monitoring", `set paused failed for ${key}: ${err}`);
          // Roll back the optimistic flag so the UI reflects reality.
          upsertMonitor(key, { paused: !paused });
          throw err;
        }
      }
    },

    setMonitoringInterval: async (key, intervalMs) => {
      const entry = useAppStore.getState().monitors[key];
      if (!entry) return;
      upsertMonitor(key, { intervalMs });
      if (entry.monitorSessionId) {
        try {
          await sessionMonitoringSetInterval(entry.monitorSessionId, intervalMs);
        } catch (err) {
          frontendLog("monitoring", `set interval failed for ${key}: ${err}`);
          throw err;
        }
      }
    },

    cancelMonitoring: async (key) => {
      const entry = useAppStore.getState().monitors[key];
      if (!entry) return;
      // Abort the backend monitor connect (keyed by session id) so a stuck
      // handshake stops promptly (#1233); ignore errors — torn down anyway.
      try {
        await sessionMonitoringCancel(key);
      } catch (err) {
        frontendLog("monitoring", `cancel failed for ${key}: ${err}`);
      }
      // Tear the entry down so the picker / Retry affordance is reachable again.
      await useAppStore.getState().disconnectMonitoring(key);
    },

    // SSH Tunnels
    tunnels: [],
    tunnelStates: {},

    refreshConnectionTypes: async () => {
      try {
        const connectionTypes = await getConnectionTypes();
        set({ connectionTypes });
      } catch (err) {
        console.error("Failed to refresh connection types:", err);
      }
    },

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

    reconnectTunnel: async (tunnelId) => {
      // Force-reconnect a connected tunnel: tear it down and start it again,
      // even if the backend supervisor's liveness has not fired yet — covers a
      // stale-but-green tunnel (#1243). Guarded by the same in-flight sets as
      // start/stop so a rapid double-click cannot overlap the sequence.
      if (_tunnelStartInFlight.has(tunnelId) || _tunnelStopInFlight.has(tunnelId)) return;
      _tunnelStopInFlight.add(tunnelId);
      _tunnelStartInFlight.add(tunnelId);
      const name = get().tunnels.find((t) => t.id === tunnelId)?.name ?? "tunnel";
      const toastId = toast.loading(`Reconnecting ${name}…`);
      try {
        await apiStopTunnel(tunnelId);
        await apiStartTunnel(tunnelId);
        toast.success(`Reconnected ${name}`, { id: toastId });
      } catch (err) {
        console.error("Failed to reconnect tunnel:", err);
        toast.error(
          `Failed to reconnect ${name}: ${err instanceof Error ? err.message : String(err)}`,
          { id: toastId }
        );
        throw err;
      } finally {
        _tunnelStopInFlight.delete(tunnelId);
        _tunnelStartInFlight.delete(tunnelId);
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
        // Propagate the failure so the caller (EmbeddedServerSidebar) can show
        // an error toast — #1427. The server is only removed from the store on
        // success above, so state stays correct on failure. Mirrors
        // saveEmbeddedServer / deleteTunnel.
        frontendLog("embedded_server", `Failed to delete embedded server ${serverId}: ${err}`);
        throw err;
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

    // Macros
    macros: [],

    loadMacros: async () => {
      try {
        const macros = await apiListMacros();
        set({ macros });
      } catch (err) {
        console.error("Failed to load macros:", err);
      }
    },

    saveMacroToBackend: async (macro) => {
      const saved = await apiSaveMacro(macro);
      await get().loadMacros();
      return saved;
    },

    deleteMacroFromBackend: async (macroId) => {
      // Only mutate local state after the backend delete resolves, and rethrow
      // on failure so the caller can surface the error (mirrors workspaces).
      await apiDeleteMacro(macroId);
      set((state) => ({
        macros: state.macros.filter((m) => m.id !== macroId),
      }));
    },

    importMacros: async (json) => {
      // Parse+validate first: a malformed file throws here, before any backend
      // write, so a bad import can never corrupt the existing library (#1677).
      const parsed = parseMacroEnvelope(json);
      const prepared = resolveImportCollisions(parsed, get().macros, generateMacroId);
      for (const macro of prepared) {
        await apiSaveMacro(macro);
      }
      // Refresh once, after all saves, rather than per-macro.
      await get().loadMacros();
      return prepared.length;
    },

    // Macro recording (#1674)
    macroRecording: false,
    macroRecordingSteps: [],
    macroRecordingLastTime: null,
    macroSaveDialogOpen: false,

    startMacroRecording: () => {
      set({
        macroRecording: true,
        macroRecordingSteps: [],
        macroRecordingLastTime: null,
        macroSaveDialogOpen: false,
      });
      toast.info("Recording macro — type in the terminal, then stop to save");
    },

    recordMacroInput: (data) => {
      const state = get();
      if (!state.macroRecording) return;
      const now = Date.now();
      const last = state.macroRecordingLastTime;
      const delayMs = last === null ? 0 : Math.max(0, now - last);
      set({
        macroRecordingSteps: [...state.macroRecordingSteps, { data, delayMs }],
        macroRecordingLastTime: now,
      });
    },

    stopMacroRecording: () => {
      const state = get();
      if (!state.macroRecording) return;
      if (state.macroRecordingSteps.length === 0) {
        // Nothing was typed — discard the empty recording rather than prompting.
        set({
          macroRecording: false,
          macroRecordingLastTime: null,
          macroSaveDialogOpen: false,
        });
        toast.info("No input was recorded");
        return;
      }
      set({
        macroRecording: false,
        macroRecordingLastTime: null,
        macroSaveDialogOpen: true,
      });
    },

    toggleMacroRecording: () => {
      if (get().macroRecording) {
        get().stopMacroRecording();
      } else {
        get().startMacroRecording();
      }
    },

    cancelMacroRecording: () => {
      set({
        macroRecording: false,
        macroRecordingSteps: [],
        macroRecordingLastTime: null,
        macroSaveDialogOpen: false,
      });
      toast.info("Recording discarded");
    },

    saveRecordedMacro: async ({ name, description, tags }) => {
      const steps = get().macroRecordingSteps;
      const macro: Macro = {
        id: generateMacroId(),
        name,
        description,
        tags,
        steps,
        // The backend stamps authoritative created/updated timestamps.
        createdAt: "",
        updatedAt: "",
      };
      try {
        await get().saveMacroToBackend(macro);
        set({
          macroRecordingSteps: [],
          macroRecordingLastTime: null,
          macroSaveDialogOpen: false,
        });
        toast.success(`Saved macro "${name}"`);
      } catch (err) {
        // Keep the dialog open so the user can retry without losing the capture.
        toast.error(`Failed to save macro: ${err instanceof Error ? err.message : String(err)}`);
        throw err;
      }
    },

    discardRecordedMacro: () => {
      set({
        macroRecordingSteps: [],
        macroRecordingLastTime: null,
        macroSaveDialogOpen: false,
      });
    },

    // Macro playback (#1675)
    macroPlayback: null,

    playMacro: async (macroId, opts) => {
      const state = get();
      const macro = state.macros.find((m) => m.id === macroId);
      if (!macro) {
        toast.error("Macro not found");
        return;
      }

      const targetTabId = opts?.targetTabId ?? getActiveTab(state)?.id ?? null;
      if (!targetTabId) {
        toast.error("No active terminal to play the macro into");
        return;
      }

      // Guard: only inject into a connected, non-exited terminal session.
      const tab = collectLiveTabs(state).find((t) => t.id === targetTabId);
      if (
        !tab ||
        tab.contentType !== "terminal" ||
        !tab.sessionId ||
        state.terminalExitedTabs[targetTabId]
      ) {
        toast.error("The target terminal is not connected");
        return;
      }

      if (macro.steps.length === 0) {
        toast.info(`Macro "${macro.name}" has no steps to play`);
        return;
      }

      // Only one playback at a time — cancel any in-flight run first.
      if (activeMacroPlayback) {
        activeMacroPlayback.cancel();
        activeMacroPlayback = null;
      }

      const timingMode = opts?.timingMode ?? "real-time";
      const injector = getTerminalInputInjector();
      const inject: MacroInjector = (data) => {
        if (!injector) return false;
        return injector(targetTabId, data);
      };

      const toastId = `macro-playback-${macroId}-${targetTabId}`;
      const total = macro.steps.length;
      toast.loading(`Playing macro "${macro.name}"…`, {
        id: toastId,
        description: `0 / ${total} steps`,
      });
      set({
        macroPlayback: {
          macroId,
          macroName: macro.name,
          tabId: targetTabId,
          timingMode,
          total,
          played: 0,
        },
      });

      const handle = runMacroPlayback(
        macro.steps,
        inject,
        { timingMode, fixedDelayMs: opts?.fixedDelayMs },
        {
          onProgress: (played, stepTotal) => {
            set((s) =>
              s.macroPlayback &&
              s.macroPlayback.macroId === macroId &&
              s.macroPlayback.tabId === targetTabId
                ? { macroPlayback: { ...s.macroPlayback, played } }
                : {}
            );
            toast.loading(`Playing macro "${macro.name}"…`, {
              id: toastId,
              description: `${played} / ${stepTotal} steps`,
            });
          },
        }
      );
      activeMacroPlayback = handle;

      const result = await handle.done;

      // Only clear shared state when this run is still the current one — a newer
      // playMacro may have replaced it while this one was cancelled.
      if (activeMacroPlayback === handle) {
        activeMacroPlayback = null;
        set({ macroPlayback: null });
      }

      if (result.status === "completed") {
        toast.success(`Played macro "${macro.name}"`, { id: toastId });
      } else if (result.status === "cancelled") {
        toast.info(`Playback of "${macro.name}" cancelled`, {
          id: toastId,
          description: `Stopped after ${result.stepsPlayed} of ${total} steps`,
        });
      } else {
        toast.error(`Could not play "${macro.name}" — the terminal is no longer connected`, {
          id: toastId,
        });
      }
    },

    cancelMacroPlayback: () => {
      if (activeMacroPlayback) {
        activeMacroPlayback.cancel();
      }
    },

    // Workflows (#1852)
    workflows: [],

    loadWorkflows: async () => {
      try {
        const workflows = await apiListWorkflows();
        set({ workflows });
      } catch (err) {
        console.error("Failed to load workflows:", err);
      }
    },

    saveWorkflowToBackend: async (workflow) => {
      const saved = await apiSaveWorkflow(workflow);
      await get().loadWorkflows();
      return saved;
    },

    deleteWorkflowFromBackend: async (workflowId) => {
      await apiDeleteWorkflow(workflowId);
      set((state) => ({
        workflows: state.workflows.filter((w) => w.id !== workflowId),
      }));
    },

    importWorkflows: async (json) => {
      // parseWorkflowEnvelope throws on a malformed/incompatible file; let the
      // error propagate so the caller can surface a recoverable toast.
      const parsed = parseWorkflowEnvelope(json);
      const prepared = resolveWorkflowImportCollisions(parsed, get().workflows, generateWorkflowId);
      for (const workflow of prepared) {
        await apiSaveWorkflow(workflow);
      }
      // Refresh once, after all saves, rather than per-workflow.
      await get().loadWorkflows();
      // Flag any imported run-local-process steps: they are preserved (never
      // stripped) so #1857's run-time guard applies, but they are NOT
      // auto-authorized — the caller surfaces this to the user.
      const { workflowsWithLocalProcess, localProcessSteps } = summarizeLocalProcessSteps(prepared);
      return {
        imported: prepared.length,
        workflowsWithLocalProcess,
        localProcessSteps,
      } satisfies WorkflowImportResult;
    },

    workflowRun: null,

    runWorkflow: async (workflowId, opts) => {
      const state = get();
      const workflow = state.workflows.find((w) => w.id === workflowId);
      if (!workflow) {
        toast.error("Workflow not found");
        return;
      }

      const targetTabId = opts?.targetTabId ?? getActiveTab(state)?.id ?? null;
      if (!targetTabId) {
        toast.error("No active terminal to run the workflow against");
        return;
      }

      // Guard: only run against a connected, non-exited terminal session.
      const tab = collectLiveTabs(state).find((t) => t.id === targetTabId);
      if (
        !tab ||
        tab.contentType !== "terminal" ||
        !tab.sessionId ||
        state.terminalExitedTabs[targetTabId]
      ) {
        toast.error("The target terminal is not connected");
        return;
      }

      if (workflow.steps.length === 0) {
        toast.info(`Workflow "${workflow.name}" has no steps to run`);
        return;
      }

      // Only one run at a time — cancel any in-flight run first.
      if (activeWorkflowRun) {
        activeWorkflowRun.cancel();
        activeWorkflowRun = null;
      }

      // The workflow runner reuses the macro `send_input` injector seam, bound to
      // the target tab, so send-based steps (send-command, run-script) route
      // through the single choke point.
      const injector = getTerminalInputInjector();
      const send: WorkflowSendSeam = (data) => {
        if (!injector) return false;
        return injector(targetTabId, data);
      };

      // A `run-macro` step replays a stored macro by id through the macro-playback
      // service, into the same target tab, reusing the macro's recorded timing.
      const runMacro: WorkflowRunMacroSeam = async (macroId) => {
        if (!injector) return false;
        const macro = get().macros.find((m) => m.id === macroId);
        if (!macro || macro.steps.length === 0) return false;
        const macroHandle = runMacroPlayback(macro.steps, (data) => injector(targetTabId, data), {
          timingMode: "real-time",
        });
        const macroResult = await macroHandle.done;
        return macroResult.status === "completed";
      };

      // The authorization gate for a `run-local-process` step (#1857). Fails
      // closed: unless the user has opted in AND authorized this specific
      // program (allowlist hit or an interactive confirmation), it returns
      // false and the step never spawns. An imported workflow's step is never
      // pre-authorized — the program is not on the allowlist and the master
      // opt-in defaults off, so it lands here and is gated exactly like any
      // other untrusted program.
      const authorizeLocalProcess: WorkflowAuthorizeLocalProcessSeam = async (program, args) => {
        const settings = get().settings;
        if (!settings.workflowLocalProcessEnabled) {
          toast.error("Local process execution is disabled", {
            description:
              "Enable it in Settings → Security before this workflow can run a local program.",
          });
          return false;
        }
        const allowlist = settings.workflowLocalProcessAllowlist ?? [];
        if (allowlist.includes(program)) return true;

        // Not yet trusted — ask the user, once, via the confirmation dialog.
        const decision = await new Promise<LocalProcessAuthDecision>((resolve) => {
          set({
            localProcessPrompt: { program, args, workflowName: workflow.name, resolve },
          });
        });
        set({ localProcessPrompt: null });

        if (decision === "cancel") return false;
        if (decision === "always") {
          const current = get().settings;
          const nextAllowlist = [...(current.workflowLocalProcessAllowlist ?? [])];
          if (!nextAllowlist.includes(program)) nextAllowlist.push(program);
          await get().updateSettings({
            ...current,
            workflowLocalProcessAllowlist: nextAllowlist,
          });
        }
        return true;
      };

      // Spawn an authorized local process through the guarded backend command,
      // streaming its output into the LogViewer (the app's observable surface)
      // and forwarding a cancel from the run's signal to the backend.
      const runLocalProcess: WorkflowRunLocalProcessSeam = async (program, args, options) => {
        const runId = `wf-lp-${workflowId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        frontendLog("workflow", `local process starting: ${[program, ...args].join(" ")}`);

        // Open the inline run-output surface for this spawn (#1865). A fresh
        // spawn owns the panel — its program/args and a clean line buffer — so a
        // second run-local-process step shows its own process, not the prior one.
        let lineSeq = 0;
        set({
          workflowRunOutput: {
            workflowId,
            workflowName: workflow.name,
            program,
            args,
            lines: [],
            status: "running",
            exitCode: null,
            timedOut: false,
          },
        });

        // Reuse the exact streamed-output events #1857 already emits (keyed by
        // run id): each line lands in the LogViewer AND the inline surface.
        const unlisten = await subscribeLocalProcessOutput(runId, (chunk) => {
          frontendLog("workflow", `[${chunk.stream}] ${chunk.line}`);
          const nextLine: WorkflowRunOutputLine = {
            id: lineSeq++,
            stream: chunk.stream,
            text: chunk.line,
          };
          set((s) => {
            if (!s.workflowRunOutput) return {};
            const lines = [...s.workflowRunOutput.lines, nextLine];
            // Keep only the most recent lines so a chatty process stays bounded.
            const trimmed =
              lines.length > WORKFLOW_RUN_OUTPUT_MAX_LINES
                ? lines.slice(lines.length - WORKFLOW_RUN_OUTPUT_MAX_LINES)
                : lines;
            return { workflowRunOutput: { ...s.workflowRunOutput, lines: trimmed } };
          });
        });
        // Poll the run's cancel signal and forward it to the backend so a
        // long-running process is killed when the run is cancelled.
        const poll = window.setInterval(() => {
          if (options.signal?.isCancelled()) {
            void cancelLocalProcess(runId);
          }
        }, LOCAL_PROCESS_CANCEL_POLL_MS);

        try {
          const outcome = await invokeRunLocalProcess({
            runId,
            program,
            args,
            timeoutMs: LOCAL_PROCESS_TIMEOUT_MS,
          });
          frontendLog(
            "workflow",
            `local process finished: exitCode=${outcome.exitCode ?? "null"} ` +
              `timedOut=${outcome.timedOut} cancelled=${outcome.cancelled}`
          );
          // Record the process outcome on the inline surface. The overall run
          // status (completed / cancelled / failed) is stamped once the run
          // resolves; here we surface only the raw exit code / timeout (#1865).
          set((s) =>
            s.workflowRunOutput
              ? {
                  workflowRunOutput: {
                    ...s.workflowRunOutput,
                    exitCode: outcome.exitCode,
                    timedOut: outcome.timedOut,
                  },
                }
              : {}
          );
          return outcome;
        } catch (err) {
          // A backend rejection (e.g. opt-in disabled at the trust boundary)
          // surfaces as a failed step rather than crashing the run.
          const message = err instanceof Error ? err.message : String(err);
          frontendLog("workflow", `local process error: ${message}`);
          set((s) =>
            s.workflowRunOutput
              ? { workflowRunOutput: { ...s.workflowRunOutput, exitCode: 1, timedOut: false } }
              : {}
          );
          return { exitCode: 1, timedOut: false, cancelled: false };
        } finally {
          window.clearInterval(poll);
          unlisten();
        }
      };

      const toastId = `workflow-run-${workflowId}-${targetTabId}`;
      const total = workflow.steps.length;
      toast.loading(`Running workflow "${workflow.name}"…`, {
        id: toastId,
        description: `0 / ${total} steps`,
      });
      set({
        workflowRun: {
          workflowId,
          workflowName: workflow.name,
          tabId: targetTabId,
          total,
          completed: 0,
        },
        // Clear any prior run's output panel when a fresh run starts; it is
        // recreated lazily only if this run spawns a local process (#1865).
        workflowRunOutput: null,
      });

      const handle = runWorkflowSteps(
        workflow.steps,
        { send, runMacro, readScriptFile: localReadFile, authorizeLocalProcess, runLocalProcess },
        {
          onProgress: (completed, stepTotal) => {
            set((s) =>
              s.workflowRun &&
              s.workflowRun.workflowId === workflowId &&
              s.workflowRun.tabId === targetTabId
                ? { workflowRun: { ...s.workflowRun, completed } }
                : {}
            );
            toast.loading(`Running workflow "${workflow.name}"…`, {
              id: toastId,
              description: `${completed} / ${stepTotal} steps`,
            });
          },
        }
      );
      activeWorkflowRun = handle;

      const result = await handle.done;

      // Only clear shared state when this run is still the current one — a newer
      // runWorkflow may have replaced it while this one was cancelled.
      if (activeWorkflowRun === handle) {
        activeWorkflowRun = null;
        set((s) => ({
          workflowRun: null,
          // Stamp the run's terminal status onto the inline surface so its exit
          // outcome stays visible after the run ends (#1865). Left untouched when
          // no local process ran (surface is null).
          workflowRunOutput: s.workflowRunOutput
            ? {
                ...s.workflowRunOutput,
                status: result.status,
                error: result.status === "failed" ? result.error : undefined,
              }
            : null,
        }));
      }

      if (result.status === "completed") {
        toast.success(`Ran workflow "${workflow.name}"`, { id: toastId });
      } else if (result.status === "cancelled") {
        toast.info(`Workflow "${workflow.name}" cancelled`, {
          id: toastId,
          description: `Stopped after ${result.stepsCompleted} of ${total} steps`,
        });
      } else {
        const stepNumber = (result.failedStepIndex ?? result.stepsCompleted) + 1;
        toast.error(`Workflow "${workflow.name}" failed at step ${stepNumber}`, {
          id: toastId,
          description: result.error,
        });
      }
    },

    cancelWorkflowRun: () => {
      if (activeWorkflowRun) {
        activeWorkflowRun.cancel();
      }
    },

    workflowRunOutput: null,
    dismissWorkflowRunOutput: () => {
      set({ workflowRunOutput: null });
    },

    localProcessPrompt: null,
    resolveLocalProcessPrompt: (decision) => {
      const prompt = get().localProcessPrompt;
      if (!prompt) return;
      // Clear first so a second click cannot double-resolve the promise.
      set({ localProcessPrompt: null });
      prompt.resolve(decision);
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
        toast.success("Duplicated workspace");
      } catch (err) {
        console.error("Failed to duplicate workspace:", err);
        toast.error(
          `Failed to duplicate workspace: ${err instanceof Error ? err.message : String(err)}`
        );
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
        //
        // `connectRemoteAgent` no longer writes `connectionState` or refreshes
        // sessions (single-writer rule, G4/#1234) — those now flow through the
        // async `agent-state-change` event, which may not have landed by the
        // time this returns. This restore path builds the layout synchronously,
        // so it tracks which agents connected (the request resolved) and drives
        // the build off that set rather than the not-yet-updated store state.
        const justConnectedAgentIds = new Set<string>();
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
                justConnectedAgentIds.add(agent.id);
              } catch {
                // Connection failure is surfaced as agent-error tabs below
              }
            })
          );
          // Populate sessions/definitions for the agents we just connected so
          // buildTabGroupsFromWorkspace can resolve their tabs now — the
          // event-driven refresh is fire-and-forget and may not have run yet.
          await Promise.all([...justConnectedAgentIds].map((id) => get().refreshAgentSessions(id)));
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

        // Re-read agent state so newly-connected agents are reflected in tab
        // resolution. Agents we connected in this pass are treated as connected
        // even if their `agent-state-change` "connected" event has not yet
        // updated the store (single-writer rule, G4/#1234): a resolved connect
        // request means the backend is connected.
        const freshState = get();
        const agentContext = {
          agents: freshState.remoteAgents.map((a) => ({
            id: a.id,
            name: a.name,
            connected: a.connectionState === "connected" || justConnectedAgentIds.has(a.id),
          })),
          definitions: freshState.agentDefinitions,
        };

        // Window dimension (#1925): spawn + hydrate the workspace's saved
        // secondary windows and build only the main window's groups here. A
        // legacy single-window workspace spawns nothing and builds every group.
        const plan = planWindowRestore(definition.tabGroups, definition.windows);
        const mainGroups = await restoreWindowedLayout(plan);
        const builtGroups = buildTabGroupsFromWorkspace(
          mainGroups,
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
        // GAP G4 (#1146): register the placed tabs as a cohort so a single
        // summary toast fires once every tab has connected or failed.
        const { pendingTabIds, preFailedCount } = collectRestoreCohort(builtGroups);
        get().beginRestoreCohort(pendingTabIds, preFailedCount);
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
        // "active" scope saves only this window's active group — inherently a
        // single-window layout, so stamp it directly (legacy shape when it is the
        // main window). Full scope aggregates every open window (#1905/#1925) so a
        // saved multi-window layout restores its window arrangement.
        let stampedGroups: WorkspaceTabGroupDef[];
        let windows: WorkspaceWindowDef[] | undefined;
        if (scope === "active" && activeGroup) {
          const tabGroups = captureAllTabGroups(
            [activeGroup],
            state.activeTabGroupId,
            state.rootPanel,
            state.connections
          );
          stampedGroups = stampWindowId(tabGroups, currentWindowLabel());
          windows = buildWindowsMeta(stampedGroups);
        } else {
          const tabGroups = captureAllTabGroups(
            state.tabGroups,
            state.activeTabGroupId,
            state.rootPanel,
            state.connections
          );
          const activeGroupIndex = Math.max(
            0,
            state.tabGroups.findIndex((g) => g.id === state.activeTabGroupId)
          );
          ({ tabGroups: stampedGroups, windows } = await captureAllWindows(
            tabGroups,
            activeGroupIndex
          ));
        }
        const id = `ws-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        await apiSaveWorkspace({
          id,
          name,
          description,
          tabGroups: stampedGroups,
          ...(windows ? { windows } : {}),
        });
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
      // "never" means the user does not want a session kept, so skip the write.
      if (resolveRestoreMode(state.settings) === "never") return;
      const ownGroups = captureAllTabGroups(
        state.tabGroups,
        state.activeTabGroupId,
        state.rootPanel,
        state.connections
      );
      const activeGroupIndex = Math.max(
        0,
        state.tabGroups.findIndex((g) => g.id === state.activeTabGroupId)
      );
      // Window dimension (#1905/#1925): aggregate every open window's reported
      // layout slice into one windowId-stamped document so a multi-window session
      // restores its window arrangement. This also refreshes the main window's own
      // slice in the backend authority. Falls back to this window's groups only if
      // aggregation is unavailable — a single-window app then produces the
      // byte-identical legacy shape (no windowId, no windows set).
      const { tabGroups: stampedGroups, windows } = await captureAllWindows(
        ownGroups,
        activeGroupIndex
      );
      // Only persist when there is at least one real tab to restore across every
      // window. An empty payload tells the backend to clear the stored session.
      const totalTabs = stampedGroups.reduce(
        (n, g) => n + getWorkspaceLeaves(g.layout).reduce((m, leaf) => m + leaf.tabs.length, 0),
        0
      );
      try {
        await apiSaveLastSession({
          version: "1",
          tabGroups: totalTabs > 0 ? stampedGroups : [],
          activeGroupIndex,
          ...(totalTabs > 0 && windows ? { windows } : {}),
        });
      } catch (err) {
        console.error("Failed to save last session:", err);
        // Auto-save fires on every layout change (debounced); use a stable id so
        // repeated failures collapse into a single, replaceable toast.
        toast.error(`Failed to save session: ${err instanceof Error ? err.message : String(err)}`, {
          id: "last-session-save-error",
        });
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

    restoreLastSession: async (selectedIndices) => {
      try {
        const loaded = await apiLoadLastSession();
        if (!loaded || loaded.tabGroups.length === 0) return false;
        // Partial restore (#1931): prune the stored session to the tabs the user
        // checked before building anything. An empty selection restores nothing.
        const session = selectedIndices
          ? filterSessionBySelection(loaded, new Set(selectedIndices))
          : loaded;
        if (session.tabGroups.length === 0) return false;
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
        // Window dimension (#1925): partition the saved groups by window, spawn +
        // hydrate the saved secondary windows, and build only the main window's
        // groups into THIS window. A legacy session has a single main entry, so
        // this spawns nothing and restores every group here (back-compat path).
        const plan = planWindowRestore(session.tabGroups, session.windows);
        if (hasWindowDimension(session.tabGroups, session.windows)) {
          frontendLog("multi_window", `restoreLastSession: restoring ${plan.length} saved windows`);
        }
        const orderedGroups = await restoreWindowedLayout(plan);
        const builtGroups = buildTabGroupsFromWorkspace(
          orderedGroups,
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
        // GAP G4 (#1146): register the placed tabs as a cohort so a single
        // summary toast fires once every tab has connected or failed.
        const { pendingTabIds, preFailedCount } = collectRestoreCohort(builtGroups);
        get().beginRestoreCohort(pendingTabIds, preFailedCount);
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
        toast.error(
          `Failed to clear saved session: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    },

    restorePrompt: null,

    promptRestore: async () => {
      try {
        const session = await apiLoadLastSession();
        if (!session || session.tabGroups.length === 0) return;
        // Pass loaded connections so `connectionRef` tabs resolve a host/serial
        // target for the reachability probe (connections are loaded before this
        // runs at startup).
        const summary = summarizeLastSession(session, get().connections);
        // Nothing launchable → treat as "no session" and stay silent.
        if (summary.tabCount === 0) return;
        set({ restorePrompt: summary });
        // Probe each target's reachability in the background and patch the
        // prompt so the dialog can flag unavailable tabs (#1931).
        void probeRestorePromptReachability(summary, get, set);
      } catch (err) {
        // A corrupt/failed load must not wedge startup — surface it like a
        // failed restore and start fresh.
        frontendLog("workspace", `Failed to load last session for prompt: ${String(err)}`);
        toast.error("Could not load previous session");
      }
    },

    confirmRestorePrompt: async (remember, selectedIndices) => {
      const state = get();
      if (remember) {
        await state.updateSettings({
          ...state.settings,
          restoreLastSessionMode: "always",
        });
      }
      set({ restorePrompt: null });
      await get().restoreLastSession(selectedIndices);
    },

    dismissRestorePrompt: async (remember) => {
      const state = get();
      if (remember) {
        await state.updateSettings({
          ...state.settings,
          restoreLastSessionMode: "never",
        });
      }
      set({ restorePrompt: null });
      await get().clearLastSession();
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
