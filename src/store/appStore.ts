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
  PluginDetailMeta,
  NetworkTool,
  TabGroup,
  TerminalExitInfo,
  TerminalAutoReconnectState,
  SessionCloseConfirmRequest,
  BroadcastScope,
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
import { deriveTabStatus, type TabStatusMaps } from "@/utils/tabStatus";
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
  listSessionOwners,
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
import { createTunnelSlice, TunnelSlice } from "./slices/tunnelSlice";
import { createEmbeddedServersSlice, EmbeddedServersSlice } from "./slices/embedded-serversSlice";
import { createMacrosSlice, MacrosSlice } from "./slices/macrosSlice";
import { createPluginsSlice, PluginsSlice } from "./slices/pluginsSlice";
import { createSessionHistorySlice, SessionHistorySlice } from "./slices/sessionHistorySlice";
import { createZoomSlice, ZoomSlice } from "./slices/zoomSlice";
import { createCommandPaletteSlice, CommandPaletteSlice } from "./slices/commandPaletteSlice";

export type { MacroPlaybackState, PlayMacroOptions } from "./slices/macrosSlice";
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
import { runMacroPlayback, getTerminalInputInjector } from "@/services/macroPlayback";
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
import {
  DEFAULT_BACKOFF,
  initialReconnectState,
  reconnectReducer,
  type BackoffConfig,
  type ReconnectPhase,
} from "@/utils/reconnectBackoff";
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
  normalizeSizes,
} from "@/utils/panelTree";
import {
  layoutIntentsEnabled,
  logBridgeFallback,
  moveTabPayload,
  runLayoutIntent,
} from "@/store/layoutBridge";
import {
  ensureSessionSubscribed,
  logSessionBridgeFallback,
  mirrorSessionIntent,
  onSessionView,
  sessionIntentsEnabled,
  type SessionIntentKind,
} from "@/store/sessionBridge";
import { mirrorMonitorIntent } from "@/store/systemMonitorBridge";
import { mirrorAgentIntent } from "@/store/agentsBridge";
import { mirrorConnectionIntent } from "@/store/connectionsBridge";
import { mirrorFileBrowserIntent } from "@/store/fileBrowsersBridge";
import { mirrorTransferIntent } from "@/store/transfersBridge";
import { mirrorSettingsIntent } from "@/store/settingsBridge";
import { mirrorBroadcastIntent } from "@/store/broadcastBridge";
import {
  expectProjectedRestoreSettlement,
  mirrorRestoreBegin,
  mirrorRestoreSettle,
  restoreRenderFromProjectionEnabled,
} from "@/store/restoreCohortBridge";
import {
  mirrorWorkflowDismissOutput,
  mirrorWorkflowOutputOpened,
  mirrorWorkflowRunSettled,
  mirrorWorkflowRunStarted,
  mirrorWorkflowStepAdvanced,
} from "@/store/workflowRunBridge";

export type SidebarView =
  | "connections"
  | "files"
  | "tunnels"
  | "services"
  | "workspaces"
  | "macros"
  | "workflows"
  | "network-tools"
  | "recent-sessions"
  | "plugins";

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

export interface AppState
  extends
    TunnelSlice,
    EmbeddedServersSlice,
    MacrosSlice,
    PluginsSlice,
    SessionHistorySlice,
    ZoomSlice,
    CommandPaletteSlice {
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
  /**
   * Open (or focus the existing) Settings tab. An optional `target` deep-links
   * into a specific category — and, for the Plugins category, an optional plugin
   * to scroll to and highlight (#2000). The target is consumed once by the
   * settings panel via {@link pendingSettingsCategory}/{@link
   * pendingSettingsPluginId}; passing none leaves the current category alone.
   */
  openSettingsTab: (target?: { category?: string; pluginId?: string }) => void;
  /**
   * Category the Settings panel should switch to when it next reads this, or
   * `null` for no pending navigation. Set by {@link openSettingsTab} and cleared
   * by the panel after it applies (#2000).
   */
  pendingSettingsCategory: string | null;
  /**
   * Plugin the Plugins settings section should scroll to and highlight when it
   * next reads this, or `null`. Set by {@link openSettingsTab} and cleared by the
   * panel after it applies (#2000).
   */
  pendingSettingsPluginId: string | null;
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
  setPanelSizes: (splitId: string, sizes: number[]) => void;
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
  /**
   * Session ids whose Transfer Queue rows this window handed off to another
   * window (#1951). While a session id is in this set, this window's transfer
   * folds ({@link applyTransferProgress}, {@link applyTransferProgressToQueue})
   * ignore its broadcast `transfer-progress` events, so a moved-away transfer is
   * not re-adopted into the source window's queue. Cleared for a session when it
   * is hydrated back in ({@link hydrateHandoffTab}) or a new local transfer is
   * seeded for it ({@link seedTransferQueue}).
   */
  releasedTransferSessions: string[];
  /**
   * This window's runtime label (`main`, `win-1`, …), captured once at store
   * creation. Used to scope transfer folds to the owning window (#1964): a
   * broadcast `transfer-progress` event is folded only when this window owns the
   * transfer's session. Falls back to {@link MAIN_WINDOW_LABEL} outside Tauri.
   */
  windowLabel: string;
  /**
   * Local mirror of the backend `session_id → owning_window` map (#1900),
   * refreshed while transfers are active (#1964). Gates the transfer folds
   * ({@link applyTransferProgress}, {@link applyTransferProgressToQueue}) so a
   * transfer is shown only in the window that owns its session — even without a
   * tab move (which #1951 already handled via {@link releasedTransferSessions}).
   * A session absent from the map is unclaimed (background/spawned, or not yet
   * claimed) and folds everywhere as a safe fallback.
   */
  sessionOwners: Record<string, string>;
  /**
   * Replace {@link sessionOwners} with a fresh snapshot and drop any transient
   * {@link transfers} / persistent {@link transferQueue} rows for sessions now
   * owned by a *different* window (#1964). Rows for sessions this window renders
   * locally are always kept, so a stale snapshot can never evict a live row.
   */
  setSessionOwners: (owners: Record<string, string>) => void;
  /**
   * Refetch the backend ownership map into {@link sessionOwners} (#1964).
   * Best-effort (a failed refetch keeps the previous map). Callers that fire it
   * on high-frequency events (e.g. `transfer-progress`) should coalesce — see
   * {@link useTransferEvents}.
   */
  refreshSessionOwners: () => Promise<void>;
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

  // Shortcuts overlay + command palette + standalone overlay views (updates,
  // about) — runtime-only open/close flags provided by CommandPaletteSlice
  // (extracted under #2077 via #2300).

  // Panel zoom overlay (runtime-only) — temporarily expand the active terminal tab to full view
  zoomedTabId: string | null;
  setZoomedTabId: (tabId: string | null) => void;
  /** Toggle zoom for the active terminal tab. Zooms in if nothing is zoomed; dismisses otherwise. */
  toggleZoomActiveTab: () => void;

  // Chord pending indicator
  chordPending: string | null;
  setChordPending: (pending: string | null) => void;

  // Zoom (runtime-only) — scale factor + in/out/reset provided by ZoomSlice
  // (extracted under #2077 via #2300).

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

  // Session history — data + load/record/pin/promote/remove/clear live in
  // SessionHistorySlice (#1883, extracted under #2077).
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
   * Agentless resilient-reconnect loop state per tab (#1962). Present only while
   * a plain-SSH tab that opted in is auto-reconnecting after a dropped link.
   * Drives the auto-reconnect overlay's countdown/attempt display and the Cancel
   * affordance; the actual backoff timer lives at module scope
   * (`autoReconnectTimers`). Cleared on success, give-up, cancel, or tab close.
   */
  terminalAutoReconnect: Record<string, TerminalAutoReconnectState>;
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

  /**
   * Begin the agentless resilient-reconnect loop for a dropped plain-SSH tab
   * that opted in (#1962). Arms an exponential-backoff timer that re-drives the
   * tab through {@link reconnectTerminal}; a failed attempt backs off further and
   * a success settles the loop. Called from {@link setTerminalExited} on a
   * `dropped` exit — not usually invoked directly. No-op if already looping.
   */
  startAutoReconnect: (tabId: string) => void;
  /**
   * Stop (give up) the resilient-reconnect loop for a tab (#1962) — the Cancel
   * affordance and the exhausted-attempts path. Clears the backoff timer and the
   * loop state and leaves the tab in the standard "disconnected" overlay so the
   * user can manually reconnect or browse scrollback. `error`, when given, shows
   * the "Reconnect failed" overlay variant with that message.
   */
  cancelAutoReconnect: (tabId: string, error?: string) => void;

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

  // SSH Tunnels — tunnel data + lifecycle live in TunnelSlice (#2077); the
  // tab-opening action stays here as it belongs to the panel/tab domain.
  openTunnelEditorTab: (tunnelId: string | null) => void;

  // Embedded Servers — data + lifecycle live in EmbeddedServersSlice (#2113).

  // Macros — library + recording + playback live in MacrosSlice (#2114).

  // Plugins — installed-plugin list, derived backend/theme registries, and the
  // load/install/enable/disable/settings actions live in PluginsSlice (#2115).
  // `selectPlugin` stays here: it opens the plugin-detail tab via the root
  // store's `createTab` factory and moves with the panel/tab slice when that
  // domain is extracted (same caveat as `openTunnelEditorTab`).
  /**
   * Select a plugin in the Plugins sidebar: records {@link selectedPluginId} and
   * opens (or updates, and focuses) the single plugin-detail tab in the main area.
   */
  selectPlugin: (pluginId: string) => void;

  // Macro recording (#1674) + playback (#1675) — provided by MacrosSlice (#2114).

  // Broadcast input (#1955) — mirror typed input from a source terminal to many.
  /** Whether broadcast mode is currently active. */
  broadcastActive: boolean;
  /** The tab ID of the source terminal (where the user types). */
  broadcastSourceTabId: string | null;
  /** The scope used for the current broadcast session. */
  broadcastScope: BroadcastScope;
  /** Set of tab IDs that are broadcast targets (includes the source). */
  broadcastTargetTabIds: Set<string>;
  /** Last used scope, retained for the keyboard-shortcut toggle (#1958). */
  lastBroadcastScope: BroadcastScope;
  /** Enter broadcast mode with the given scope, source tab, and target tabs. */
  startBroadcast: (scope: BroadcastScope, sourceTabId: string, targetTabIds: string[]) => void;
  /** Leave broadcast mode and clear the source/target selection. */
  stopBroadcast: () => void;
  /**
   * Toggle broadcast from the keyboard shortcut (#1958). When broadcast is
   * active it stops; otherwise it starts against the active terminal tab using
   * the remembered {@link lastBroadcastScope} — skipping the scope dropdown. A
   * remembered `"custom"` scope cannot be reconstructed without the picker, so
   * the shortcut falls back to `"all"`. Emits a hint toast when no terminal tab
   * is focused (nothing to broadcast from).
   */
  toggleBroadcast: () => void;
  /** Add a tab to the broadcast target set (no-op when inactive). */
  addBroadcastTarget: (tabId: string) => void;
  /** Remove a tab from the broadcast target set. */
  removeBroadcastTarget: (tabId: string) => void;
  /** Whether the given tab is currently a broadcast target. */
  isBroadcastTarget: (tabId: string) => boolean;
  /**
   * The subset of {@link broadcastTargetTabIds} that are *connected* terminal
   * tabs — the tabs the `onData` fan-out should mirror input to. Disconnected,
   * connecting, and non-terminal tabs are filtered out silently. Returns `[]`
   * when broadcast is inactive. Resolution of each tab id to a live session id
   * is done by the terminal registry at the dispatch seam.
   */
  getBroadcastTargetTabIds: () => string[];
  /**
   * Recompute the broadcast target set for the active {@link broadcastScope} so
   * membership tracks tabs opening during an active broadcast (#1956). No-op
   * when inactive.
   *
   * - `"all"` / `"panel"` — re-derive members from the scope, so a terminal
   *   opened in range is auto-added and one no longer in range drops out.
   * - `"custom"` — never auto-adds; the explicit selection is authoritative
   *   (closed tabs are pruned at the tab-close seam). No-op here.
   *
   * Closing a target is handled at the tab-close seam for every scope, so this
   * only needs to run on tab open.
   */
  refreshBroadcastMembership: () => void;

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
 * The aggregate restore/launch summary toast — the render surface of the
 * restore-cohort machine (#1146 / #1227). Extracted so the local reducer path and
 * the projection-driven render cut ({@link restoreCohortBridge}) fire byte-identical
 * feedback: a success toast when every tab connected, otherwise the partial-failure
 * info toast carrying the one-tap bulk "Reconnect failed tabs" action (persisted
 * while offered so it is not lost to auto-dismiss). `retryTabIds` is the live
 * terminal tabs still available to retry; `onReconnect` re-drives them.
 */
function raiseRestoreSummary(
  summary: { total: number; restored: number; failed: number; toastId?: string | number },
  retryTabIds: string[],
  onReconnect: () => void
): void {
  const { total, restored, failed, toastId } = summary;
  if (failed === 0) {
    // Resolve the pending bulk-retry toast in place when present.
    toast.success(`Restored ${total} ${total === 1 ? "tab" : "tabs"}`, { id: toastId });
    return;
  }
  // No toast.warning primitive — use info for the partial-failure case. Offer a
  // one-tap bulk retry when there are reconnectable failed tabs.
  const action =
    retryTabIds.length > 0 ? { label: "Reconnect failed tabs", onClick: onReconnect } : undefined;
  toast.info(`Restored ${restored} of ${total} tabs — ${failed} could not reconnect`, {
    id: toastId,
    action,
    // Persist while a bulk retry is offered so the action is not lost to
    // auto-dismiss (matches the "recoverable" feedback pillar).
    duration: action ? Infinity : undefined,
  });
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
export function collectLiveTabs(state: {
  tabGroups: TabGroup[];
  activeTabGroupId: string;
  rootPanel: PanelNode;
}): TerminalTab[] {
  const trees = state.tabGroups.map((g) =>
    g.id === state.activeTabGroupId ? state.rootPanel : g.rootPanel
  );
  return trees.flatMap((tree) => getAllLeaves(tree).flatMap((leaf) => leaf.tabs));
}

// ── Agentless auto-reconnect (#1962) ────────────────────────────────────────
//
// Backoff timers for the resilient-reconnect loop, keyed by tab id. Kept at
// module scope (not in the store) because a `setTimeout` handle is an imperative
// resource, not serializable UI state — the store holds only the *display* state
// (phase/attempt/countdown) in `terminalAutoReconnect`. Every arm clears the
// prior handle first so a tab never has two live timers.
const autoReconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Cancel and forget the pending backoff timer for a tab, if any. */
function clearAutoReconnectTimer(tabId: string): void {
  const handle = autoReconnectTimers.get(tabId);
  if (handle !== undefined) {
    clearTimeout(handle);
    autoReconnectTimers.delete(tabId);
  }
}

/** The backoff schedule for the resilient-reconnect loop. Central so tests and UI agree. */
const autoReconnectConfig: BackoffConfig = DEFAULT_BACKOFF;

/**
 * Whether a tab is eligible for agentless resilient reconnect (#1962): a plain
 * SSH terminal whose saved connection opted in via the "Resilient Reconnect"
 * setting, and which is NOT agent-backed or a persistent session (those have
 * their own continuity machinery). Reads the opt-in from the tab's connection
 * config, where the SSH schema field persists it.
 */
function isResilientReconnectTab(tab: TerminalTab | undefined): boolean {
  if (!tab) return false;
  if (tab.contentType !== "terminal") return false;
  if (tab.connectionType !== "ssh") return false;
  if (tab.persistentConnectionId) return false;
  const cfg = tab.config?.config as { resilientReconnect?: unknown; agentId?: unknown } | undefined;
  if (!cfg) return false;
  if (cfg.agentId) return false;
  return cfg.resilientReconnect === true;
}

/**
 * The trimmed on-reconnect command configured for a tab's connection (#1978), or
 * `undefined` when none is set. This is the command run once in the fresh remote
 * shell after a *successful* automatic reconnect to recover some server-side
 * context (e.g. `tmux attach`) that an agentless reconnect otherwise loses.
 * Empty/whitespace-only values are treated as "no command".
 */
function onReconnectCommandForTab(tab: TerminalTab | undefined): string | undefined {
  if (!tab) return undefined;
  const cfg = tab.config?.config as { onReconnectCommand?: unknown } | undefined;
  const raw = cfg?.onReconnectCommand;
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Find a terminal tab by id across the active panel tree (#1978 helper). Used by
 * the auto-reconnect loop to read a tab's live connection config when settling.
 */
function findTabById(tabId: string): TerminalTab | undefined {
  return getAllLeaves(useAppStore.getState().rootPanel)
    .flatMap((l) => l.tabs)
    .find((t) => t.id === tabId);
}

/**
 * Send the configured on-reconnect command once into a tab after its resilient
 * reconnect settled (#1978). Routes through the shared terminal-input injector —
 * the same `send_input` choke point interactive typing and macros use — so the
 * command is delivered to the fresh remote shell exactly as if typed, with a
 * trailing newline to execute it. A missing command or absent injector is a
 * silent no-op; delivery failures are logged, never thrown.
 */
function runOnReconnectCommand(tabId: string): void {
  const command = onReconnectCommandForTab(findTabById(tabId));
  if (!command) return;
  const injector = getTerminalInputInjector();
  if (!injector) {
    frontendLog(
      "disconnect",
      `auto-reconnect tab=${tabId}: on-reconnect command skipped (no injector)`
    );
    return;
  }
  void Promise.resolve(injector(tabId, command + "\n"))
    .then((delivered) => {
      frontendLog(
        "disconnect",
        `auto-reconnect tab=${tabId}: on-reconnect command ${delivered ? "sent" : "not delivered"}`
      );
    })
    .catch(() => {
      frontendLog("disconnect", `auto-reconnect tab=${tabId}: on-reconnect command failed`);
    });
}

/**
 * Map an auto-reconnect loop event to the `session.*` intent that drives the
 * same transition in the backend `SessionLifecycleStore` (#2203). When the
 * session-intents cut is on, {@link driveAutoReconnect} mirrors each event so the
 * store tracks the loop and the backend timer driver arms the `Waiting → Attempt`
 * edge. Best-effort — {@link mirrorSessionIntent} logs and swallows any failure,
 * so the local path is never disrupted (the resilience fallback).
 */
function mirrorAutoReconnectEvent(
  tabId: string,
  event: "drop" | "attempt" | "success" | "failure" | "cancel",
  error?: string
): void {
  const kind: SessionIntentKind | null =
    event === "drop"
      ? "session.reconnect"
      : event === "attempt"
        ? "session.reconnectAttempt"
        : event === "success"
          ? "session.connected"
          : event === "failure"
            ? "session.reconnectFailed"
            : event === "cancel"
              ? "session.cancelReconnect"
              : null;
  if (kind) mirrorSessionIntent(kind, tabId, error);
}

// The backend reconnect-timer reconcile is wired lazily on the first `waiting`
// arm under the session-intents cut, so the subscription is only opened when the
// cut is actually exercised (never in the default-off path or plain unit tests).
let sessionReconcileWired = false;

/**
 * Wire the backend-timer reconcile once: subscribe to the `session-lifecycle`
 * region and, when the backend timer fires a session's `Waiting → Connecting`
 * edge, start the local attempt (redriving the real connection). Guarded so it
 * only acts on that specific backend-driven transition and only while the local
 * loop is still `waiting`, making a `driveAutoReconnect(tabId, "attempt")` that
 * races the projected diff idempotent (a second attempt from `connecting` is a
 * reducer no-op).
 */
function ensureSessionReconcileWired(): void {
  // The reconcile listener is registered exactly once (it reads the live store,
  // so one listener serves every tab); the region subscription is (re-)ensured
  // on every call, which is idempotent and lets a dropped subscription recover.
  if (!sessionReconcileWired) {
    sessionReconcileWired = true;
    onSessionView((next, prev) => {
      for (const [tabId, life] of Object.entries(next)) {
        const before = prev[tabId];
        if (
          life.reconnect.phase === "connecting" &&
          before?.reconnect.phase === "waiting" &&
          useAppStore.getState().terminalAutoReconnect[tabId]?.phase === "waiting"
        ) {
          driveAutoReconnect(tabId, "attempt");
        }
      }
    });
  }
  ensureSessionSubscribed().catch((err) => logSessionBridgeFallback("subscribe", err));
}

/**
 * Drive the resilient-reconnect state machine for one tab by feeding it an event
 * (#1962), then reconcile the imperative side effects (backoff timer, redriving
 * the connection, overlay state) with the resulting phase. Centralising this
 * keeps the timer, the store's display state, and the overlay in lockstep for
 * every transition — start, retry tick, failure, success, and give-up.
 *
 * Called from the store's lifecycle hooks (`setTerminalExited` → `drop`,
 * `setTabSessionId` → `success`, `setTerminalSpawnError` → `failure`) and from
 * the Cancel affordance (`cancel`). Reads/writes the live store via
 * `useAppStore`, so it must only run after module init (always true at call
 * time). Uses the module-scoped `reconnectReducer` for the pure decision.
 *
 * # Backend timer cut (#2203)
 *
 * When {@link sessionIntentsEnabled} is on, each event is mirrored to a
 * `session.*` intent and the backoff *timing* is owned by the backend timer
 * driver: the local `setTimeout` is not armed for a `waiting` phase; instead the
 * backend fires the attempt and {@link ensureSessionReconcileWired} drives it
 * back. When off (the default), the local `setTimeout` path runs exactly as
 * before — the rollback / resilience fallback.
 */
function driveAutoReconnect(
  tabId: string,
  event: "drop" | "attempt" | "success" | "failure" | "cancel",
  error?: string
): void {
  const store = useAppStore.getState();
  const current = store.terminalAutoReconnect[tabId];
  // Absent entry ≡ idle. A settled (connected) loop is cleared, so a later drop
  // re-enters from idle — equivalent to the reducer's connected→waiting edge.
  const prev = current
    ? { phase: current.phase as ReconnectPhase, attempt: current.attempt, delayMs: current.delayMs }
    : initialReconnectState;
  const next = reconnectReducer(prev, event, autoReconnectConfig);

  // A no-op transition (stray event for the current phase) changes nothing.
  if (next.phase === prev.phase && next.attempt === prev.attempt && event !== "cancel") {
    return;
  }

  clearAutoReconnectTimer(tabId);

  // Mirror the loop event to the backend session store when the cut is on, so it
  // tracks the loop and the backend timer drives the Waiting→Attempt edge. The
  // `attempt` event is not mirrored here: under the cut, an attempt originates
  // from the backend timer (reconciled below), so re-dispatching it would be a
  // redundant no-op against the store already in `Connecting`.
  const cutOn = sessionIntentsEnabled();
  if (cutOn && event !== "attempt") {
    mirrorAutoReconnectEvent(tabId, event, error);
  }

  // The configured on-reconnect command (#1978), echoed into the display state so
  // the countdown overlay can announce what will run once the link is back.
  const onReconnectCommand = onReconnectCommandForTab(findTabById(tabId));

  switch (next.phase) {
    case "waiting": {
      const nextAttemptAt = Date.now() + next.delayMs;
      const record: TerminalAutoReconnectState = {
        phase: "waiting",
        attempt: next.attempt,
        maxAttempts: autoReconnectConfig.maxAttempts,
        delayMs: next.delayMs,
        nextAttemptAt,
        ...(onReconnectCommand ? { onReconnectCommand } : {}),
      };
      useAppStore.setState((state) => ({
        terminalAutoReconnect: { ...state.terminalAutoReconnect, [tabId]: record },
        // Clear any leftover failed-attempt state so no competing overlay shows
        // beneath the countdown; the auto-reconnect overlay owns the tab now.
        terminalSpawnErrors: omitKey(state.terminalSpawnErrors, tabId),
        terminalDisconnectErrors: omitKey(state.terminalDisconnectErrors, tabId),
      }));
      if (cutOn) {
        // Backend timer cut (#2203): the backend `SessionLifecycleStore` timer
        // owns this backoff window and fires the attempt itself; the reconcile
        // (wired here) drives it back into the local loop. No local `setTimeout`.
        ensureSessionReconcileWired();
      } else {
        const handle = setTimeout(() => {
          autoReconnectTimers.delete(tabId);
          driveAutoReconnect(tabId, "attempt");
        }, next.delayMs);
        autoReconnectTimers.set(tabId, handle);
      }
      frontendLog(
        "disconnect",
        `auto-reconnect tab=${tabId}: waiting ${next.delayMs}ms before attempt ${next.attempt + 1}`
      );
      break;
    }

    case "connecting": {
      const record: TerminalAutoReconnectState = {
        phase: "connecting",
        attempt: next.attempt,
        maxAttempts: autoReconnectConfig.maxAttempts,
        delayMs: 0,
        nextAttemptAt: 0,
        ...(onReconnectCommand ? { onReconnectCommand } : {}),
      };
      useAppStore.setState((state) => ({
        terminalAutoReconnect: { ...state.terminalAutoReconnect, [tabId]: record },
      }));
      frontendLog("disconnect", `auto-reconnect tab=${tabId}: attempt ${next.attempt} connecting`);
      // Re-drive the same tab through the normal reconnect path: bumps the retry
      // counter so Terminal.tsx re-runs setup, replaying local scrollback and
      // reattaching in place. Success → setTabSessionId → "success"; a direct-SSH
      // failure → setTerminalSpawnError → "failure".
      store.reconnectTerminal(tabId);
      break;
    }

    case "connected":
      // Transport recovered — settle and forget the loop.
      useAppStore.setState((state) => ({
        terminalAutoReconnect: omitKey(state.terminalAutoReconnect, tabId),
      }));
      frontendLog("disconnect", `auto-reconnect tab=${tabId}: reconnected`);
      // Run the optional on-reconnect command once in the fresh remote shell to
      // recover some server-side context (#1978). Only reached on an *automatic*
      // reconnect success — the initial manual connect never drives this loop.
      runOnReconnectCommand(tabId);
      break;

    case "gaveup":
    case "idle":
    default: {
      // Cancelled by the user or attempts exhausted. Drop the loop state and
      // hand off to the manual disconnect overlay (scrollback preserved).
      useAppStore.setState((state) => ({
        terminalAutoReconnect: omitKey(state.terminalAutoReconnect, tabId),
        terminalSpawnErrors: omitKey(state.terminalSpawnErrors, tabId),
      }));
      if (error) {
        // Exhausted: show the "Reconnect failed" overlay with the last error.
        store.setTerminalDisconnectWithError(tabId, error);
      } else {
        // User cancelled mid-loop: ensure the standard disconnect overlay is
        // visible so Reconnect / View Scrollback remain available.
        useAppStore.setState((state) => ({
          terminalExitedTabs: { ...state.terminalExitedTabs, [tabId]: true },
          terminalReconnectingTabs: omitKey(state.terminalReconnectingTabs, tabId),
        }));
      }
      frontendLog(
        "disconnect",
        `auto-reconnect tab=${tabId}: gave up (${error ? "exhausted" : "cancelled"})`
      );
      break;
    }
  }
}

/**
 * Resolve the terminal tab ids that belong to a broadcast {@link BroadcastScope}
 * given the tab that owns input (the source). Only *terminal* tabs are eligible
 * — non-terminal tabs (editors, SFTP/file browsers, ...) are never broadcast
 * targets, matching the concept's "Non-terminal tabs never appear" rule.
 *
 * - `"all"` — every terminal tab in the source tab's own group.
 * - `"panel"` — every terminal tab in the same split panel as the source.
 * - `"custom"` — `[]`; membership comes from the user's picker, not the scope.
 *
 * Exported for the scope dropdown's live counts and the dynamic-membership tests
 * (#1956). Resolves within the **source tab's own group tree** — not the active
 * group — so broadcast never silently retargets to a terminal in a different,
 * possibly invisible tab group when the source is not in the active group
 * (#1980). The active group's live tree is `state.rootPanel`; every other
 * group keeps its tree in `group.rootPanel`.
 */
export function resolveBroadcastTargetTabIds(
  state: { tabGroups: TabGroup[]; activeTabGroupId: string; rootPanel: PanelNode },
  scope: BroadcastScope,
  sourceTabId: string
): string[] {
  if (scope === "custom") return [];
  const isTerminal = (t: TerminalTab): boolean => t.contentType === "terminal";
  // Find the source's own group tree (active group's live tree is `rootPanel`;
  // inactive groups keep theirs in `group.rootPanel`). Fall back to the active
  // tree if the source cannot be located (shouldn't happen for a live source).
  const trees = state.tabGroups.map((g) =>
    g.id === state.activeTabGroupId ? state.rootPanel : g.rootPanel
  );
  const sourceTree = trees.find((tree) => findLeafByTab(tree, sourceTabId)) ?? state.rootPanel;
  if (scope === "panel") {
    const leaf = findLeafByTab(sourceTree, sourceTabId);
    if (!leaf) return [];
    return leaf.tabs.filter(isTerminal).map((t) => t.id);
  }
  // "all" — every terminal tab in the source's group
  return getAllLeaves(sourceTree)
    .flatMap((leaf) => leaf.tabs)
    .filter(isTerminal)
    .map((t) => t.id);
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
 * The backend session ids whose transfers belong to `tab` (#1951): the tab's own
 * `sessionId` (FTP `file-browser` tabs transfer on the tab session directly) plus
 * every SFTP sidebar session bound to the tab via `sftpSessions[…].owningTabId`
 * (an SSH tab's SFTP browser runs on a separate session). A Transfer Queue row is
 * attributed to `tab` when its `sessionId` is in this set, so the rows can follow
 * the tab across a window move.
 */
function tabTransferSessionIds(
  state: { sftpSessions: Record<string, SftpSessionEntry> },
  tab: TerminalTab
): string[] {
  const ids = new Set<string>();
  if (tab.sessionId) ids.add(tab.sessionId);
  for (const [sid, entry] of Object.entries(state.sftpSessions)) {
    if (entry.owningTabId === tab.id) ids.add(sid);
  }
  return [...ids];
}

/**
 * Build the hand-off record for `tab`, attaching the Transfer Queue rows that
 * belong to its session(s) so they follow the tab to the destination window
 * (#1951). Returns both the record and the transfer session ids, so the caller
 * can drop the moved rows from the source queue and mark the sessions released.
 */
function buildTransferAwareHandoff(
  state: {
    sftpSessions: Record<string, SftpSessionEntry>;
    transferQueue: Record<string, TransferEntry>;
  },
  tab: TerminalTab
): { record: TabHandoffRecord; transferSessionIds: string[]; movedTransferIds: string[] } {
  const transferSessionIds = tabTransferSessionIds(state, tab);
  const carried = Object.values(state.transferQueue).filter((t) =>
    transferSessionIds.includes(t.sessionId)
  );
  const record: TabHandoffRecord = {
    tab: {
      ...serializeHandoffTab(tab),
      ...(carried.length ? { transfers: carried } : {}),
    },
  };
  return { record, transferSessionIds, movedTransferIds: carried.map((t) => t.id) };
}

/**
 * Source-side state changes when a tab's transfers are handed to another window
 * (#1951): drop the moved rows from the persistent {@link AppState.transferQueue}
 * and the transient {@link AppState.transfers} map, and add their session ids to
 * {@link AppState.releasedTransferSessions} so broadcast progress events can no
 * longer re-create the rows in this window. Returns a partial state slice.
 */
function removeTransferSessionsFromWindow(
  state: {
    transferQueue: Record<string, TransferEntry>;
    transfers: Record<string, TransferState>;
    releasedTransferSessions: string[];
  },
  transferSessionIds: string[],
  movedTransferIds: string[]
): Partial<{
  transferQueue: Record<string, TransferEntry>;
  transfers: Record<string, TransferState>;
  releasedTransferSessions: string[];
}> {
  if (transferSessionIds.length === 0) return {};
  const releaseSet = new Set(transferSessionIds);
  const transferQueue = movedTransferIds.reduce(
    (acc, id) => (id in acc ? omitKey(acc, id) : acc),
    state.transferQueue
  );
  const transfers = Object.fromEntries(
    Object.entries(state.transfers).filter(([, t]) => !releaseSet.has(t.sessionId))
  );
  const releasedTransferSessions = Array.from(
    new Set([...state.releasedTransferSessions, ...transferSessionIds])
  );
  return { transferQueue, transfers, releasedTransferSessions };
}

/** State slice needed to decide whether this window renders/owns a session. */
type OwnershipView = {
  tabGroups: TabGroup[];
  activeTabGroupId: string;
  rootPanel: PanelNode;
  sftpSessions: Record<string, SftpSessionEntry>;
  sessionOwners: Record<string, string>;
  windowLabel: string;
};

/**
 * Whether this window renders `sessionId` locally (#1964): a live tab in any of
 * this window's tab groups is bound to it, or it is an SFTP sidebar session in
 * this window's store. This is authoritative for *this* window regardless of how
 * fresh {@link AppState.sessionOwners} is, so the owning window never suppresses
 * (nor prunes) a row for a session it is actually showing.
 */
function windowRendersSession(
  state: {
    tabGroups: TabGroup[];
    activeTabGroupId: string;
    rootPanel: PanelNode;
    sftpSessions: Record<string, SftpSessionEntry>;
  },
  sessionId: string
): boolean {
  if (sessionId in state.sftpSessions) return true;
  return collectLiveTabs(state).some((t) => t.sessionId === sessionId);
}

/**
 * Whether this window should fold a `transfer-progress` event for `sessionId`
 * into its transfer UI (#1964), scoping a transfer to the window that owns its
 * session even without a tab move:
 *
 *  - a session this window renders is owned here (see {@link windowRendersSession});
 *  - otherwise the backend `session → window` map (#1900) decides — a session
 *    owned by another window is suppressed here;
 *  - a session absent from the map is unclaimed (background/spawned, or not yet
 *    claimed) and folds everywhere as a safe fallback, preserving single-window
 *    behavior (the main window owns everything) and background transfers whose
 *    session may not correspond to a visible tab.
 */
function windowOwnsTransferSession(state: OwnershipView, sessionId: string): boolean {
  if (windowRendersSession(state, sessionId)) return true;
  const owner = state.sessionOwners?.[sessionId];
  if (owner === undefined) return true;
  return owner === state.windowLabel;
}

/**
 * Drop transient {@link AppState.transfers} and persistent
 * {@link AppState.transferQueue} rows for sessions a fresh ownership snapshot
 * shows are owned by a *different* window (#1964) — the belt-and-suspenders that
 * clears a row this window may have folded before it learned another window owns
 * the session. Rows this window renders locally are always kept, so a stale
 * snapshot can never evict a live row.
 */
function pruneForeignTransfers(
  state: OwnershipView & {
    transfers: Record<string, TransferState>;
    transferQueue: Record<string, TransferEntry>;
  },
  owners: Record<string, string>
): Partial<Pick<AppState, "transfers" | "transferQueue">> {
  const view: OwnershipView = { ...state, sessionOwners: owners };
  const isForeign = (sessionId: string) => !windowOwnsTransferSession(view, sessionId);
  const transfers = Object.fromEntries(
    Object.entries(state.transfers).filter(([, t]) => !isForeign(t.sessionId))
  );
  const transferQueue = Object.fromEntries(
    Object.entries(state.transferQueue).filter(([, t]) => !isForeign(t.sessionId))
  );
  const result: Partial<Pick<AppState, "transfers" | "transferQueue">> = {};
  if (Object.keys(transfers).length !== Object.keys(state.transfers).length) {
    result.transfers = transfers;
  }
  if (Object.keys(transferQueue).length !== Object.keys(state.transferQueue).length) {
    result.transferQueue = transferQueue;
  }
  return result;
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

/**
 * Return a copy of `root` with the split container `splitId`'s child `sizes`
 * replaced (normalized to sum to 100). A structural no-op when the id is absent.
 * The local twin of the Rust store's `set_split_sizes`, so the resize cut's
 * fallback path stays parity-identical.
 */
function setSplitSizesInTree(root: PanelNode, splitId: string, sizes: number[]): PanelNode {
  if (root.type === "leaf") return root;
  const children = root.children.map((c) => setSplitSizesInTree(c, splitId, sizes));
  if (root.id === splitId) {
    return { ...root, children, sizes: normalizeSizes(sizes) };
  }
  return { ...root, children };
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

export const useAppStore = create<AppState>((set, get, store) => {
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
    // Domain slices (#2077) — extracted from this monolith, spread in first so
    // the root store keeps the same public shape and behavior.
    ...createTunnelSlice(set, get, store),
    ...createEmbeddedServersSlice(set, get, store),
    ...createMacrosSlice(set, get, store),
    ...createPluginsSlice(set, get, store),
    ...createSessionHistorySlice(set, get, store),
    ...createZoomSlice(set, get, store),
    ...createCommandPaletteSlice(set, get, store),

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

    moveTabToGroup: (tabId, fromPanelId, targetGroupId) => {
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
      });
      // Moving a tab across groups changes broadcast membership when the source
      // or a target crosses the group boundary (#1980) — re-resolve so an
      // "all"/"panel" scope drops/adds it in the source's own group.
      get().refreshBroadcastMembership();
    },

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
    releasedTransferSessions: [],
    windowLabel: currentWindowLabel(),
    sessionOwners: {},
    setSessionOwners: (owners) =>
      set((state) => ({ sessionOwners: owners, ...pruneForeignTransfers(state, owners) })),
    refreshSessionOwners: async () => {
      try {
        const owners = await listSessionOwners();
        // Coerce a missing/non-object result (e.g. an unmocked IPC bridge in
        // tests returning `undefined`) to an empty map so the fold gate never
        // reads through `undefined`.
        get().setSessionOwners(owners ?? {});
      } catch {
        // Ownership is advisory (see `bestEffortOwnership`): a failed refetch (IPC
        // unavailable / unit test stub) must never disrupt the transfer UI. The
        // stale map simply keeps the previous scoping.
      }
    },
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

      // Carry this tab's Transfer Queue rows so its transfers follow the tab to
      // the destination window rather than staying orphaned here (#1951).
      const { record, transferSessionIds, movedTransferIds } = buildTransferAwareHandoff(
        get(),
        tab
      );
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
        // Drop the moved tab's transfer rows and mark its sessions released so
        // ongoing broadcast `transfer-progress` events do not re-adopt them here
        // (#1951). The destination window seeds the carried rows on hydrate.
        const transferMoved = removeTransferSessionsFromWindow(
          state,
          transferSessionIds,
          movedTransferIds
        );
        return {
          rootPanel: newRootPanel,
          tabGroups,
          activePanelId: newActivePanelId,
          ...transferMoved,
        };
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

        // Seed the transfers carried with the tab so they follow it into this
        // window's queue (#1951). Existing rows win over carried ones — a
        // broadcast event that already advanced a row here must not be clobbered
        // by the (possibly staler) carried snapshot. The carried sessions are
        // un-released so this window resumes folding their live progress events.
        const carried = h.transfers ?? [];
        const transferQueue = carried.length
          ? { ...Object.fromEntries(carried.map((t) => [t.id, t])), ...state.transferQueue }
          : state.transferQueue;
        const unrelease = new Set(
          [h.sessionId, ...carried.map((t) => t.sessionId)].filter((id): id is string => !!id)
        );
        const releasedTransferSessions =
          unrelease.size > 0
            ? state.releasedTransferSessions.filter((id) => !unrelease.has(id))
            : state.releasedTransferSessions;

        return {
          rootPanel: newRootPanel,
          tabGroups,
          activePanelId: targetLeaf.id,
          transferQueue,
          releasedTransferSessions,
        };
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

      // Carry each tab's Transfer Queue rows so its transfers follow it to the
      // destination window rather than being lost when this window closes
      // (#1951). This window is being emptied/torn down, so no source-side
      // removal is needed — only the destination must receive them.
      const state = get();
      const records: TabHandoffRecord[] = tabs.map(
        (tab) => buildTransferAwareHandoff(state, tab).record
      );
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

        // Agentless resilient reconnect (#1962): a session id landing while a
        // backoff loop is in flight means the transport came back — settle the
        // loop. (No-op when no loop is active.)
        if (get().terminalAutoReconnect[tabId]) {
          driveAutoReconnect(tabId, "success");
        } else if (sessionIntentsEnabled()) {
          // Session-intents cut (#2203): a plain (non-loop) connect succeeded —
          // settle the tab live in the backend store. The loop case above already
          // mirrors `session.connected` via `driveAutoReconnect`.
          mirrorSessionIntent("session.connected", tabId);
        }

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
      // Dynamic membership (#1956): a terminal opened during an active broadcast
      // is auto-added under the "all"/"panel" scopes (never under "custom").
      get().refreshBroadcastMembership();
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

    pendingSettingsCategory: null,
    pendingSettingsPluginId: null,

    openSettingsTab: (target) =>
      set((state) => {
        // Deep-link target (#2000): a null category leaves the panel's current
        // category alone, so a plain open never resets it to General.
        const nav = {
          pendingSettingsCategory: target?.category ?? null,
          pendingSettingsPluginId: target?.pluginId ?? null,
        };
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
            return { ...nav, rootPanel, activePanelId: leaf.id };
          }
        }

        // No existing settings tab — create one in the active panel
        const targetPanelId = state.activePanelId ?? allLeaves[0]?.id;
        if (!targetPanelId) return { ...nav };

        const dummyConfig: ConnectionConfig = { type: "local", config: { shell: "zsh" } };
        const newTab = createTab("Settings", "local", dummyConfig, targetPanelId, "settings");
        const rootPanel = updateLeaf(state.rootPanel, targetPanelId, (leaf) => {
          const tabs = leaf.tabs.map((t) => ({ ...t, isActive: false }));
          tabs.push(newTab);
          return { ...leaf, tabs, activeTabId: newTab.id };
        });
        return { ...nav, rootPanel, activePanelId: targetPanelId };
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
      // Session-intents cut (#2203): the tab is gone — drop its lifecycle record
      // from the shared region so the store does not leak a dead session. Any
      // pending backend reconnect timer is cancelled by `session.remove`.
      if (sessionIntentsEnabled()) mirrorSessionIntent("session.remove", tabId);

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
        // Relinquish each SFTP session's window ownership (#1964), mirroring the
        // tab-session release above. Best-effort.
        bestEffortOwnership(() => releaseSession(sessionId));
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
        const remainingAutoReconnect = omitKey(state.terminalAutoReconnect, tabId);

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
            terminalAutoReconnect: remainingAutoReconnect,
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
          terminalAutoReconnect: remainingAutoReconnect,
          sftpSessions: remainingSftp,
          ...sftpBrowserReset,
        };
      });

      // Cancel any pending resilient-reconnect backoff timer for the closed tab
      // (#1962) — the store entry was already dropped above; this frees the
      // imperative timer so it cannot fire against a gone tab.
      clearAutoReconnectTimer(tabId);

      // Broadcast (#1955): closing the source tab ends broadcast entirely;
      // closing a plain target silently drops it from the set.
      const bc = get();
      if (bc.broadcastActive) {
        if (bc.broadcastSourceTabId === tabId) {
          bc.stopBroadcast();
        } else if (bc.broadcastTargetTabIds.has(tabId)) {
          bc.removeBroadcastTarget(tabId);
        }
      }
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

    reorderTabs: (panelId, oldIndex, newIndex) => {
      // Local reducer — the retained rollback/resilience fallback (see
      // `splitPanel`). Reorders a tab within its leaf, leaving focus untouched.
      const applyLocal = () =>
        set((state) => ({
          rootPanel: updateLeaf(state.rootPanel, panelId, (leaf) => {
            const tabs = [...leaf.tabs];
            const [moved] = tabs.splice(oldIndex, 1);
            tabs.splice(newIndex, 0, moved);
            return { ...leaf, tabs };
          }),
        }));

      // Structural reorder cut (#2188): route through `layout.reorderTabs`; the
      // backend LayoutStore reorders and reconcileNode writes the reconciled
      // tree. Focus is unchanged, so only `rootPanel` is applied. Any failure
      // falls back to the local reducer.
      if (!layoutIntentsEnabled()) return applyLocal();
      const { rootPanel, activePanelId } = get();
      void runLayoutIntent(
        "layout.reorderTabs",
        { panelId, oldIndex, newIndex },
        rootPanel,
        activePanelId
      )
        .then((res) => set({ rootPanel: res.rootPanel }))
        .catch((err) => {
          logBridgeFallback("layout.reorderTabs", err);
          applyLocal();
        });
    },

    splitPanel: (direction) => {
      // Local reducer. Since #2184 the intent path below is the default, so this
      // is the retained resilience/rollback fallback: it runs when the flag is
      // explicitly off (rollback) or an intent dispatch/reconcile fails, so a
      // backend hiccup can never break layout. Not a duplicate algebra — it
      // orchestrates the shared `@/utils/panelTree` helpers (the same seam the
      // Rust store ports), so keeping it costs no drift, only a safety net.
      const applyLocal = () =>
        set((state) => {
          const dir = direction ?? "horizontal";
          const targetId = state.activePanelId;
          if (!targetId) return state;

          const newLeaf = createLeafPanel();
          let rootPanel = splitLeaf(state.rootPanel, targetId, newLeaf, dir, "after");
          rootPanel = simplifyTree(rootPanel);
          return { rootPanel, activePanelId: newLeaf.id };
        });

      // Structural split cut (#2151 step 2, default-on since #2184): route
      // through the `layout.split` intent; the backend LayoutStore mutates and
      // reconcileNode is the authoritative writer of the reconciled tree. On any
      // failure fall back to the local reducer so layout never breaks.
      if (!layoutIntentsEnabled()) return applyLocal();
      const { rootPanel, activePanelId } = get();
      if (!activePanelId) return applyLocal();
      void runLayoutIntent(
        "layout.split",
        { panelId: activePanelId, direction: direction ?? "horizontal", position: "after" },
        rootPanel,
        activePanelId
      )
        .then((res) => set(res))
        .catch((err) => {
          logBridgeFallback("layout.split", err);
          applyLocal();
        });
    },

    removePanel: (panelId) => {
      // Local reducer — the retained rollback/resilience fallback. Drops a whole
      // leaf panel and simplifies; repoints focus onto the first survivor when
      // the removed panel held it.
      const applyLocal = () =>
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
        });

      // Structural remove cut (#2188): route through `layout.removePanel` — a
      // dedicated transform, since `merge` preserves the tabs and
      // `closeTabStructure` is per-tab, so neither models "discard the whole
      // panel". The sole-leaf case is a no-op both here and in the store. Any
      // failure falls back to the local reducer.
      if (!layoutIntentsEnabled()) return applyLocal();
      const { rootPanel, activePanelId } = get();
      if (getAllLeaves(rootPanel).length <= 1) return;
      void runLayoutIntent("layout.removePanel", { panelId }, rootPanel, activePanelId)
        .then((res) => set(res))
        .catch((err) => {
          logBridgeFallback("layout.removePanel", err);
          applyLocal();
        });
    },

    setActivePanel: (panelId) => {
      // Local reducer — applied synchronously in every mode so focus stays
      // instant (this is a hot path: every panel click and keyboard-nav step).
      // Zoom-follow: when the zoom overlay shows a tab from the newly-focused
      // panel, follow the switch to that panel's active tab.
      const applyLocal = () =>
        set((state) => {
          let newZoomedTabId = state.zoomedTabId;
          if (state.zoomedTabId !== null) {
            const newPanel = findLeaf(state.rootPanel, panelId);
            newZoomedTabId = newPanel?.activeTabId ?? null;
          }
          return { activePanelId: panelId, zoomedTabId: newZoomedTabId };
        });

      // Focus is projection state (`activePanelId`), so fold it into the layout
      // region (#2188): apply locally for instant UX, then best-effort push the
      // focus through `layout.setActivePanel` so the backend stays authoritative
      // and the render-from-projection mirror keeps matching. The reconciled
      // result is ignored — the local set already landed — and a failure is just
      // logged (the projection catches up on the next seed).
      applyLocal();
      if (!layoutIntentsEnabled()) return;
      const { rootPanel, activePanelId } = get();
      void runLayoutIntent("layout.setActivePanel", { panelId }, rootPanel, activePanelId).catch(
        (err) => logBridgeFallback("layout.setActivePanel", err)
      );
    },

    setPanelSizes: (splitId, sizes) => {
      // Local reducer — the retained rollback/resilience fallback. Persists a
      // split's child percentage sizes so a resize-handle drag survives remounts
      // and workspace save/restore.
      const applyLocal = () =>
        set((state) => ({ rootPanel: setSplitSizesInTree(state.rootPanel, splitId, sizes) }));

      // Resize cut (#2188): route through `layout.resize`; the backend persists
      // the normalized sizes and reconcileNode writes the reconciled tree. Only
      // `rootPanel` changes. Any failure falls back to the local reducer.
      if (!layoutIntentsEnabled()) return applyLocal();
      const { rootPanel, activePanelId } = get();
      void runLayoutIntent("layout.resize", { splitId, sizes }, rootPanel, activePanelId)
        .then((res) => set({ rootPanel: res.rootPanel }))
        .catch((err) => {
          logBridgeFallback("layout.resize", err);
          applyLocal();
        });
    },

    splitPanelWithTab: (tabId, fromPanelId, targetPanelId, edge) => {
      // Local reducer. As with splitPanel, since #2184 this is the retained
      // resilience/rollback fallback (flag off, or an intent failure) rather than
      // the default path — kept as a safety net over the shared panelTree algebra.
      const applyLocal = () =>
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
        });

      // Tab-carrying drop cut (#2151 step 2, default-on since #2184): maps to
      // `layout.moveTab` (center = merge into the target stack, edge = split the
      // target). The backend collapses an emptied self-drop source but the local
      // reducer keeps it, so the single-tab self-edge-drop corner stays on the
      // local path to preserve exact parity; everything else routes through the
      // store, with reconcileNode as the authoritative writer.
      if (!layoutIntentsEnabled()) return applyLocal();
      const { rootPanel, activePanelId } = get();
      const sourceLeaf = findLeaf(rootPanel, fromPanelId);
      const selfEdgeSingleTab =
        edge !== "center" && fromPanelId === targetPanelId && (sourceLeaf?.tabs.length ?? 0) <= 1;
      if (!sourceLeaf || selfEdgeSingleTab) return applyLocal();

      void runLayoutIntent(
        "layout.moveTab",
        moveTabPayload(tabId, targetPanelId, edge),
        rootPanel,
        activePanelId,
        tabId
      )
        .then((res) => set(res))
        .catch((err) => {
          logBridgeFallback("layout.moveTab", err);
          applyLocal();
        });
    },

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

    // Shortcuts overlay + command palette + standalone overlay views provided
    // by createCommandPaletteSlice (extracted under #2077 via #2300).

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

    // Zoom (runtime-only) — scale factor + in/out/reset provided by
    // createZoomSlice (extracted under #2077 via #2300).

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
          frontendLog(
            "app_store",
            `Failed to persist layout config: ${err instanceof Error ? err.message : String(err)}`
          )
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
          frontendLog(
            "app_store",
            `Failed to persist layout preset: ${err instanceof Error ? err.message : String(err)}`
          )
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
          frontendLog(
            "app_store",
            `Failed to persist layout config: ${err instanceof Error ? err.message : String(err)}`
          )
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
            frontendLog("app_store", `Failed to load external file ${err.filePath}: ${err.error}`);
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
        frontendLog(
          "app_store",
          `Failed to load connections from backend: ${err instanceof Error ? err.message : String(err)}`
        );
        toast.error(
          `Failed to load connections: ${err instanceof Error ? err.message : String(err)}`,
          { id: "load-connections-error" }
        );
      }
      // Load connection type registry
      try {
        const connectionTypes = await getConnectionTypes();
        set({ connectionTypes });
      } catch (err) {
        frontendLog(
          "app_store",
          `Failed to load connection types: ${err instanceof Error ? err.message : String(err)}`
        );
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
        frontendLog(
          "app_store",
          `Failed to detect available shells: ${err instanceof Error ? err.message : String(err)}`
        );
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
      // Load installed plugins (#1997)
      get().loadPlugins();
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
        frontendLog(
          "app_store",
          `Failed to load recovery warnings: ${err instanceof Error ? err.message : String(err)}`
        );
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
        // Mutation cut (#2227): make the backend SettingsStore authoritative by
        // mirroring the whole-document save as a settings.replace intent. Persist
        // above is untouched; the render-cut hook reflects the region back.
        mirrorSettingsIntent("settings.replace", { settings: newSettings });

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
        // Toggling the experimental frontend-plugin gate (#2048) reconciles the
        // injected plugin scripts: enabling loads active frontend plugins,
        // disabling tears them down. loadPlugins re-runs reconcile with the new
        // flag value it reads from the just-persisted settings.
        if (
          (oldSettings.frontendPluginsEnabled ?? false) !==
          (newSettings.frontendPluginsEnabled ?? false)
        ) {
          void get().loadPlugins();
        }
      } catch (err) {
        frontendLog(
          "app_store",
          `Failed to save settings: ${err instanceof Error ? err.message : String(err)}`
        );
        toast.error(
          `Failed to save settings: ${err instanceof Error ? err.message : String(err)}`,
          { id: "save-settings-error" }
        );
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
      // Mutation cut (#2227): the shell-integration write is a targeted field
      // patch, so mirror it as a settings.patch (shallow-merge) rather than a
      // whole-document replace — keeping a concurrent general-settings edit intact.
      mirrorSettingsIntent("settings.patch", { shellIntegration: nextSi });
      try {
        return await saveShellIntegrationSettings(nextSi);
      } catch (err) {
        const rolledBack = { ...get().settings, shellIntegration: prevSi };
        set({ settings: rolledBack, savedSettings: rolledBack });
        mirrorSettingsIntent("settings.patch", { shellIntegration: prevSi });
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
        frontendLog(
          "app_store",
          `Failed to reload external connections: ${err instanceof Error ? err.message : String(err)}`
        );
        toast.error(
          `Failed to reload external connections: ${err instanceof Error ? err.message : String(err)}`,
          { id: "reload-external-connections-error" }
        );
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
            frontendLog(
              "app_store",
              `Failed to persist folder toggle: ${err instanceof Error ? err.message : String(err)}`
            );
            toast.error(
              `Failed to save folder state: ${err instanceof Error ? err.message : String(err)}`
            );
          });
        }
        return { folders };
      });
      mirrorConnectionIntent("connection.toggleFolder", { folderId });
    },

    reloadConnectionsFromBackend: () => {
      frontendLog("connection_sync", "focus reload: triggered by external event");
      void applyConnectionReload();
    },

    // Session history (#1883) — data + load/record/pin/promote/remove/clear
    // provided by createSessionHistorySlice (extracted under #2077).

    addConnection: (connection) => {
      set((state) => ({ connections: [...state.connections, connection] }));
      mirrorConnectionIntent("connection.add", { connection });
      frontendLog("connection_sync", `addConnection: persisting ${connection.id}`);
      persistConnection(stripPassword(connection))
        .then((persistedId) => {
          reconcileConnectionId(connection.id, persistedId);
          toast.success(`Saved ${connection.name}`);
          return applyConnectionReload();
        })
        .catch((err) => {
          frontendLog(
            "app_store",
            `Failed to persist new connection: ${err instanceof Error ? err.message : String(err)}`
          );
          toast.error(
            `Failed to save ${connection.name}: ${err instanceof Error ? err.message : String(err)}`
          );
        });
    },

    bulkAddConnections: (newConnections) => {
      if (newConnections.length === 0) return;
      set((state) => ({ connections: [...state.connections, ...newConnections] }));
      for (const connection of newConnections) {
        mirrorConnectionIntent("connection.add", { connection });
      }
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
          frontendLog(
            "app_store",
            `Failed to persist imported connections: ${err instanceof Error ? err.message : String(err)}`
          );
          toast.error(
            `Failed to import connections: ${err instanceof Error ? err.message : String(err)}`
          );
        });
    },

    updateConnection: (connection) => {
      set((state) => ({
        connections: state.connections.map((c) => (c.id === connection.id ? connection : c)),
      }));
      mirrorConnectionIntent("connection.update", { connection });
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
          frontendLog(
            "app_store",
            `Failed to persist connection update: ${err instanceof Error ? err.message : String(err)}`
          );
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
      mirrorConnectionIntent("connection.remove", { connectionId });
      removeConnection(connectionId, conn?.sourceFile)
        .then(() => {
          frontendLog("connection_sync", `deleteConnection: backend confirmed, reloading`);
          toast.success(`Deleted ${conn?.name ?? "connection"}`);
          return applyConnectionReload();
        })
        .catch((err) => {
          frontendLog(
            "app_store",
            `Failed to persist connection deletion: ${err instanceof Error ? err.message : String(err)}`
          );
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
      for (const c of toDelete) {
        mirrorConnectionIntent("connection.remove", { connectionId: c.id });
      }
      Promise.all(toDelete.map((c) => removeConnection(c.id, c.sourceFile)))
        .then(() => {
          frontendLog("connection_sync", `bulkDeleteConnections: backend confirmed, reloading`);
          toast.success(
            `Deleted ${toDelete.length} ${toDelete.length === 1 ? "connection" : "connections"}`
          );
          return applyConnectionReload();
        })
        .catch((err) => {
          frontendLog(
            "app_store",
            `Failed to persist bulk connection deletion: ${err instanceof Error ? err.message : String(err)}`
          );
          toast.error(
            `Failed to delete connections: ${err instanceof Error ? err.message : String(err)}`
          );
        });
    },

    addFolder: (folder) => {
      set((state) => ({ folders: [...state.folders, folder] }));
      mirrorConnectionIntent("connection.addFolder", { folder });
      frontendLog("connection_sync", `addFolder: persisting ${folder.id}`);
      persistFolder(folder)
        .then(() => applyConnectionReload())
        .catch((err) => {
          frontendLog(
            "app_store",
            `Failed to persist new folder: ${err instanceof Error ? err.message : String(err)}`
          );
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
      mirrorConnectionIntent("connection.removeFolder", { folderId });
      frontendLog("connection_sync", `deleteFolder: removing ${folderId}`);
      removeFolder(folderId)
        .then(() => applyConnectionReload())
        .catch((err) => {
          frontendLog(
            "app_store",
            `Failed to persist folder deletion: ${err instanceof Error ? err.message : String(err)}`
          );
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
      mirrorConnectionIntent("connection.add", { connection: duplicate });
      frontendLog("connection_sync", `duplicateConnection: persisting copy of ${connectionId}`);
      persistConnection(stripPassword(duplicate))
        .then(() => applyConnectionReload())
        .catch((err) => {
          frontendLog(
            "app_store",
            `Failed to persist duplicated connection: ${err instanceof Error ? err.message : String(err)}`
          );
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
        mirrorConnectionIntent("connection.update", { connection: updated });
      } catch (err) {
        frontendLog(
          "app_store",
          `Failed to move connection to file: ${err instanceof Error ? err.message : String(err)}`
        );
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
      mirrorConnectionIntent("connection.move", { connectionId, folderId });

      // Persist to backend, then reload to sync any dedup renames
      // (e.g., when moving a connection into a folder with a same-named sibling)
      const moved = get().connections.find((c) => c.id === connectionId);
      if (moved) {
        frontendLog("connection_sync", `moveConnectionToFolder: persisting ${connectionId}`);
        persistConnection(stripPassword(moved))
          .then(() => applyConnectionReload())
          .catch((err) => {
            frontendLog(
              "app_store",
              `Failed to persist connection move: ${err instanceof Error ? err.message : String(err)}`
            );
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
      for (const connectionId of connectionIds) {
        mirrorConnectionIntent("connection.move", { connectionId, folderId });
      }

      // Persist all connections in parallel, then reload once
      const moved = get().connections.filter((c) => idSet.has(c.id));
      frontendLog(
        "connection_sync",
        `bulkMoveConnectionsToFolder: persisting ${moved.length} connections`
      );
      Promise.all(moved.map((conn) => persistConnection(stripPassword(conn))))
        .then(() => applyConnectionReload())
        .catch((err) => {
          frontendLog(
            "app_store",
            `Failed to persist bulk connection move: ${err instanceof Error ? err.message : String(err)}`
          );
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
          // Relinquish this SFTP session's window ownership (#1964) so its
          // transfers stop being attributed to this window (mirrors #1939 for
          // tab sessions). Best-effort.
          bestEffortOwnership(() => releaseSession(prevId));
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
          bestEffortOwnership(() => releaseSession(sid));
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
        // Claim window ownership of the tracked SFTP session (#1964) so its
        // broadcast `transfer-progress` events fold only in this window, even
        // without a tab move. Only sessions bound to an owning tab are tracked in
        // the map (and thus attributable); an untracked ad-hoc session stays
        // unclaimed and folds everywhere as before. Best-effort (see #1939).
        if (owningTabId) {
          bestEffortOwnership(() => claimSession(sessionId));
        }
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
        // Relinquish this SFTP session's window ownership (#1964). Best-effort.
        bestEffortOwnership(() => releaseSession(sessionId));
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
      // Relinquish this SFTP session's window ownership (#1964). Best-effort.
      bestEffortOwnership(() => releaseSession(sessionId));
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
        // A transfer whose session this window handed to another window (#1951)
        // is no longer ours: ignore its broadcast progress so a moved-away row is
        // not re-created here.
        if (state.releasedTransferSessions.includes(progress.sessionId)) return {};
        // Scope the fold to the owning window even without a move (#1964): a
        // `transfer-progress` event is broadcast to every window, but only the
        // window that owns the session should show it.
        if (!windowOwnsTransferSession(state, progress.sessionId)) return {};
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

    removeTransfer: (id: string) => {
      set((state) => {
        if (!(id in state.transferQueue)) return {};
        return { transferQueue: omitKey(state.transferQueue, id) };
      });
      // Mutation cut (#2229): mirror the removal into the authoritative store.
      // `transfer.remove` is idempotent server-side, so a removal of a row that
      // was never present is a harmless no-op in both slices (parity holds).
      mirrorTransferIntent("transfer.remove", { id });
    },

    clearCompleted: () => {
      set((state) => ({
        transferQueue: Object.fromEntries(
          Object.entries(state.transferQueue).filter(([, t]) => t.state !== "completed")
        ),
      }));
      mirrorTransferIntent("transfer.clearCompleted", {});
    },

    setTransferQueueMinimized: (minimized: boolean) => {
      set({ transferQueueMinimized: minimized });
      mirrorTransferIntent("transfer.setMinimized", { minimized });
    },

    applyTransferProgressToQueue: (progress: TransferProgress) => {
      let applied = false;
      set((state) => {
        // Ignore transfers whose session was handed to another window (#1951) so
        // a moved-away queue row is not re-adopted from a broadcast event.
        if (state.releasedTransferSessions.includes(progress.sessionId)) return {};
        // Scope the fold to the owning window even without a move (#1964).
        if (!windowOwnsTransferSession(state, progress.sessionId)) return {};
        const prev = state.transferQueue[progress.transferId];
        const entry = transferEntryFromProgress(progress, prev, Date.now());
        applied = true;
        return { transferQueue: { ...state.transferQueue, [entry.id]: entry } };
      });
      // Only mirror when the local reducer actually folded the event: the
      // window-ownership gates (#1951 / #1964) are frontend presentation the
      // backend store does not model, so dispatching for a released/unowned
      // session would advance the shared region past this window's slice.
      if (applied) mirrorTransferIntent("transfer.progress", { progress });
    },

    seedTransferQueue: (seed: TransferSeed) => {
      set((state) => {
        // Idempotent: never overwrite a row an event already advanced (#1632).
        if (seed.id in state.transferQueue) return {};
        const entry = transferEntryFromSeed(seed, Date.now());
        // Starting a transfer for a session here means this window owns it again,
        // so clear any stale "released" mark from a prior hand-off (#1951).
        const releasedTransferSessions = state.releasedTransferSessions.includes(seed.sessionId)
          ? state.releasedTransferSessions.filter((id) => id !== seed.sessionId)
          : state.releasedTransferSessions;
        return {
          transferQueue: { ...state.transferQueue, [entry.id]: entry },
          releasedTransferSessions,
        };
      });
      // Mutation cut (#2229): mirror the seed. `transfer.seed` is idempotent
      // server-side (it never overwrites an already-advanced row), so it stays a
      // no-op in the region exactly when it is a no-op in `appStore`.
      mirrorTransferIntent("transfer.seed", { seed });
    },

    reconcileTransferQueue: (snapshots: TransferSnapshot[]) => {
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
      });
      // Mutation cut (#2229): mirror the reconcile. `transfer.reconcile` applies
      // the same conservative terminal-only settle over an already-mirrored
      // region, so it settles exactly the rows the local reducer did.
      mirrorTransferIntent("transfer.reconcile", { snapshots });
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
      // Browser-view mirror (#2228): the SFTP list flags map to the pane's
      // loadStarted/loadSucceeded/loadFailed; the session model (sftpStatus,
      // session ids) stays appStore-driven (#2236).
      mirrorFileBrowserIntent("fileBrowser.loadStarted", { pane: "sftp" });
      try {
        const entries = await sftpListDir(sessionId, path);
        // Ignore a stale response: a newer navigate/refresh superseded this one.
        if (seq !== _sftpListSeq) {
          frontendLog("sftp", `navigateSftp: dropping stale list for ${path} (seq ${seq})`);
          return;
        }
        set({ fileEntries: entries, currentPath: path, sftpStatus: "connected" });
        mirrorFileBrowserIntent("fileBrowser.loadSucceeded", { pane: "sftp", path, entries });
      } catch (err) {
        if (seq !== _sftpListSeq) return;
        const message = err instanceof Error ? err.message : String(err);
        // A dead session (audit gap S2) must drop sftpSessionId so the UI stops
        // looking connected and the auto-connect effect / Reconnect can recover.
        const sessionDead = isSftpSessionDeadError(message);
        if (sessionDead) {
          frontendLog("sftp", `navigateSftp: session appears dead — clearing session (${message})`);
          // Relinquish the dead SFTP session's window ownership (#1964).
          bestEffortOwnership(() => releaseSession(sessionId));
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
        mirrorFileBrowserIntent("fileBrowser.loadFailed", { pane: "sftp", error: message });
      }
    },

    refreshSftp: async () => {
      const { sftpSessionId, currentPath } = useAppStore.getState();
      if (!sftpSessionId) return;
      const seq = ++_sftpListSeq;
      set({ sftpStatus: "listing", sftpError: null });
      mirrorFileBrowserIntent("fileBrowser.loadStarted", { pane: "sftp" });
      try {
        const entries = await sftpListDir(sftpSessionId, currentPath);
        // Ignore a stale response: a newer navigate/refresh superseded this one.
        if (seq !== _sftpListSeq) {
          frontendLog("sftp", `refreshSftp: dropping stale list for ${currentPath} (seq ${seq})`);
          return;
        }
        set({ fileEntries: entries, sftpStatus: "connected" });
        mirrorFileBrowserIntent("fileBrowser.loadSucceeded", {
          pane: "sftp",
          path: currentPath,
          entries,
        });
      } catch (err) {
        if (seq !== _sftpListSeq) return;
        const message = err instanceof Error ? err.message : String(err);
        const sessionDead = isSftpSessionDeadError(message);
        if (sessionDead) {
          frontendLog("sftp", `refreshSftp: session appears dead — clearing session (${message})`);
          // Relinquish the dead SFTP session's window ownership (#1964).
          bestEffortOwnership(() => releaseSession(sftpSessionId));
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
        mirrorFileBrowserIntent("fileBrowser.loadFailed", { pane: "sftp", error: message });
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
    setTerminalSpawnError: (tabId, error) => {
      // Agentless resilient reconnect (#1962): a spawn error while a backoff loop
      // is connecting is a failed attempt — feed it to the machine, which backs
      // off further or gives up (surfacing this error). Do this before writing
      // the error so the loop can suppress the competing connection overlay while
      // it retries. When no loop is active this is a plain error write.
      if (error !== null && get().terminalAutoReconnect[tabId]?.phase === "connecting") {
        driveAutoReconnect(tabId, "failure", error);
        return;
      }
      set((state) => ({
        terminalSpawnErrors:
          error === null
            ? omitKey(state.terminalSpawnErrors, tabId)
            : { ...state.terminalSpawnErrors, [tabId]: error },
      }));
    },
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
    setTerminalConnecting: (tabId, connecting) => {
      // Session-intents cut (#2203): an initial connect entering "Connecting…"
      // is `session.connect` (a fresh connect resets any stale record). Skipped
      // while an auto-reconnect loop owns the tab — that loop's `connecting`
      // phase is driven by `session.reconnectAttempt`, not a fresh connect.
      if (sessionIntentsEnabled() && connecting && !get().terminalAutoReconnect[tabId]) {
        mirrorSessionIntent("session.connect", tabId);
      }
      set((state) => ({
        terminalConnecting: connecting
          ? { ...state.terminalConnecting, [tabId]: true }
          : omitKey(state.terminalConnecting, tabId),
        terminalConnectDeadline: connecting
          ? armConnectDeadline(state.terminalConnectDeadline, tabId, "connecting")
          : omitKey(state.terminalConnectDeadline, tabId),
      }));
    },
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
    terminalAutoReconnect: {},
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
      // Agentless resilient reconnect (#1962): a dropped link on a plain-SSH tab
      // that opted in kicks off the backoff loop instead of leaving the user at
      // the manual disconnect prompt. Only an unexpected drop qualifies — a clean
      // exit or a user kill must not silently reconnect.
      let startedLoop = false;
      if (info?.reason === "dropped") {
        const tab = collectLiveTabs(get()).find((t) => t.id === tabId);
        if (isResilientReconnectTab(tab)) {
          get().startAutoReconnect(tabId);
          startedLoop = true;
        }
      }
      // Session-intents cut (#2203): mirror the exit to the backend store when no
      // auto-reconnect loop took over. A user kill is a graceful
      // `session.disconnect`; an unexpected drop that does not arm the loop is
      // `session.dropped`. When the loop started, `session.reconnect` was already
      // mirrored by `driveAutoReconnect`, so this is skipped.
      if (sessionIntentsEnabled() && !startedLoop) {
        if (info?.reason === "killed") {
          mirrorSessionIntent("session.disconnect", tabId);
        } else if (info?.reason === "dropped") {
          mirrorSessionIntent("session.dropped", tabId);
        }
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
      // Session-intents cut (#2203): a failed (re)connect with no active loop is
      // a terminal `session.connectFailed`. A loop's own failure is driven
      // through `driveAutoReconnect("failure")` instead, so it is skipped here.
      if (sessionIntentsEnabled() && !get().terminalAutoReconnect[tabId]) {
        mirrorSessionIntent("session.connectFailed", tabId, error);
      }
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
      // Settle locally first so the projected-render summary is registered before
      // the mirror dispatch (a synchronous transport failure then fires it now).
      if (pending.size === 0) get().settleRestoreCohort();
      // Mutation + render cut (#2241): mirror the cohort to the backend
      // `RestoreCohortStore` and the render region. Off/failure falls back to the
      // local reducers, which already ran above.
      mirrorRestoreBegin({ pendingTabIds, preFailedCount, toastId });
    },
    settleRestoreTab: (tabId, outcome) => {
      const cohort = get().restoreCohort;
      // Ignore a tab that is not pending in the current cohort (mirrors the store):
      // dispatch no intent for a stray/duplicate settle.
      if (!cohort || !cohort.pending.has(tabId)) return;
      const pending = new Set(cohort.pending);
      pending.delete(tabId);
      const failed = cohort.failed + (outcome === "failed" ? 1 : 0);
      // Remember which terminal tabs failed so they can be bulk-reconnected.
      const failedTabIds = new Set(cohort.failedTabIds);
      if (outcome === "failed") failedTabIds.add(tabId);
      set({ restoreCohort: { ...cohort, pending, failed, failedTabIds } });
      // Settle locally first so the projected-render summary is registered before
      // the mirror dispatch (see beginRestoreCohort).
      if (pending.size === 0) get().settleRestoreCohort();
      // Mutation + render cut (#2241): mirror the settle to the store + region.
      mirrorRestoreSettle({ tabId, outcome });
    },
    settleRestoreCohort: () => {
      const cohort = get().restoreCohort;
      if (!cohort) return;
      // Restrict the retry set to tabs that still exist as live terminal tabs (a
      // frontend concern — it needs the tab registry; the store keeps the raw set).
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
      const summary = { total, restored, failed, toastId };
      const fire = () =>
        raiseRestoreSummary(summary, retryTabIds, () => get().reconnectFailedRestoreTabs());
      if (restoreRenderFromProjectionEnabled()) {
        // Render cut (#2241): fire the summary toast once per new projected
        // settlement `seq` — the fired content is this gate-validated local summary.
        // The upcoming begin/settle mirror dispatch drives the region; if it fails,
        // the fallback fires this same closure, so the toast is never lost. The raw
        // failed set is the gate baseline (the store keeps the retry set unfiltered).
        expectProjectedRestoreSettlement(fire, {
          total,
          restored,
          failed,
          retryTabIds: [...cohort.failedTabIds],
        });
      } else {
        // Pre-cut path: fire straight from the local reducer.
        fire();
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

    startAutoReconnect: (tabId) => {
      // A "drop" only arms the loop from idle (no active entry) or a settled one;
      // the reducer ignores it while already waiting/connecting, so this is safe
      // to call on every dropped exit without double-starting.
      driveAutoReconnect(tabId, "drop");
    },
    cancelAutoReconnect: (tabId, error) => {
      // No active loop → nothing to cancel (avoid spuriously forcing the overlay).
      if (!get().terminalAutoReconnect[tabId]) return;
      driveAutoReconnect(tabId, "cancel", error);
    },

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
      // Mutation cut (#2226): append the agent to the authoritative region. A
      // no-op / logged fallback when the flag is off or the transport is
      // unavailable — the local slice above already applied.
      mirrorAgentIntent("agent.add", {
        id: agent.id,
        name: agent.name,
        config: agent.config,
        agentSettings: agent.agentSettings,
      });
      persistAgent({
        id: agent.id,
        name: agent.name,
        config: agent.config,
        agentSettings: agent.agentSettings,
      }).catch((err) => {
        frontendLog(
          "app_store",
          `Failed to persist new agent: ${err instanceof Error ? err.message : String(err)}`
        );
        toast.error(
          `Failed to save agent ${agent.name}: ${err instanceof Error ? err.message : String(err)}`
        );
      });
    },

    updateRemoteAgent: (agent) => {
      set((state) => ({
        remoteAgents: state.remoteAgents.map((a) => (a.id === agent.id ? agent : a)),
      }));
      // Mutation cut (#2226): update the persisted fields in the region.
      mirrorAgentIntent("agent.update", {
        id: agent.id,
        name: agent.name,
        config: agent.config,
        agentSettings: agent.agentSettings,
      });
      persistAgent({
        id: agent.id,
        name: agent.name,
        config: agent.config,
        agentSettings: agent.agentSettings,
      }).catch((err) => {
        frontendLog(
          "app_store",
          `Failed to persist agent update: ${err instanceof Error ? err.message : String(err)}`
        );
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
      // Mutation cut (#2226): reorder the agent in the region.
      mirrorAgentIntent("agent.reorder", { oldIndex, newIndex });
      const agentIds = get().remoteAgents.map((a) => a.id);
      persistAgentOrder(agentIds).catch((err) => {
        frontendLog(
          "app_store",
          `Failed to persist agent reorder: ${err instanceof Error ? err.message : String(err)}`
        );
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
      // Mutation cut (#2226): drop the agent and all of its sub-state from the
      // region (the store's `remove` clears sessions/definitions/folders too).
      mirrorAgentIntent("agent.remove", { id: agentId });
      removeAgent(agentId).catch((err) => {
        frontendLog(
          "app_store",
          `Failed to persist agent deletion: ${err instanceof Error ? err.message : String(err)}`
        );
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
      // Mutation cut (#2226): flip the sidebar expansion in the region.
      mirrorAgentIntent("agent.toggleExpanded", { id: agentId });
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
      // The agent's expansion before this connect: connect force-expands the
      // sidebar entry, so the region only needs a toggle when it was collapsed.
      const wasExpanded = agent.isExpanded;
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

        // Mutation cut (#2226): mirror the capabilities and the force-expand into
        // the region. `connectionState` stays a single-writer field driven by the
        // `agent-state-change` event (`setAgentConnectionState` → `agent.status`),
        // so it is deliberately not written here.
        mirrorAgentIntent("agent.setCapabilities", {
          id: agentId,
          capabilities: result.capabilities,
        });
        if (!wasExpanded) mirrorAgentIntent("agent.toggleExpanded", { id: agentId });

        // The session/definition refresh is owned by the "connected" event
        // (`setAgentConnectionState`), so it runs exactly once per connect and
        // also covers the reconnect path — do not refresh here (de-dup, G4).
      } catch (err) {
        frontendLog(
          "app_store",
          `Failed to connect agent ${agentId}: ${err instanceof Error ? err.message : String(err)}`
        );
        // No optimistic "disconnected" write: the backend emits "disconnected"
        // on every connect-failure path, so the event will drive the state.
        throw err;
      }
    },

    disconnectRemoteAgent: async (agentId) => {
      try {
        await apiDisconnectAgent(agentId);
      } catch (err) {
        frontendLog(
          "app_store",
          `Failed to disconnect agent ${agentId}: ${err instanceof Error ? err.message : String(err)}`
        );
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
      // Mutation cut (#2226): force the region entry to disconnected and clear its
      // live sessions/folders (the store's `disconnect` does exactly this).
      mirrorAgentIntent("agent.disconnect", { id: agentId });
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
      // Mutation cut (#2226): as with disconnect, force the region entry to
      // disconnected and clear its live sessions/folders.
      mirrorAgentIntent("agent.disconnect", { id: agentId });
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

      // Mutation cut (#2226): set the connection state in the region. This is the
      // single writer for `connectionState` (G4/#1234); the store's `set_status`
      // tracks `lastError` with the same rules as `nextLastError` above.
      mirrorAgentIntent("agent.status", { id: agentId, state: connectionState, error });

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
      // Mutation cut (#2226): empty the region's live-session list for the agent.
      mirrorAgentIntent("agent.clearSessions", { id: agentId });
    },

    setAgentCapabilities: (agentId, capabilities) => {
      set((state) => ({
        remoteAgents: state.remoteAgents.map((a) =>
          a.id === agentId ? { ...a, capabilities } : a
        ),
      }));
      // Mutation cut (#2226): record the negotiated capabilities in the region.
      mirrorAgentIntent("agent.setCapabilities", { id: agentId, capabilities });
    },

    updateAgentSettings: async (agentId, settings) => {
      await apiApplyAgentSettings(agentId, settings);
      set((state) => ({
        remoteAgents: state.remoteAgents.map((a) =>
          a.id === agentId ? { ...a, agentSettings: settings } : a
        ),
      }));
      // Mutation cut (#2226): apply just the settings in the region.
      mirrorAgentIntent("agent.applySettings", { id: agentId, agentSettings: settings });
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
        // Mutation cut (#2226): replace the agent's live sessions plus its saved
        // definitions and folders in the region in one shot (the once-per-connect
        // refresh set).
        mirrorAgentIntent("agent.refresh", {
          id: agentId,
          sessions,
          definitions: connectionsData.connections,
          folders: connectionsData.folders,
        });
      } catch (err) {
        frontendLog(
          "app_store",
          `Failed to refresh agent sessions for ${agentId}: ${err instanceof Error ? err.message : String(err)}`
        );
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
        // Mutation cut (#2226): upsert the saved definition in the region.
        mirrorAgentIntent("agent.saveDefinition", { id: agentId, definition: saved });
      } catch (err) {
        frontendLog(
          "app_store",
          `Failed to save agent definition on ${agentId}: ${err instanceof Error ? err.message : String(err)}`
        );
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
        // Mutation cut (#2226): remove the definition from the region.
        mirrorAgentIntent("agent.deleteDefinition", { id: agentId, definitionId });
      } catch (err) {
        frontendLog(
          "app_store",
          `Failed to delete agent definition on ${agentId}: ${err instanceof Error ? err.message : String(err)}`
        );
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
        // Mutation cut (#2226): replace the definition by id in the region.
        mirrorAgentIntent("agent.updateDefinition", { id: agentId, definition: updated });
      } catch (err) {
        frontendLog(
          "app_store",
          `Failed to update agent definition on ${agentId}: ${err instanceof Error ? err.message : String(err)}`
        );
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
        // Mutation cut (#2226): append the folder to the region.
        mirrorAgentIntent("agent.createFolder", { id: agentId, folder });
        toast.success(`Created folder ${folder.name}`);
      } catch (err) {
        frontendLog(
          "app_store",
          `Failed to create agent folder on ${agentId}: ${err instanceof Error ? err.message : String(err)}`
        );
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
        // Mutation cut (#2226): replace the folder by id in the region.
        mirrorAgentIntent("agent.updateFolder", { id: agentId, folder: updated });
        if (isRename) toast.success(`Renamed folder to ${updated.name}`);
      } catch (err) {
        frontendLog(
          "app_store",
          `Failed to update agent folder on ${agentId}: ${err instanceof Error ? err.message : String(err)}`
        );
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
        // Mutation cut (#2226): remove the folder and reparent its child
        // definitions to the root (the store's `delete_folder` does both).
        mirrorAgentIntent("agent.deleteFolder", { id: agentId, folderId });
      } catch (err) {
        frontendLog(
          "app_store",
          `Failed to delete agent folder on ${agentId}: ${err instanceof Error ? err.message : String(err)}`
        );
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
        // Mutation cut (#2226): replace the folder (with its flipped expansion) in
        // the region.
        mirrorAgentIntent("agent.updateFolder", { id: agentId, folder });
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
      mirrorFileBrowserIntent("fileBrowser.loadStarted", { pane: "local" });
      try {
        const entries = await localListDir(normalizedPath);
        set({
          localFileEntries: entries,
          localCurrentPath: normalizedPath,
          localFileLoading: false,
        });
        mirrorFileBrowserIntent("fileBrowser.loadSucceeded", {
          pane: "local",
          path: normalizedPath,
          entries,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        set({ localFileLoading: false, localFileError: message });
        mirrorFileBrowserIntent("fileBrowser.loadFailed", { pane: "local", error: message });
      }
    },

    refreshLocal: async () => {
      const { localCurrentPath } = useAppStore.getState();
      set({ localFileLoading: true, localFileError: null });
      mirrorFileBrowserIntent("fileBrowser.loadStarted", { pane: "local" });
      try {
        const entries = await localListDir(localCurrentPath);
        set({ localFileEntries: entries, localFileLoading: false });
        mirrorFileBrowserIntent("fileBrowser.loadSucceeded", {
          pane: "local",
          path: localCurrentPath,
          entries,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        set({ localFileLoading: false, localFileError: message });
        mirrorFileBrowserIntent("fileBrowser.loadFailed", { pane: "local", error: message });
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
      mirrorFileBrowserIntent("fileBrowser.loadStarted", { pane: "session" });
      try {
        const entries = await sessionListFiles(sessionId, path);
        set({
          sessionFileEntries: entries,
          sessionCurrentPath: path,
          sessionFileLoading: false,
        });
        mirrorFileBrowserIntent("fileBrowser.loadSucceeded", {
          pane: "session",
          path,
          entries,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        set({ sessionFileLoading: false, sessionFileError: message });
        mirrorFileBrowserIntent("fileBrowser.loadFailed", { pane: "session", error: message });
      }
    },

    refreshSession: async () => {
      const { sessionFileBrowserId, sessionCurrentPath } = useAppStore.getState();
      if (!sessionFileBrowserId) return;
      set({ sessionFileLoading: true, sessionFileError: null });
      mirrorFileBrowserIntent("fileBrowser.loadStarted", { pane: "session" });
      try {
        const entries = await sessionListFiles(sessionFileBrowserId, sessionCurrentPath);
        set({ sessionFileEntries: entries, sessionFileLoading: false });
        mirrorFileBrowserIntent("fileBrowser.loadSucceeded", {
          pane: "session",
          path: sessionCurrentPath,
          entries,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        set({ sessionFileLoading: false, sessionFileError: message });
        mirrorFileBrowserIntent("fileBrowser.loadFailed", { pane: "session", error: message });
      }
    },

    // File browser mode
    fileBrowserMode: "none",
    setFileBrowserMode: (mode) => {
      set({ fileBrowserMode: mode });
      mirrorFileBrowserIntent("fileBrowser.setMode", { mode });
    },

    // File clipboard (copy/cut)
    fileClipboard: null,
    setFileClipboard: (clipboard) => {
      set({ fileClipboard: clipboard });
      mirrorFileBrowserIntent("fileBrowser.setClipboard", { clipboard });
    },

    // VS Code availability
    vscodeAvailable: false,
    checkVscodeAvailability: async () => {
      try {
        const available = await checkVscode();
        set({ vscodeAvailable: available });
      } catch (err) {
        frontendLog(
          "app_store",
          `Failed to check VS Code availability: ${err instanceof Error ? err.message : String(err)}`
        );
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

    clearMonitoringError: (key) => {
      const entry = useAppStore.getState().monitors[key];
      if (!entry || entry.error === null) return;
      set((state) => {
        const current = state.monitors[key];
        if (!current || current.error === null) return {};
        return { monitors: { ...state.monitors, [key]: { ...current, error: null } } };
      });
      // Mutation cut (#2224): dismiss the error in the authoritative region too.
      mirrorMonitorIntent("monitor.clearError", { key });
    },

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
      // Mutation cut (#2224): mirror the connect start into the authoritative
      // `system-monitors` region. A no-op / logged fallback when the flag is off
      // or the transport is unavailable — the local slice above already applied.
      mirrorMonitorIntent("monitor.open", { key, host: host ?? key, intervalMs });

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
          mirrorMonitorIntent("monitor.stats", { key, stats });
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
          mirrorMonitorIntent("monitor.status", { key, status });
        });
        _monitoringStatusUnlisten.set(key, statusUnlisten);

        await sessionMonitoringOpen(key, intervalMs);
        upsertMonitor(key, { monitorSessionId: key, loading: false, status: "live" });
        mirrorMonitorIntent("monitor.opened", { key });
      } catch (err) {
        // The stats/status listeners are attached before the open that may throw
        // here. Detach them so a failed open never leaks a dangling Tauri
        // listener (monitorSessionId stays null, so disconnectMonitoring would
        // not clean it up either). See audit gap G5.
        frontendLog("monitoring", "detaching monitoring listeners after failed open");
        detachMonitorListeners(key);
        const errorMessage = err instanceof Error ? err.message : String(err);
        upsertMonitor(key, {
          monitorSessionId: null,
          loading: false,
          error: errorMessage,
          status: null,
        });
        mirrorMonitorIntent("monitor.openFailed", { key, error: errorMessage });
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

      // Mutation cut (#2224): drop each entry from the authoritative region. The
      // store's `close` retains the stats cache (as the local teardown does), and
      // the cache already tracks the last stats via `monitor.stats`, so the region
      // stays a faithful mirror of `appStore`.
      for (const k of keys) mirrorMonitorIntent("monitor.close", { key: k });
    },

    setMonitoringPaused: async (key, paused) => {
      const entry = useAppStore.getState().monitors[key];
      if (!entry) return;
      // Optimistically flag the entry; the backend session loop drives the
      // authoritative `status`, but the flag gates the local UI (neutral badge +
      // dimmed stats) immediately (#1233).
      upsertMonitor(key, { paused, status: paused ? "paused" : "live" });
      // Mutation cut (#2224): mirror the optimistic pause into the region.
      mirrorMonitorIntent("monitor.setPaused", { key, paused });
      if (entry.monitorSessionId) {
        try {
          await sessionMonitoringSetPaused(entry.monitorSessionId, paused);
        } catch (err) {
          frontendLog("monitoring", `set paused failed for ${key}: ${err}`);
          // Roll back the optimistic flag so the UI reflects reality.
          upsertMonitor(key, { paused: !paused });
          mirrorMonitorIntent("monitor.setPaused", { key, paused: !paused });
          throw err;
        }
      }
    },

    setMonitoringInterval: async (key, intervalMs) => {
      const entry = useAppStore.getState().monitors[key];
      if (!entry) return;
      upsertMonitor(key, { intervalMs });
      // Mutation cut (#2224): mirror the new cadence into the region.
      mirrorMonitorIntent("monitor.setInterval", { key, intervalMs });
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

    refreshConnectionTypes: async () => {
      try {
        const connectionTypes = await getConnectionTypes();
        set({ connectionTypes });
      } catch (err) {
        frontendLog(
          "app_store",
          `Failed to refresh connection types: ${err instanceof Error ? err.message : String(err)}`
        );
      }
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

    // Embedded Servers — data + lifecycle provided by createEmbeddedServersSlice (#2113).

    // Macros — library + recording + playback provided by createMacrosSlice (#2114).

    // Plugins — data + derived registries + lifecycle actions provided by
    // createPluginsSlice (#2115). `selectPlugin` stays here (tab factory).

    selectPlugin: (pluginId) =>
      set((state) => {
        const allLeaves = getAllLeaves(state.rootPanel);
        const plugin = state.plugins.find((p) => p.manifest.id === pluginId);
        const title = plugin ? plugin.manifest.name : "Plugin";

        // Reuse the single existing plugin-detail tab: re-point its meta/title at
        // the newly-selected plugin and activate it, rather than opening one tab
        // per plugin (matches Settings/Log-Viewer single-tab behaviour).
        for (const leaf of allLeaves) {
          const existing = leaf.tabs.find((t) => t.contentType === "plugin-detail");
          if (existing) {
            const rootPanel = updateLeaf(state.rootPanel, leaf.id, (l) => ({
              ...l,
              tabs: l.tabs.map((t) =>
                t.id === existing.id
                  ? { ...t, title, isActive: true, pluginDetailMeta: { pluginId } }
                  : { ...t, isActive: false }
              ),
              activeTabId: existing.id,
            }));
            return { rootPanel, activePanelId: leaf.id, selectedPluginId: pluginId };
          }
        }

        const targetPanelId = state.activePanelId ?? allLeaves[0]?.id;
        if (!targetPanelId) return { selectedPluginId: pluginId };

        const dummyConfig: ConnectionConfig = { type: "local", config: {} };
        const newTab = createTab(title, "local", dummyConfig, targetPanelId, "plugin-detail");
        (newTab as TerminalTab & { pluginDetailMeta: PluginDetailMeta }).pluginDetailMeta = {
          pluginId,
        };
        const rootPanel = updateLeaf(state.rootPanel, targetPanelId, (leaf) => {
          const tabs = leaf.tabs.map((t) => ({ ...t, isActive: false }));
          tabs.push(newTab);
          return { ...leaf, tabs, activeTabId: newTab.id };
        });
        return { rootPanel, activePanelId: targetPanelId, selectedPluginId: pluginId };
      }),

    // Macro recording (#1674) + playback (#1675) provided by createMacrosSlice (#2114).

    // Broadcast input (#1955)
    broadcastActive: false,
    broadcastSourceTabId: null,
    broadcastScope: "all",
    broadcastTargetTabIds: new Set<string>(),
    lastBroadcastScope: "all",

    startBroadcast: (scope, sourceTabId, targetTabIds) => {
      set({
        broadcastActive: true,
        broadcastScope: scope,
        lastBroadcastScope: scope,
        broadcastSourceTabId: sourceTabId,
        // The source is just another target — keeping the fan-out loop uniform.
        broadcastTargetTabIds: new Set<string>([sourceTabId, ...targetTabIds]),
      });
      // Mutation cut (#2242): mirror the start into the authoritative region. The
      // store reproduces `{source} ∪ targets` from the same args, so pass the raw
      // resolved targets (not the source-prefixed set). A no-op / logged fallback
      // when the flag is off or the transport is unavailable — the local slice
      // above already applied.
      mirrorBroadcastIntent("broadcast.start", { scope, sourceTabId, targetTabIds });
    },

    stopBroadcast: () => {
      set({
        broadcastActive: false,
        broadcastSourceTabId: null,
        broadcastTargetTabIds: new Set<string>(),
      });
      // Mutation cut (#2242): leave broadcast in the region too (scope/lastScope
      // retained by the store for the keyboard toggle, exactly as the slice).
      mirrorBroadcastIntent("broadcast.stop", {});
    },

    toggleBroadcast: () => {
      const state = get();
      // Second press (or any press while active) turns broadcast off, regardless
      // of which tab is focused — mirrors the toolbar toggle and the status-bar
      // Stop pill.
      if (state.broadcastActive) {
        get().stopBroadcast();
        return;
      }
      const source = getActiveTab(state);
      if (!source || source.contentType !== "terminal") {
        toast.info("Focus a terminal to start broadcasting input");
        return;
      }
      // Reuse the last scope, skipping the dropdown. A remembered "custom"
      // selection lives only in the picker and cannot be rebuilt here, so it
      // degrades to "all terminals" (#1958).
      const scope: BroadcastScope =
        state.lastBroadcastScope === "custom" ? "all" : state.lastBroadcastScope;
      const targets = resolveBroadcastTargetTabIds(state, scope, source.id);
      get().startBroadcast(scope, source.id, targets);
    },

    addBroadcastTarget: (tabId) => {
      // Read-then-set so the mirror fires only on a real change (a no-op add must
      // not dispatch a redundant intent), matching the store's pure set-insert.
      if (get().broadcastTargetTabIds.has(tabId)) return;
      set((state) => {
        if (state.broadcastTargetTabIds.has(tabId)) return {};
        const next = new Set(state.broadcastTargetTabIds);
        next.add(tabId);
        return { broadcastTargetTabIds: next };
      });
      // Mutation cut (#2242): mirror the membership add into the region.
      mirrorBroadcastIntent("broadcast.addTarget", { tabId });
    },

    removeBroadcastTarget: (tabId) => {
      if (!get().broadcastTargetTabIds.has(tabId)) return;
      set((state) => {
        if (!state.broadcastTargetTabIds.has(tabId)) return {};
        const next = new Set(state.broadcastTargetTabIds);
        next.delete(tabId);
        return { broadcastTargetTabIds: next };
      });
      // Mutation cut (#2242): mirror the membership removal into the region.
      mirrorBroadcastIntent("broadcast.removeTarget", { tabId });
    },

    isBroadcastTarget: (tabId) => get().broadcastTargetTabIds.has(tabId),

    getBroadcastTargetTabIds: () => {
      const state = get();
      if (!state.broadcastActive) return [];
      const statusMaps: TabStatusMaps = {
        terminalConnecting: state.terminalConnecting,
        terminalReconnectingTabs: state.terminalReconnectingTabs,
        terminalSpawnErrors: state.terminalSpawnErrors,
        terminalDisconnectErrors: state.terminalDisconnectErrors,
        terminalExitedTabs: state.terminalExitedTabs,
      };
      const tabsById = new Map(collectLiveTabs(state).map((t) => [t.id, t]));
      const result: string[] = [];
      for (const tabId of state.broadcastTargetTabIds) {
        const tab = tabsById.get(tabId);
        // Only connected terminal sessions receive input. Disconnected/
        // connecting sessions and non-terminal tabs are skipped silently.
        if (!tab || tab.contentType !== "terminal" || !tab.sessionId) continue;
        if (deriveTabStatus(statusMaps, tabId) !== "connected") continue;
        result.push(tabId);
      }
      return result;
    },

    refreshBroadcastMembership: () => {
      const state = get();
      if (!state.broadcastActive) return;
      const source = state.broadcastSourceTabId;
      if (!source) return;
      // Custom selection is frozen at pick time — never auto-add. Removal of
      // closed targets is handled at the tab-close seam.
      if (state.broadcastScope === "custom") return;
      const resolved = resolveBroadcastTargetTabIds(state, state.broadcastScope, source);
      const next = new Set<string>([source, ...resolved]);
      const prev = state.broadcastTargetTabIds;
      // Skip the update (and its re-render) when membership is unchanged.
      if (next.size === prev.size && [...next].every((id) => prev.has(id))) return;
      set({ broadcastTargetTabIds: next });
      // Mutation cut (#2242): the store owns no bulk-set intent, so reconcile the
      // region to the recomputed membership via granular add/remove intents for the
      // delta (mirroring the connected-terminal refresh at the fan-out seam).
      for (const id of next) {
        if (!prev.has(id)) mirrorBroadcastIntent("broadcast.addTarget", { tabId: id });
      }
      for (const id of prev) {
        if (!next.has(id)) mirrorBroadcastIntent("broadcast.removeTarget", { tabId: id });
      }
    },

    // Workflows (#1852)
    workflows: [],

    loadWorkflows: async () => {
      try {
        const workflows = await apiListWorkflows();
        set({ workflows });
      } catch (err) {
        frontendLog(
          "app_store",
          `Failed to load workflows: ${err instanceof Error ? err.message : String(err)}`
        );
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
        // Mutation + render cut (#2243): mirror the panel open (its status seam)
        // to the store + region. The streamed lines/exitCode/timedOut stay
        // frontend (#1865) — the store models only the panel's identity + status.
        mirrorWorkflowOutputOpened({ workflowId, workflowName: workflow.name, program, args });

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
      // Mutation + render cut (#2243): mirror the run start to the backend
      // `WorkflowRunStore` and the render region. Off/failure falls back to the
      // local reducers, which already ran above.
      mirrorWorkflowRunStarted({
        workflowId,
        workflowName: workflow.name,
        tabId: targetTabId,
        total,
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
            // Mutation + render cut (#2243): mirror the progress to the store +
            // region (guarded server-side to the still-current run).
            mirrorWorkflowStepAdvanced({ workflowId, tabId: targetTabId, completed });
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
        // Mutation + render cut (#2243): mirror the run's terminal outcome to the
        // store + region (settles the run and stamps the panel status). Only for
        // the still-current run — matching the `activeWorkflowRun === handle` guard.
        mirrorWorkflowRunSettled(
          result.status,
          result.status === "failed" ? result.error : undefined
        );
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
      // Mutation + render cut (#2243): mirror the dismissal to the store + region.
      mirrorWorkflowDismissOutput();
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
        frontendLog(
          "app_store",
          `Failed to load workspaces: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    },

    saveWorkspaceToBackend: async (definition) => {
      try {
        await apiSaveWorkspace(definition);
        await get().loadWorkspaces();
      } catch (err) {
        frontendLog(
          "app_store",
          `Failed to save workspace: ${err instanceof Error ? err.message : String(err)}`
        );
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
        frontendLog(
          "app_store",
          `Failed to duplicate workspace: ${err instanceof Error ? err.message : String(err)}`
        );
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
        frontendLog(
          "app_store",
          `Failed to save current layout as workspace: ${err instanceof Error ? err.message : String(err)}`
        );
        throw err;
      }
    },

    restoreInProgress: false,

    saveLastSession: async () => {
      const state = get();
      // Respect the setting at save time so toggling it takes effect immediately.
      // "never" means the user does not want a session kept, so skip the write.
      if ((await resolveRestoreMode(state.settings)) === "never") return;
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
        frontendLog(
          "app_store",
          `Failed to save last session: ${err instanceof Error ? err.message : String(err)}`
        );
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
          ? await filterSessionBySelection(loaded, new Set(selectedIndices))
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
        frontendLog(
          "app_store",
          `Failed to clear last session: ${err instanceof Error ? err.message : String(err)}`
        );
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
        const summary = await summarizeLastSession(session, get().connections);
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
        frontendLog(
          "app_store",
          `Failed to load credential store status: ${err instanceof Error ? err.message : String(err)}`
        );
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
        frontendLog(
          "app_store",
          `Failed to load app mode: ${err instanceof Error ? err.message : String(err)}`
        );
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
        mirrorSettingsIntent("settings.replace", { settings: updatedSettings });
      } catch (err) {
        frontendLog("update", `Failed to skip version: ${err}`);
      }
    },
    clearSkippedUpdateVersion: async () => {
      try {
        await apiClearSkippedVersion();
        const updatedSettings = await import("@/services/storage").then((m) => m.getSettings());
        set({ settings: updatedSettings, savedSettings: updatedSettings });
        mirrorSettingsIntent("settings.replace", { settings: updatedSettings });
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
