import { create } from "zustand";
import {
  TerminalTab,
  TabContent,
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
import {
  SavedConnection,
  ConnectionFolder,
  FileEntry,
  TransferState,
  AppSettings,
  RemoteAgentDefinition,
  AgentCapabilities,
  AgentSettings,
  LayoutConfig,
  DEFAULT_LAYOUT,
  LAYOUT_PRESETS,
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
  sftpCancelTransfer,
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
  AgentDefinitionInfo,
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
import type { ConnectionTypeInfo, ContainerSpawn, ShellSpawn } from "@/services/api";
import type { SpawnRequestPayload } from "@/services/events";
import { RemoteAgentConfig } from "@/types/terminal";
import { createTunnelSlice, TunnelSlice } from "./slices/tunnelSlice";
import { createEmbeddedServersSlice, EmbeddedServersSlice } from "./slices/embedded-serversSlice";
import { createMacrosSlice, MacrosSlice } from "./slices/macrosSlice";
import { createPluginsSlice, PluginsSlice } from "./slices/pluginsSlice";
import { createSessionHistorySlice, SessionHistorySlice } from "./slices/sessionHistorySlice";
import { createZoomSlice, ZoomSlice } from "./slices/zoomSlice";
import { createCommandPaletteSlice, CommandPaletteSlice } from "./slices/commandPaletteSlice";
import { createHttpMonitorsSlice, HttpMonitorsSlice } from "./slices/httpMonitorsSlice";
import { createDialogsSlice, DialogsSlice } from "./slices/dialogsSlice";
import {
  createRemoteDesktopResolutionsSlice,
  RemoteDesktopResolutionsSlice,
} from "./slices/remoteDesktopResolutionsSlice";
import { createPasswordPromptSlice, PasswordPromptSlice } from "./slices/passwordPromptSlice";
import { createTerminalSearchSlice, TerminalSearchSlice } from "./slices/terminalSearchSlice";

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
import { DEFAULT_MONITORING_INTERVAL_MS } from "@/types/monitoring";
import { onPersistentSessionStateChanged } from "@/services/events";
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
  buildLayoutSnapshot,
  composeLayoutState,
  type LayoutSnapshot,
  mirrorLayoutIntent,
  moveTabPayload,
  reseedLayoutRegion,
  subscribeLayoutRegion,
} from "@/store/layoutBridge";
import {
  ensureSessionSubscribed,
  logSessionBridgeFallback,
  mirrorSessionIntent,
  onSessionView,
  sessionBackendReattachEnabled,
  sessionIntentsEnabled,
  type SessionIntentKind,
} from "@/store/sessionBridge";
import {
  currentMonitorsView,
  dispatchMonitorIntentBestEffort,
  ensureMonitorsSubscribed,
} from "@/store/systemMonitorBridge";
import { currentAgentsView, ensureAgentsSubscribed, mirrorAgentIntent } from "@/store/agentsBridge";
import {
  currentConnectionsView,
  ensureConnectionsSubscribed,
  mirrorConnectionIntent,
} from "@/store/connectionsBridge";
import { currentFileBrowsersView, mirrorFileBrowserIntent } from "@/store/fileBrowsersBridge";
import { dispatchTransferIntentBestEffort } from "@/store/transfersBridge";
import {
  currentSettingsView,
  ensureSettingsSubscribed,
  mirrorSettingsIntent,
} from "@/store/settingsBridge";
import { currentBroadcastView, dispatchBroadcastIntentBestEffort } from "@/store/broadcastBridge";
import {
  currentRestoreCohortView,
  mirrorRestoreBegin,
  mirrorRestoreSettle,
  setRestoreSettlementRenderer,
  type ProjectedSettlement,
} from "@/store/restoreCohortBridge";
import {
  appendWorkflowOutputLine,
  clearWorkflowOutputContent,
  dispatchWorkflowDismissOutput,
  dispatchWorkflowOutputOpened,
  dispatchWorkflowRunSettled,
  dispatchWorkflowRunStarted,
  dispatchWorkflowStepAdvanced,
  ensureWorkflowSubscribed,
  openWorkflowOutputContent,
  setWorkflowOutputProcessResult,
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
  sourceMode: "local" | "session";
  sourcePath: string;
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
    CommandPaletteSlice,
    HttpMonitorsSlice,
    DialogsSlice,
    RemoteDesktopResolutionsSlice,
    PasswordPromptSlice,
    TerminalSearchSlice {
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

  // Password prompt — the promise-based interactive host/SSH password prompt
  // (open flag, host/username, pending resolver, "Save password" choice) plus
  // requestPassword / submitPassword / dismissPasswordPrompt is provided by
  // PasswordPromptSlice (extracted under #2077 via #2300).

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
   * Flat by-id map of non-structural tab content (part of #2283 — the layout
   * data-flow inversion). As the layout projection region takes over the panel
   * **tree structure**, each tab's rich **content** (title, config, connection
   * metadata, session id, all `*Meta` editor state, …) stays authoritative in
   * `appStore`, keyed by tab id — mirroring the deliberate content retention in
   * the file-browser inversion. Render composition
   * ({@link import("./useLayoutRenderTree").useLayoutRenderTree}) sources content
   * from here, falling back to the in-tree {@link TerminalTab} for any id not yet
   * present (editor/settings/etc. tabs). Populated for tabs opened via `addTab`
   * (and hydrated window-handoff tabs) and maintained on the content mutations
   * that touch those tabs (title, session id, scrollback-replay flag); pruned in
   * `closeTab`. In this behavior-preserving slice it merely duplicates content
   * the tree still holds.
   */
  tabContent: Record<string, TabContent>;
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
  /**
   * Open (or focus) an editor tab for a file.
   *
   * A remote tab is backed by the protocol-agnostic session layer via
   * `sessionBrowser` (SSH, FTP, Docker, agent sessions — #1557 / #2422).
   */
  openEditorTab: (
    filePath: string,
    isRemote: boolean,
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

  // Connections — the saved-connection / folder tree is region-authoritative
  // (#2401): it lives only in the shared `connections` projection region, read
  // via `useProjectedConnections()` / `currentConnectionsView()`. `appStore` holds
  // no connections/folders slice; the lifecycle actions below are thin
  // backend-command wrappers.

  // Settings — the persisted `AppSettings` document is region-authoritative
  // (#2404): it lives only in the shared `settings` projection region, read via
  // `useProjectedSettings()` / `currentSettingsView()`. `appStore` holds no
  // settings/savedSettings slice; the setters below (updateSettings /
  // updateShellIntegration / skipUpdate / clearSkippedUpdateVersion) are thin
  // command wrappers that dispatch the optimistic `settings.*` intent and persist,
  // relying on the server-side fold (#2386 / #2407).

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

  // Terminal search (runtime-only) — per-tab search-bar visibility + set/toggle
  // provided by TerminalSearchSlice (extracted under #2077 via #2300).

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

  // Dialogs — large-paste / open-saved-file / export-import / recovery-warning
  // open/close flags provided by DialogsSlice (extracted under #2077 via #2300).
  // loadFromBackend still populates recoveryWarnings/recoveryDialogOpen via the
  // shared set.

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
   * `save_shell_integration_settings` command. Optimistically patches `nextSi`
   * into the authoritative `settings` region (a `settings.patch`), then on backend
   * failure rolls the region back to the previously-projected shell-integration
   * value and re-throws so the caller can surface the error. Resolves with the
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

  // File browser — SFTP transfers
  //
  // The legacy `SftpManager`/`sftpSessionId` browser session model was retired
  // once SSH file browsing + editing converged onto the session path
  // (#2313 / #2421 / #2422); the SFTP-backed session now drives file ops and its
  // transfers register on the `transfers` map below keyed by the session id.

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
   * The **Transfer Queue panel** slice (rows keyed by `transferId` + the
   * panel-minimized flag) is no longer held in `appStore`. Since #2229 the shared
   * `transfers` projection region is authoritative — the backend folds the live
   * `transfer-progress` stream into it at the source (#2387) — so the panel reads
   * the rows via {@link import("./useProjectedTransfers").useProjectedTransfers}
   * and the panel-only mutations below dispatch client `transfer.*` intents
   * against that region. The transient {@link transfers} map (above) is separate
   * and stays authoritative in `appStore`.
   *
   * Remove a single queue row (per-row Remove control) via `transfer.remove`.
   */
  removeTransfer: (id: string) => void;
  /**
   * Remove every `completed` row (footer Clear Completed) via
   * `transfer.clearCompleted`; failed/cancelled stay.
   */
  clearCompleted: () => void;
  /**
   * Collapse/expand the panel to/from its status-bar indicator via
   * `transfer.setMinimized`.
   */
  setTransferQueueMinimized: (minimized: boolean) => void;

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
  /**
   * Tabs whose next reconnect must start a **fresh** session rather than
   * re-attach to a retained one (#2512). Set by {@link startFreshShellForTab} when
   * the user picks "start new shell" on the session-lost notice: the reconnect
   * effect consumes the flag and skips the backend re-attach / persistent-restart
   * branches, going straight to a fresh `create_connection`. Runtime-only,
   * one-shot (consumed by the effect).
   */
  terminalForceFreshReconnect: Record<string, boolean>;
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
   * Settle a backend-driven agent reconnect (#2476) that the **backend** gave up
   * on. The backend redrive owns the reconnect outcome under the
   * `sessionBackendReattach` flag, so when its park/retry loop exhausts (folds
   * `reconnectFailed` → `Failed`/`gaveup` in the region), the frontend must
   * reflect that terminal state directly rather than routing through the client
   * reconnect reducer (whose local attempt counter is not the authority here).
   * Clears the loop record + every in-flight connect flag and shows the disconnect
   * overlay with the give-up error, WITHOUT re-mirroring any `session.*` intent
   * (the backend already folded the give-up — mirroring would be a redundant,
   * possibly divergent, second signal).
   */
  settleBackendReconnectGaveUp: (tabId: string, error: string) => void;

  /**
   * Settle a resilient agent tab into the terminal **session-lost** state (#2512):
   * the backend re-established the transport on reconnect but the live agent
   * session could not be recovered, so it folded `session.sessionLost` into the
   * region. This reflects that locally — clearing the loop record + every in-flight
   * connect flag and marking the tab exited so the disconnect overlay mounts and
   * renders the projected session-lost notice (its "start new shell" action). Does
   * NOT set a disconnect error (the notice sources its message from the region) and
   * does NOT re-mirror any `session.*` intent (the backend already folded it).
   */
  settleSessionLost: (tabId: string) => void;

  /**
   * Start a fresh shell for a tab from the session-lost notice (#2512): arm the
   * one-shot {@link terminalForceFreshReconnect} flag and drive a reconnect, so the
   * effect creates a brand-new session (an explicit `create_connection`) instead of
   * attempting to re-attach the unrecoverable one.
   */
  startFreshShellForTab: (tabId: string) => void;

  /**
   * Register the cohort of tabs placed by a restore/launch (#1146, audit G4).
   * When a restore or workspace launch places N tabs, each reconnects
   * independently inside its own Terminal.tsx mount, so failures are otherwise
   * only visible per-tab. This dispatches `restore.beginCohort` to the
   * authoritative `restore-cohort@<clientId>` region, which tracks the cohort and
   * raises a single aggregate summary toast once every tab settles.
   *
   * `pendingTabIds` are the live terminal tabs that will attempt to connect;
   * `preFailedCount` counts tabs already known to have failed at build time (e.g.
   * agent-error tabs that never emit a connect/fail signal). `toastId`, when
   * given, is a pending toast the settle should resolve in place instead of
   * raising a fresh one. A cohort with nothing to wait on settles immediately.
   */
  beginRestoreCohort: (
    pendingTabIds: string[],
    preFailedCount: number,
    toastId?: string | number
  ) => void;
  /** Settle one tab of the active restore cohort (dispatches `restore.settleTab`);
   * the region raises the summary once the cohort empties. */
  settleRestoreTab: (tabId: string, outcome: "connected" | "failed") => void;
  /**
   * Bulk-retry every failed tab remembered from the last partial restore (the
   * region's captured failed-tab set, {@link currentRestoreCohortView}) in one
   * action (#1227, audit M2). Re-drives only the tabs that still exist as live
   * terminals through the existing per-tab {@link reconnectTerminal} path,
   * registers a fresh cohort so the outcome re-summarizes, and shows a pending
   * toast that resolves into the aggregate result.
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

  // Remote agents — the ordered agent list plus each agent's live sessions, saved
  // definitions and folders are region-authoritative (#2409): they live only in the
  // shared `agents` projection region, read via `useProjectedAgents()` /
  // `currentAgentsView()`. `appStore` holds no agents slice; the lifecycle actions
  // below are thin backend-command wrappers. The per-client update sub-slices below
  // (`agentUpdates` / `agentUpdatesDismissed` / `agentUpdatePending`) are
  // presentation state the region does not model and stay here.
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

  // File browser — the view (active pane, per-pane cwd/listing/loading/error, and
  // the copy-cut clipboard) no longer lives in `appStore` (#2283): it is owned by
  // the backend `FileBrowserStore` and projected through the authoritative
  // client-scoped `file-browser@<clientId>` region. Readers use
  // {@link import("./useProjectedFileBrowsers").useProjectedFileBrowsers}
  // (components) or {@link import("./fileBrowsersBridge").currentFileBrowsersView}
  // (store-side). The actions below do the async list op and report each transition
  // through a granular `fileBrowser.*` intent, which the bridge overlays
  // optimistically and the store confirms.

  // Local file browser
  navigateLocal: (path: string) => Promise<void>;
  refreshLocal: () => Promise<void>;

  // Session-based file browser (for remote-session tabs)
  /**
   * Terminal session ID used for session-based file browsing. This is the backend
   * session model — a per-client pointer to the active terminal session, set
   * imperatively from the active tab — not part of the projected view, so it stays
   * an `appStore` field (it gates `isConnected` and targets the session file ops).
   */
  sessionFileBrowserId: string | null;
  navigateSession: (sessionId: string, path: string) => Promise<void>;
  refreshSession: () => Promise<void>;
  setSessionFileBrowserId: (sessionId: string | null) => void;

  // File browser mode
  setFileBrowserMode: (mode: "local" | "session" | "none") => void;

  // File clipboard (copy/cut)
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
  //
  // The per-host/session monitoring state (`monitors` map + `monitoringStatsCache`)
  // no longer lives in `appStore` (#2224): it is owned by the backend
  // `SystemMonitorStore` and projected through the authoritative `system-monitors`
  // region. Readers use {@link import("./useProjectedMonitors").useProjectedMonitors}
  // (components) or {@link import("./systemMonitorBridge").currentMonitorsView}
  // (store-side). The lifecycle actions below drive the backend commands, which
  // fold the transitions at the source; the few client-originated transitions with
  // no backend command dispatch a `monitor.*` intent against the region directly.
  /**
   * Subscribe the terminal session `sessionId` to its `MonitoringProvider` push
   * path, keying the entry by `sessionId`. `host` is the human-readable label
   * shown in the status bar. All monitors — desktop-direct SSH and
   * remote-session alike — flow through this single path (#1232). The backend
   * owns entry creation and the connect outcome (#2224); this action calls the
   * `session_monitoring_open` command and the region reflects the result.
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

  // Remote-desktop resolutions — the live per-session framebuffer WxH provided
  // by RemoteDesktopResolutionsSlice (#1709, extracted under #2077 via #2300).

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
  // The membership state (`active` / `sourceTabId` / `scope` / `targetTabIds` /
  // `lastScope`) lives in the authoritative `broadcast@<clientId>` projection
  // region (#2206), read via `useProjectedBroadcast` / `currentBroadcastView`; the
  // actions below dispatch `broadcast.*` intents. `appStore` holds no broadcast
  // state — these methods only orchestrate against the live tab tree.
  /** Enter broadcast mode with the given scope, source tab, and target tabs. */
  startBroadcast: (scope: BroadcastScope, sourceTabId: string, targetTabIds: string[]) => void;
  /** Leave broadcast mode and clear the source/target selection. */
  stopBroadcast: () => void;
  /**
   * Toggle broadcast from the keyboard shortcut (#1958). When broadcast is
   * active it stops; otherwise it starts against the active terminal tab using
   * the remembered last scope — skipping the scope dropdown. A remembered
   * `"custom"` scope cannot be reconstructed without the picker, so the shortcut
   * falls back to `"all"`. Emits a hint toast when no terminal tab is focused
   * (nothing to broadcast from).
   */
  toggleBroadcast: () => void;
  /** Add a tab to the broadcast target set (no-op when inactive). */
  addBroadcastTarget: (tabId: string) => void;
  /** Remove a tab from the broadcast target set. */
  removeBroadcastTarget: (tabId: string) => void;
  /** Whether the given tab is currently a broadcast target. */
  isBroadcastTarget: (tabId: string) => boolean;
  /**
   * The subset of the broadcast target set that are *connected* terminal tabs —
   * the tabs the `onData` fan-out should mirror input to. Disconnected,
   * connecting, and non-terminal tabs are filtered out silently. Returns `[]`
   * when broadcast is inactive. Resolution of each tab id to a live session id
   * is done by the terminal registry at the dispatch seam.
   */
  getBroadcastTargetTabIds: () => string[];
  /**
   * Recompute the broadcast target set for the active scope so membership tracks
   * tabs opening during an active broadcast (#1956). No-op when inactive.
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
  /** Dismiss the inline run-output surface (clears the projected panel + streamed
   * content). The panel's live state is projected — see {@link
   * import("@/store/useProjectedWorkflowRun").useProjectedWorkflowRun}. */
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
 * - Session layer (`sessionBrowser`) → the id of the terminal tab that owns the
 *   session. A reconnect swaps the session id but keeps the same tab.
 *
 * Returns `undefined` for local tabs and for remote tabs whose identity cannot
 * be resolved (no owning tab found); callers then fall back to path-only dedup,
 * preserving the pre-#1599 behaviour.
 */
function resolveEditorSessionKey(
  state: { rootPanel: PanelNode },
  isRemote: boolean,
  sessionBrowser?: EditorSessionRef
): string | undefined {
  if (!isRemote) return undefined;
  if (sessionBrowser) {
    const owner = getAllLeaves(state.rootPanel)
      .flatMap((l) => l.tabs)
      .find((t) => t.sessionId === sessionBrowser.sessionId);
    return owner ? `session:${owner.id}` : undefined;
  }
  return undefined;
}

/**
 * Derive the sudo host label (`user@host:port`) for a session-backed remote
 * editor tab, or `null` when none applies.
 *
 * The file editor's sudo flow uses this label to (a) name the host in the
 * sudo-password prompt and (b) namespace the optional credential-store entry for
 * a remembered sudo password. Two properties are load-bearing (#2424 / #2426):
 *
 * - **Reconnect-stable** — the saved sudo password must keep resolving after the
 *   owning terminal reconnects. The owning tab is therefore located by its
 *   *stable id* (encoded in the editor tab's reconnect-stable `sessionKey`,
 *   `session:<owningTabId>`), falling back to the live `sessionBrowser.sessionId`
 *   only when no `sessionKey` is present. A reconnect swaps the session id but
 *   keeps the tab (and its connection config), so the label value is unchanged.
 * - **Byte-identical to the legacy SFTP label** — before SSH file editing
 *   converged onto the session path (#2420 / #2421) and the `sftpSessionId` model
 *   was retired (#2422), this label came from `sftpSessions[id].hostLabel`, built
 *   as `${username}@${host}:${port}` from the connection config. Reproducing that
 *   exact string here means sudo passwords saved before the convergence still
 *   resolve — the migration does not orphan them.
 *
 * Returns `null` for local tabs, tabs whose owning terminal cannot be found, and
 * non-labelable backends (e.g. Docker / FTP / agent, which carry no
 * `user@host:port`); callers then fall back to the file path, preserving the
 * pre-convergence graceful-degradation behaviour.
 */
export function deriveEditorHostLabel(
  state: { rootPanel: PanelNode },
  meta: Pick<EditorTabMeta, "isRemote" | "sessionBrowser" | "sessionKey">
): string | null {
  if (!meta.isRemote || !meta.sessionBrowser) return null;
  const tabs = getAllLeaves(state.rootPanel).flatMap((l) => l.tabs);
  const owningTabId = meta.sessionKey?.startsWith("session:")
    ? meta.sessionKey.slice("session:".length)
    : undefined;
  const owner =
    (owningTabId ? tabs.find((t) => t.id === owningTabId) : undefined) ??
    tabs.find((t) => t.sessionId === meta.sessionBrowser?.sessionId);
  if (!owner) return null;
  const cfg = owner.config.config;
  const { username, host, port } = cfg;
  // A labelable connection (SSH) carries all three; byte-based backends
  // (Docker / FTP / agent) don't, so they fall through to the path fallback.
  if (typeof host !== "string" || host === "" || typeof username !== "string" || port == null) {
    return null;
  }
  return `${username}@${host}:${port}`;
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
 * Whether a tab is eligible for resilient reconnect. Two distinct populations,
 * both excluding persistent sessions (those have their own continuity machinery):
 *
 * - **Agentless direct SSH (#1962):** a plain SSH terminal whose saved connection
 *   opted in via the "Resilient Reconnect" setting. Client-driven backoff loop.
 * - **Agent-hosted (#2476):** a shell session on a remote agent, resilient **only
 *   when the `sessionBackendReattach` flag is on**. The agent reconnect is
 *   backend-driven (park + retry + new-sessionId re-attach); the flag is its
 *   master switch. With the flag OFF this returns `false` for every agent tab —
 *   byte-identical to the pre-#2476 `if (cfg.agentId) return false` behavior.
 *
 * Reads the opt-in / agent marker from the tab's connection config.
 */
function isResilientReconnectTab(tab: TerminalTab | undefined): boolean {
  if (!tab) return false;
  if (tab.contentType !== "terminal") return false;
  if (tab.persistentConnectionId) return false;
  const cfg = tab.config?.config as { resilientReconnect?: unknown; agentId?: unknown } | undefined;
  if (!cfg) return false;
  if (cfg.agentId) {
    // Agent-hosted tab (#2476): resilient iff the backend-reattach flag is on.
    // Flag off ⇒ false ⇒ byte-identical to develop (agents were always excluded).
    return sessionBackendReattachEnabled();
  }
  if (tab.connectionType !== "ssh") return false;
  return cfg.resilientReconnect === true;
}

/**
 * Whether the tab identified by `tabId` is a resilient-reconnect tab, resolved
 * from the live store exactly as `setTerminalExited`'s drop classification does
 * (#2439). Passed to the backend at connect time (via `createTerminal`) so a
 * genuine drop can be folded server-side — `session.reconnect` for a resilient
 * tab, `session.dropped` otherwise — converging with the client mirror. An
 * unknown/closed tab is not resilient.
 */
export function isResilientReconnectTabId(tabId: string): boolean {
  const tab = collectLiveTabs(useAppStore.getState()).find((t) => t.id === tabId);
  return isResilientReconnectTab(tab);
}

/**
 * Whether `tabId` is an **agent-hosted** tab whose reconnect is driven entirely
 * by the backend redrive under the `sessionBackendReattach` flag (#2476), as
 * opposed to an agentless direct-SSH resilient tab (#1962/#2457) whose reconnect
 * the client still drives (with the backend-reattach id as a fast path).
 *
 * This is the discriminator for the two agent-specific cuts of the activation:
 *  - `Terminal.tsx` routes only these tabs through the give-up-aware wait that
 *    stays deferred to the backend loop across a prolonged drop (never falling
 *    through to the non-idempotent client agent engine — the double-drive fix);
 *  - `reconnectTerminal` skips arming the fixed 90 s "connecting" deadline for
 *    these tabs, since the backend park/retry legitimately outlasts it and the
 *    give-up fold — not a client wall-clock timeout — is what settles the tab.
 *
 * Flag off ⇒ always `false` (no agent tab is resilient), so both cuts are inert
 * and every path is byte-identical to develop.
 */
export function isBackendDrivenAgentReconnectTabId(tabId: string): boolean {
  if (!sessionBackendReattachEnabled()) return false;
  const tab = collectLiveTabs(useAppStore.getState()).find((t) => t.id === tabId);
  if (!tab) return false;
  if (tab.persistentConnectionId) return false;
  const cfg = tab.config?.config as { agentId?: unknown } | undefined;
  const isAgentTab = tab.config?.type === "remote-session" || !!cfg?.agentId;
  return isAgentTab && isResilientReconnectTab(tab);
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
  //
  // Backend-reattach authority cut (#2454): when `sessionBackendReattach` is on,
  // the backend redrive owns the attempt OUTCOME — it folds `connected` /
  // `reconnectFailed` at the source. The client must NOT also mirror those, since
  // the reconnect engine is non-idempotent (a double `failure` would
  // double-count the attempt and give up early). So `success` / `failure` are
  // suppressed here under the flag; the local record still settles for the
  // overlay, but the intent is the backend's to drive. `drop` (idempotent, also
  // folded server-side) and `cancel` (user-originated — the backend cannot
  // observe it otherwise, and it is how a user stop reaches `cancelReconnect`)
  // stay client-driven.
  const cutOn = sessionIntentsEnabled();
  const backendOwnsOutcome =
    sessionBackendReattachEnabled() && (event === "success" || event === "failure");
  if (cutOn && event !== "attempt" && !backendOwnsOutcome) {
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
 * Derive the monitor key for a tab: the id of the terminal session that owns the
 * monitor. Every monitor — desktop-direct SSH and remote-session alike — routes
 * through the session-based `MonitoringProvider` push path (#1232), so the key is
 * uniformly the session id. Returns `null` when the tab has no session yet (so it
 * cannot be monitored).
 *
 * Monitor entries themselves live in the authoritative `system-monitors` region
 * (#2224), not in `appStore`: read them with
 * {@link import("./useProjectedMonitors").useProjectedMonitors} (components) or
 * {@link import("./systemMonitorBridge").currentMonitorsView} (store-side), then
 * index by this key.
 */
export function monitorKeyForTab(tab: TerminalTab | null | undefined): string | null {
  return tab?.sessionId ?? null;
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
 * Project a rich {@link TerminalTab} onto its {@link TabContent} — everything
 * except the structural `panelId`/`isActive`, which belong to the panel tree.
 * This is the shape stored in `appStore.tabContent` (part of #2283).
 */
export function extractTabContent(tab: TerminalTab): TabContent {
  const { panelId: _panelId, isActive: _isActive, ...content } = tab;
  return content;
}

/** Insert/replace a tab's entry in the by-id content map from its rich form. */
function setTabContentEntry(
  map: Record<string, TabContent>,
  tab: TerminalTab
): Record<string, TabContent> {
  return { ...map, [tab.id]: extractTabContent(tab) };
}

/**
 * Build a comprehensive by-id {@link TabContent} map from every tab across every
 * group — the active group's live tree overriding its (stale) `tabGroups` entry
 * (#2283 / #2539). Used where a whole layout is (re)built — workspace restore and
 * the agent-error → terminal conversion — so **every** tab type, including
 * `agent-error`, is tracked in the map rather than falling back to the in-tree
 * copy. Tabs not present in any group are dropped, matching the map's invariant
 * that it holds exactly the live tabs.
 */
function tabContentFromGroups(
  tabGroups: TabGroup[],
  activeGroupId?: string,
  activeRoot?: PanelNode
): Record<string, TabContent> {
  const map: Record<string, TabContent> = {};
  for (const g of tabGroups) {
    const tree = activeRoot && g.id === activeGroupId ? activeRoot : g.rootPanel;
    for (const leaf of getAllLeaves(tree)) {
      for (const t of leaf.tabs) map[t.id] = extractTabContent(t);
    }
  }
  return map;
}

/**
 * Patch specific content fields of a tab **already tracked** in the map. A tab
 * absent from the map (e.g. an editor/settings tab that renders via the in-tree
 * fallback) is left untouched — this preserves the invariant that the map holds
 * only tabs whose every content mutation is instrumented, so a tracked entry is
 * never stale.
 */
function patchTabContentEntry(
  map: Record<string, TabContent>,
  tabId: string,
  patch: Partial<TabContent>
): Record<string, TabContent> {
  const current = map[tabId];
  if (!current) return map;
  return { ...map, [tabId]: { ...current, ...patch } };
}

/**
 * The rich multi-group {@link LayoutSnapshot} of `appStore`'s current layout —
 * the seed / overlay payload passed to {@link mirrorLayoutIntent} (#2283 slice
 * D'). The active group's live tree is the top-level `rootPanel`/`activePanelId`;
 * every other group comes from its `tabGroups` entry.
 */
function currentLayoutSnapshot(state: {
  tabGroups: TabGroup[];
  activeTabGroupId: string;
  rootPanel: PanelNode;
  activePanelId: string | null;
}): LayoutSnapshot {
  return buildLayoutSnapshot(
    state.tabGroups,
    state.activeTabGroupId,
    state.rootPanel,
    state.activePanelId
  );
}

/**
 * The four layout fields the region→appStore mirror owns (#2283 slice E2). A
 * structural op's reducer no longer writes these to `appStore`; it computes them
 * so the `post` snapshot can be dispatched, and the mirror composes them back.
 */
const MIRROR_LAYOUT_KEYS = new Set<keyof AppState>([
  "rootPanel",
  "activePanelId",
  "tabGroups",
  "activeTabGroupId",
]);

/** The **non-layout** portion of a reducer result — everything the mirror does
 * NOT own (e.g. `zoomedTabId`, `tabContent`, the per-tab maps). Set locally; the
 * mirror sets the layout fields from the dispatched region view. */
function nonLayoutPartial(next: Partial<AppState>): Partial<AppState> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(next)) {
    if (!MIRROR_LAYOUT_KEYS.has(key as keyof AppState)) {
      out[key] = (next as Record<string, unknown>)[key];
    }
  }
  return out as Partial<AppState>;
}

/** The `post` layout snapshot a reducer result implies, merged over the prior
 * state — the overlay the region mirror composes back (#2283 slice E2). */
function postLayoutSnapshot(prev: AppState, next: Partial<AppState>): LayoutSnapshot {
  return currentLayoutSnapshot({
    tabGroups: next.tabGroups ?? prev.tabGroups,
    activeTabGroupId: next.activeTabGroupId ?? prev.activeTabGroupId,
    rootPanel: next.rootPanel ?? prev.rootPanel,
    activePanelId: "activePanelId" in next ? (next.activePanelId ?? null) : prev.activePanelId,
  });
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
 * `sessionId`. Since the SFTP convergence (#2421 / #2422) a file browser transfers
 * on the tab's own session id — there is no separate SFTP sidebar session — so a
 * Transfer Queue row is attributed to `tab` when its `sessionId` matches, and the
 * rows follow the tab across a window move.
 */
function tabTransferSessionIds(tab: TerminalTab): string[] {
  const ids = new Set<string>();
  if (tab.sessionId) ids.add(tab.sessionId);
  return [...ids];
}

/**
 * Build the hand-off record for `tab`, returning the transfer session ids that
 * belong to it so the caller can release them from this window's transient
 * `transfers` map (#1951 / #1964).
 *
 * The persistent Transfer Queue rows are **no longer carried** across the window
 * boundary: since #2229 the queue lives in the shared, authoritative `transfers`
 * projection region, so the destination window already sees the same rows — there
 * is nothing to ferry. The transient `transfers` map (Open Connections / footer /
 * status bar) is still per-window, so its session ids are released here and
 * re-folded from live events in the destination.
 */
function buildTransferAwareHandoff(tab: TerminalTab): {
  record: TabHandoffRecord;
  transferSessionIds: string[];
} {
  const transferSessionIds = tabTransferSessionIds(tab);
  const record: TabHandoffRecord = { tab: serializeHandoffTab(tab) };
  return { record, transferSessionIds };
}

/**
 * Source-side state changes when a tab's transfers are handed to another window
 * (#1951): drop the transient {@link AppState.transfers} rows for the moved
 * session(s) and add their session ids to {@link AppState.releasedTransferSessions}
 * so broadcast progress events can no longer re-create those transient rows in
 * this window. Returns a partial state slice.
 *
 * The persistent Transfer Queue is region-authoritative and shared (#2229), so it
 * is not touched here — only the per-window transient `transfers` map is.
 */
function removeTransferSessionsFromWindow(
  state: {
    transfers: Record<string, TransferState>;
    releasedTransferSessions: string[];
  },
  transferSessionIds: string[]
): Partial<{
  transfers: Record<string, TransferState>;
  releasedTransferSessions: string[];
}> {
  if (transferSessionIds.length === 0) return {};
  const releaseSet = new Set(transferSessionIds);
  const transfers = Object.fromEntries(
    Object.entries(state.transfers).filter(([, t]) => !releaseSet.has(t.sessionId))
  );
  const releasedTransferSessions = Array.from(
    new Set([...state.releasedTransferSessions, ...transferSessionIds])
  );
  return { transfers, releasedTransferSessions };
}

/** State slice needed to decide whether this window renders/owns a session. */
type OwnershipView = {
  tabGroups: TabGroup[];
  activeTabGroupId: string;
  rootPanel: PanelNode;
  sessionOwners: Record<string, string>;
  windowLabel: string;
};

/**
 * Whether this window renders `sessionId` locally (#1964): a live tab in any of
 * this window's tab groups is bound to it. This is authoritative for *this*
 * window regardless of how fresh {@link AppState.sessionOwners} is, so the owning
 * window never suppresses (nor prunes) a row for a session it is actually showing.
 */
function windowRendersSession(
  state: {
    tabGroups: TabGroup[];
    activeTabGroupId: string;
    rootPanel: PanelNode;
  },
  sessionId: string
): boolean {
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
 * Drop transient {@link AppState.transfers} rows for sessions a fresh ownership
 * snapshot shows are owned by a *different* window (#1964) — the
 * belt-and-suspenders that clears a row this window may have folded before it
 * learned another window owns the session. Rows this window renders locally are
 * always kept, so a stale snapshot can never evict a live row.
 *
 * The persistent Transfer Queue is region-authoritative and shared (#2229), so it
 * is not pruned here — only the per-window transient `transfers` map is.
 */
function pruneForeignTransfers(
  state: OwnershipView & {
    transfers: Record<string, TransferState>;
  },
  owners: Record<string, string>
): Partial<Pick<AppState, "transfers">> {
  const view: OwnershipView = { ...state, sessionOwners: owners };
  const isForeign = (sessionId: string) => !windowOwnsTransferSession(view, sessionId);
  const transfers = Object.fromEntries(
    Object.entries(state.transfers).filter(([, t]) => !isForeign(t.sessionId))
  );
  const result: Partial<Pick<AppState, "transfers">> = {};
  if (Object.keys(transfers).length !== Object.keys(state.transfers).length) {
    result.transfers = transfers;
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

export const useAppStore = create<AppState>((set, get, store) => {
  // Connection-tree state is region-authoritative (#2401, PR B): the saved
  // connections / folders live only in the shared `connections` projection
  // region, fed server-side by every persist / remove / reload command's
  // `fold_connections_from_manager` (#2389 / #2394). The tree lifecycle actions
  // below are thin backend-command wrappers — they dispatch the optimistic
  // `connection.*` intent and call the persist command; the command's fold
  // reconciles the authoritative truth (persisted id, dedup rename, external
  // overlay) back into the region, so there is no frontend reload / id-reconcile
  // pass any more (that was the `appStore`-slice-era code). Reads source the
  // inventory synchronously from `currentConnectionsView()`.

  const initialPanel = createLeafPanel();
  const initialGroupId = generateGroupId();
  const initialGroup: TabGroup = {
    id: initialGroupId,
    name: "Main",
    rootPanel: initialPanel,
    activePanelId: initialPanel.id,
  };

  /**
   * Run a layout reducer as a region-authoritative op (#2283 slice E2). The
   * reducer computes the transform (and any side effects) exactly as before, but
   * only its **non-layout** fields are written to `appStore` here — the four
   * layout fields are dispatched as `post` and the region→appStore mirror writes
   * them back, so the region is their sole writer. Returns the reducer result so
   * callers can read the computed layout / ids. A no-op reducer (`return state`)
   * writes nothing.
   */
  const setLayoutLocal = (reducer: (state: AppState) => Partial<AppState>): Partial<AppState> => {
    const s0 = get();
    const next = reducer(s0);
    if (next !== s0) {
      const rest = nonLayoutPartial(next);
      if (Object.keys(rest).length > 0) set(rest);
    }
    return next;
  };

  /** Reseed the region to `appStore`'s current layout — the retained safety for
   * the non-intent structural writers (openers, handoff, restore, conversion). */
  const reseedLayout = (): void => reseedLayoutRegion(currentLayoutSnapshot(get()));

  /**
   * `set` for a **non-intent** structural writer (#2283 slice E2): it writes the
   * layout locally (there is no granular `layout.*` intent for it — the singleton
   * tab openers, cross-window handoff, restore, the agent-error→terminal
   * conversion) and then reseeds the region so it never lags. Without the reseed
   * the unconditional mirror would recompose an older region view over the
   * just-written tab on the next convergence diff and strand it.
   */
  const setAndReseed = (
    partial: Partial<AppState> | ((state: AppState) => Partial<AppState>)
  ): void => {
    set(partial as Parameters<typeof set>[0]);
    reseedLayout();
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
    ...createHttpMonitorsSlice(set, get, store),
    ...createDialogsSlice(set, get, store),
    ...createRemoteDesktopResolutionsSlice(set, get, store),
    ...createPasswordPromptSlice(set, get, store),
    ...createTerminalSearchSlice(set, get, store),

    // Connection type registry — updated by loadFromBackend()
    connectionTypes: [],

    // Platform default shell — updated by loadFromBackend()
    defaultShell: "bash",

    // Network monitors (httpMonitors + setHttpMonitors) provided by
    // createHttpMonitorsSlice (extracted under #2077 via #2300).

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

    // Password prompt — the promise-based interactive host/SSH password prompt
    // is provided by createPasswordPromptSlice (extracted under #2077 via #2300).

    // Tab Groups
    tabGroups: [initialGroup],
    activeTabGroupId: initialGroupId,

    addTabGroup: (name) => {
      const newGroupId = generateGroupId();
      const newPanel = createLeafPanel();
      const prev = get();
      const pre = currentLayoutSnapshot(prev);
      let assignedName = name ?? "";
      const next = setLayoutLocal((state) => {
        const groupCount = state.tabGroups.length + 1;
        assignedName = name ?? `Group ${groupCount}`;
        const newGroup: TabGroup = {
          id: newGroupId,
          name: assignedName,
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
      // Dispatch the new group to the region via `layout.addGroup`; the mirror
      // composes the result back (#2283 slice E2). The backend assigns its own
      // group id; the overlay carries appStore's until the next reseed.
      mirrorLayoutIntent(
        "layout.addGroup",
        { name: assignedName },
        pre,
        postLayoutSnapshot(prev, next)
      );
      return newGroupId;
    },

    closeTabGroup: (groupId) => {
      if (get().tabGroups.length <= 1) return; // sole group: no-op (backend rejects too)
      const prev = get();
      const pre = currentLayoutSnapshot(prev);
      const next = setLayoutLocal((state) => {
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
      });
      // Dispatch the close to the region; the mirror composes it back (E2).
      mirrorLayoutIntent("layout.closeGroup", { groupId }, pre, postLayoutSnapshot(prev, next));
    },

    renameTabGroup: (groupId, name) => {
      const prev = get();
      const pre = currentLayoutSnapshot(prev);
      const next = setLayoutLocal((state) => ({
        tabGroups: state.tabGroups.map((g) => (g.id === groupId ? { ...g, name } : g)),
      }));
      mirrorLayoutIntent(
        "layout.renameGroup",
        { groupId, name },
        pre,
        postLayoutSnapshot(prev, next)
      );
    },

    setTabGroupColor: (groupId, color) => {
      const prev = get();
      const pre = currentLayoutSnapshot(prev);
      const next = setLayoutLocal((state) => ({
        tabGroups: state.tabGroups.map((g) =>
          g.id === groupId ? { ...g, color: color ?? undefined } : g
        ),
      }));
      // Omit `color` when clearing so the backend's `optional_str` resolves to
      // `None` and drops the accent (matching the local `color ?? undefined`).
      mirrorLayoutIntent(
        "layout.setGroupColor",
        color != null ? { groupId, color } : { groupId },
        pre,
        postLayoutSnapshot(prev, next)
      );
    },

    setActiveTabGroup: (groupId) => {
      if (groupId === get().activeTabGroupId) return; // no-op
      if (!get().tabGroups.some((g) => g.id === groupId)) return; // unknown group
      const prev = get();
      const pre = currentLayoutSnapshot(prev);
      const next = setLayoutLocal((state) => {
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
      });
      // Dispatch the group switch to the region; the mirror composes it back (E2).
      mirrorLayoutIntent("layout.setActiveGroup", { groupId }, pre, postLayoutSnapshot(prev, next));
    },

    reorderTabGroups: (fromIndex, toIndex) => {
      const prev = get();
      const pre = currentLayoutSnapshot(prev);
      const next = setLayoutLocal((state) => {
        const groups = [...state.tabGroups];
        const [moved] = groups.splice(fromIndex, 1);
        groups.splice(toIndex, 0, moved);
        return { tabGroups: groups };
      });
      mirrorLayoutIntent(
        "layout.reorderGroups",
        { fromIndex, toIndex },
        pre,
        postLayoutSnapshot(prev, next)
      );
    },

    moveTabToGroup: (tabId, fromPanelId, targetGroupId) => {
      const prev = get();
      const pre = currentLayoutSnapshot(prev);
      const next = setLayoutLocal((state) => {
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
      // Dispatch the cross-group move to the region; the mirror composes it (E2).
      mirrorLayoutIntent(
        "layout.moveTabToGroup",
        { tabId, fromPanelId, targetGroupId },
        pre,
        postLayoutSnapshot(prev, next)
      );
      // Moving a tab across groups changes broadcast membership when the source
      // or a target crosses the group boundary (#1980) — re-resolve so an
      // "all"/"panel" scope drops/adds it in the source's own group.
      get().refreshBroadcastMembership();
    },

    addTabGroupWithTab: (tabId, fromPanelId) => {
      const prev = get();
      const pre = currentLayoutSnapshot(prev);
      const next = setLayoutLocal((state) => {
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
      });
      // Dispatch the "tab to new group" move to the region; the mirror composes it
      // back (E2). The backend assigns its own group id; the overlay carries
      // appStore's until the next reseed.
      mirrorLayoutIntent(
        "layout.addGroupWithTab",
        { tabId, fromPanelId },
        pre,
        postLayoutSnapshot(prev, next)
      );
    },

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

      // Release this tab's transfer session ids from the source window's
      // transient `transfers` map so its rows follow ownership (#1951). The
      // Transfer Queue itself is region-authoritative and shared (#2229), so it
      // needs no carrying — the destination already sees the same rows.
      const { record, transferSessionIds } = buildTransferAwareHandoff(tab);
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
        // Drop the moved tab's transient `transfers` rows and mark its sessions
        // released so ongoing broadcast `transfer-progress` events do not
        // re-adopt them into this window's transient map (#1951). The shared
        // Transfer Queue region is unaffected — every window already sees it.
        const transferMoved = removeTransferSessionsFromWindow(state, transferSessionIds);
        return {
          rootPanel: newRootPanel,
          tabGroups,
          activePanelId: newActivePanelId,
          ...transferMoved,
        };
      });
      // Non-intent structural writer (#2283 slice E2): reseed the region after the
      // local tree removal so it does not lag.
      reseedLayout();
    },

    hydrateHandoffTab: (record) =>
      setAndReseed((state) => {
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

        // Un-release the moved tab's session so this window resumes folding its
        // live `transfer-progress` events into the transient `transfers` map
        // (#1951 / #1964). The Transfer Queue itself is region-authoritative and
        // shared (#2229), so nothing is seeded into a per-window queue on hydrate.
        const releasedTransferSessions = h.sessionId
          ? state.releasedTransferSessions.filter((id) => id !== h.sessionId)
          : state.releasedTransferSessions;

        return {
          rootPanel: newRootPanel,
          tabGroups,
          activePanelId: targetLeaf.id,
          releasedTransferSessions,
          // Track the hydrated tab's content in the by-id map (part of #2283).
          tabContent: setTabContentEntry(state.tabContent, newTab),
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
      const agentsView = currentAgentsView();
      const agentContext = {
        agents: agentsView.remoteAgents.map((a) => ({
          id: a.id,
          name: a.name,
          connected: a.connectionState === "connected",
        })),
        definitions: agentsView.agentDefinitions,
      };
      const builtGroups = buildTabGroupsFromWorkspace(
        payload.tabGroups,
        currentConnectionsView().connections,
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
      setAndReseed({
        tabGroups: builtGroups,
        activeTabGroupId: firstGroup.id,
        rootPanel: firstGroup.rootPanel,
        activePanelId: firstGroup.activePanelId,
        // Track every restored tab — including `agent-error` — in the by-id
        // content map so it resolves from `tabContent` (#2539).
        tabContent: tabContentFromGroups(builtGroups),
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
        currentConnectionsView().connections
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

      // Build a hand-off record per tab. The Transfer Queue is region-authoritative
      // and shared (#2229), so no queue rows are carried — the destination window
      // already sees them; this window is being torn down, so no source-side
      // transient-map release is needed either.
      const records: TabHandoffRecord[] = tabs.map((tab) => buildTransferAwareHandoff(tab).record);
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
      const conn = currentConnectionsView().connections.find((c) => c.id === connectionId);
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
      const conn = currentConnectionsView().connections.find((c) => c.id === connectionId);
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
    // Flat by-id tab-content map (part of #2283). The initial panel is empty, so
    // it starts empty and is populated as tabs open.
    tabContent: {},

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
        return {
          rootPanel,
          tabGroups,
          // Mirror the cleared replay flag into the content map (part of #2283).
          tabContent: patchTabContentEntry(state.tabContent, tabId, {
            pendingScrollbackReplay: false,
          }),
        };
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
          // Mirror the session id into the content map (part of #2283).
          tabContent: patchTabContentEntry(state.tabContent, tabId, { sessionId }),
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
      const prev = get();
      const pre = currentLayoutSnapshot(prev);
      let createdTabId = "";
      let addedPanelId = "";
      let addedContentType = "terminal";
      let addedSessionId: string | null = null;
      const next = setLayoutLocal((state) => {
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
        addedPanelId = targetPanelId;
        addedContentType = newTab.contentType;
        addedSessionId = newTab.sessionId ?? null;
        const rootPanel = updateLeaf(state.rootPanel, targetPanelId, (leaf) => {
          const tabs = leaf.tabs.map((t) => ({ ...t, isActive: false }));
          tabs.push(newTab);
          return { ...leaf, tabs, activeTabId: newTab.id };
        });
        const hsEnabled =
          terminalOptions?.horizontalScrolling ??
          currentSettingsView().defaultHorizontalScrolling ??
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
          // Duplicate the new tab's content into the by-id map (part of #2283).
          tabContent: setTabContentEntry(state.tabContent, newTab),
          tabHorizontalScrolling: { ...state.tabHorizontalScrolling, [newTab.id]: hsEnabled },
          ...(tabColor ? { tabColors: { ...state.tabColors, [newTab.id]: tabColor } } : {}),
          ...(hasTabOpts
            ? { tabTerminalOptions: { ...state.tabTerminalOptions, [newTab.id]: tabOpts } }
            : {}),
        };
      });
      // Optimistic-fold overlay (#2283 slice D'): mirror the structural insert into
      // the region via `layout.addTab`. The frontend-generated tab id is passed to
      // the backend, so tab identity never diverges (the live xterm DOM, keyed by
      // tab id, is never remounted). The tab's rich content stays in appStore's
      // `tabContent` map / tree; the region carries only `{ id, sessionId,
      // contentType }`.
      if (createdTabId && addedPanelId) {
        mirrorLayoutIntent(
          "layout.addTab",
          {
            panelId: addedPanelId,
            tab: { id: createdTabId, sessionId: addedSessionId, contentType: addedContentType },
          },
          pre,
          postLayoutSnapshot(prev, next)
        );
      }
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
      setAndReseed((state) => {
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
        return {
          ...nav,
          rootPanel,
          activePanelId: targetPanelId,
          // Track the new tab's content in the by-id map (part of #2283).
          tabContent: setTabContentEntry(state.tabContent, newTab),
        };
      }),

    openLogViewerTab: () =>
      setAndReseed((state) => {
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
        return {
          rootPanel,
          activePanelId: targetPanelId,
          // Track the new tab's content in the by-id map (part of #2283).
          tabContent: setTabContentEntry(state.tabContent, newTab),
        };
      }),

    openNetworkDiagnosticTab: (tool, prefillHost, connectionId) =>
      setAndReseed((state) => {
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
        return {
          rootPanel,
          activePanelId: targetPanelId,
          // Track the new tab's content (incl. its diagnostic meta) in the by-id
          // map (part of #2283).
          tabContent: setTabContentEntry(state.tabContent, newTab),
        };
      }),

    openEditorTab: (filePath, isRemote, permissions, sessionBrowser) =>
      setAndReseed((state) => {
        const allLeaves = getAllLeaves(state.rootPanel);

        // Stable identity of the backing session, so the same path opened from
        // two different remote sessions gets two tabs while a reconnect of the
        // same connection refreshes one (#1599).
        const sessionKey = resolveEditorSessionKey(state, isRemote, sessionBrowser);

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
            // Refresh the backing session so a reconnected session works.
            let refreshedMeta = existing.editorMeta;
            if (isRemote && existing.editorMeta && sessionBrowser) {
              refreshedMeta = {
                ...existing.editorMeta,
                sessionBrowser,
                sessionKey,
              };
            }
            const rootPanel = updateLeaf(state.rootPanel, leaf.id, (l) => ({
              ...l,
              tabs: l.tabs.map((t) =>
                t.id === existing.id
                  ? { ...t, isActive: true, editorMeta: refreshedMeta }
                  : { ...t, isActive: false }
              ),
              activeTabId: existing.id,
            }));
            return {
              rootPanel,
              activePanelId: leaf.id,
              // Keep the mapped content in sync with the refreshed meta (#2283).
              tabContent: patchTabContentEntry(state.tabContent, existing.id, {
                editorMeta: refreshedMeta,
              }),
            };
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
        return {
          rootPanel,
          activePanelId: targetPanelId,
          // Track the new tab's content (incl. editorMeta) in the by-id map (#2283).
          tabContent: setTabContentEntry(state.tabContent, newTab),
        };
      }),

    openScratchEditorTab: (title, fileName, content) =>
      setAndReseed((state) => {
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
        return {
          rootPanel,
          activePanelId: targetPanelId,
          // Track the scratch editor's content (incl. editorMeta) in the map (#2283).
          tabContent: setTabContentEntry(state.tabContent, newTab),
        };
      }),

    openConnectionEditorTab: (connectionId, folderId) =>
      setAndReseed((state) => {
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
          const conn = currentConnectionsView().connections.find((c) => c.id === connectionId);
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
        return {
          rootPanel,
          activePanelId: targetPanelId,
          // Track the new tab's content (incl. connectionEditorMeta) in the map (#2283).
          tabContent: setTabContentEntry(state.tabContent, newTab),
        };
      }),

    openAgentDefinitionEditorTab: (agentId, definitionId, folderId) =>
      setAndReseed((state) => {
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
          const defs = currentAgentsView().agentDefinitions[agentId] ?? [];
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
        return {
          rootPanel,
          activePanelId: targetPanelId,
          // Track the new tab's content (incl. connectionEditorMeta) in the map (#2283).
          tabContent: setTabContentEntry(state.tabContent, newTab),
        };
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
      // Snapshot the pre-close layout for the region seed (#2283 slice D').
      const prevLayout = get();
      const preLayout = currentLayoutSnapshot(prevLayout);

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

      const closeNext = setLayoutLocal((state) => {
        // Clean up per-tab state for the closed tab
        const remainingCwds = omitKey(state.tabCwds, tabId);
        const remainingHs = omitKey(state.tabHorizontalScrolling, tabId);
        const remainingDirty = omitKey(state.editorDirtyTabs, tabId);
        const remainingColors = omitKey(state.tabColors, tabId);
        // Prune the closed tab's content from the by-id map (part of #2283).
        const remainingTabContent = omitKey(state.tabContent, tabId);
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
            tabContent: remainingTabContent,
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
          tabContent: remainingTabContent,
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
        };
      });

      // Cancel any pending resilient-reconnect backoff timer for the closed tab
      // (#1962) — the store entry was already dropped above; this frees the
      // imperative timer so it cannot fire against a gone tab.
      clearAutoReconnectTimer(tabId);

      // Broadcast (#1955): closing the source tab ends broadcast entirely;
      // closing a plain target silently drops it from the set. Membership is
      // sourced from the authoritative region (#2206).
      const bcView = currentBroadcastView();
      if (bcView.active) {
        if (bcView.sourceTabId === tabId) {
          get().stopBroadcast();
        } else if (bcView.targetTabIds.includes(tabId)) {
          get().removeBroadcastTarget(tabId);
        }
      }

      // Optimistic-fold overlay (#2283 slice D'): mirror the structural close into
      // the region via `layout.closeTabStructure` (the structural half only —
      // session teardown stayed above). appStore is authoritative; the overlay
      // installs the post-close tree.
      mirrorLayoutIntent(
        "layout.closeTabStructure",
        { tabId },
        preLayout,
        postLayoutSnapshot(prevLayout, closeNext)
      );
    },

    setActiveTab: (tabId, panelId) => {
      // Region-authoritative op (#2283 slice E2): the reducer computes the focus
      // change (and any zoom-follow); its non-layout `zoomedTabId` is written
      // locally, the region mirror composes the layout fields back. Focuses
      // `tabId` within its leaf and repoints the active panel, following the zoom
      // overlay when it shows a tab of that leaf.
      const prev = get();
      const pre = currentLayoutSnapshot(prev);
      const next = setLayoutLocal((state) => {
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
      });

      // Dispatch the tab focus to the region via `layout.setActiveTab`; the mirror
      // composes it back (E2). The backend derives the leaf from the tab id.
      mirrorLayoutIntent("layout.setActiveTab", { tabId }, pre, postLayoutSnapshot(prev, next));
    },

    moveTab: (tabId, fromPanelId, toPanelId, newIndex) => {
      // A non-intent structural writer (no `layout.moveTab*` dispatch of its own):
      // keep the local write and reseed the region after so it does not lag (E2).
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
      });
      reseedLayout();
    },

    reorderTabs: (panelId, oldIndex, newIndex) => {
      // Region-authoritative op (#2283 slice E2): reorder a tab within its leaf,
      // leaving focus untouched; the region mirror composes the result back.
      const prev = get();
      const pre = currentLayoutSnapshot(prev);
      const next = setLayoutLocal((state) => ({
        rootPanel: updateLeaf(state.rootPanel, panelId, (leaf) => {
          const tabs = [...leaf.tabs];
          const [moved] = tabs.splice(oldIndex, 1);
          tabs.splice(newIndex, 0, moved);
          return { ...leaf, tabs };
        }),
      }));
      mirrorLayoutIntent(
        "layout.reorderTabs",
        { panelId, oldIndex, newIndex },
        pre,
        postLayoutSnapshot(prev, next)
      );
    },

    splitPanel: (direction) => {
      // Region-authoritative op (#2283 slice E2): orchestrates the shared
      // `@/utils/panelTree` helpers (the same seam the Rust store ports), so it
      // never drifts from the region's `layout.split`; the mirror composes it back.
      const prev = get();
      const pre = currentLayoutSnapshot(prev);
      const { activePanelId } = prev;
      const next = setLayoutLocal((state) => {
        const dir = direction ?? "horizontal";
        const targetId = state.activePanelId;
        if (!targetId) return state;

        const newLeaf = createLeafPanel();
        let rootPanel = splitLeaf(state.rootPanel, targetId, newLeaf, dir, "after");
        rootPanel = simplifyTree(rootPanel);
        return { rootPanel, activePanelId: newLeaf.id };
      });

      // The split targets the pre-split active panel; the backend focuses its new
      // leaf, matching the reducer.
      if (activePanelId) {
        mirrorLayoutIntent(
          "layout.split",
          { panelId: activePanelId, direction: direction ?? "horizontal", position: "after" },
          pre,
          postLayoutSnapshot(prev, next)
        );
      }
    },

    removePanel: (panelId) => {
      // Local reducer — the retained rollback/resilience fallback. Drops a whole
      // leaf panel and simplifies; repoints focus onto the first survivor when
      // the removed panel held it.
      // The sole-leaf case is a no-op both here and in the store, so skip it.
      if (getAllLeaves(get().rootPanel).length <= 1) return;
      const prev = get();
      const pre = currentLayoutSnapshot(prev);
      const next = setLayoutLocal((state) => {
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

      // Region-authoritative op (#2283 slice E2): the mirror composes it back.
      mirrorLayoutIntent("layout.removePanel", { panelId }, pre, postLayoutSnapshot(prev, next));
    },

    setActivePanel: (panelId) => {
      // Region-authoritative op (#2283 slice E2) on a hot path (every panel click
      // and keyboard-nav step): the region mirror composes the focus change back,
      // synchronously via the optimistic overlay. Zoom-follow (a non-layout field
      // set locally): when the zoom overlay shows a tab from the newly-focused
      // panel, follow the switch to that panel's active tab.
      const prev = get();
      const pre = currentLayoutSnapshot(prev);
      const next = setLayoutLocal((state) => {
        let newZoomedTabId = state.zoomedTabId;
        if (state.zoomedTabId !== null) {
          const newPanel = findLeaf(state.rootPanel, panelId);
          newZoomedTabId = newPanel?.activeTabId ?? null;
        }
        return { activePanelId: panelId, zoomedTabId: newZoomedTabId };
      });
      mirrorLayoutIntent("layout.setActivePanel", { panelId }, pre, postLayoutSnapshot(prev, next));
    },

    setPanelSizes: (splitId, sizes) => {
      // Region-authoritative op (#2283 slice E2): persists a split's child
      // percentage sizes so a resize-handle drag survives remounts and workspace
      // save/restore; the mirror composes it back.
      const prev = get();
      const pre = currentLayoutSnapshot(prev);
      const next = setLayoutLocal((state) => ({
        rootPanel: setSplitSizesInTree(state.rootPanel, splitId, sizes),
      }));
      mirrorLayoutIntent("layout.resize", { splitId, sizes }, pre, postLayoutSnapshot(prev, next));
    },

    splitPanelWithTab: (tabId, fromPanelId, targetPanelId, edge) => {
      // Region-authoritative op (#2283 slice E2) over the shared panelTree algebra;
      // the mirror composes the result back.
      const prev = get();
      const pre = currentLayoutSnapshot(prev);
      const next = setLayoutLocal((state) => {
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

      // Dispatch the move to the region via `layout.moveTab` (center = merge into
      // the target stack, edge = split the target); the mirror composes it back.
      mirrorLayoutIntent(
        "layout.moveTab",
        moveTabPayload(tabId, targetPanelId, edge),
        pre,
        postLayoutSnapshot(prev, next)
      );
    },

    // Connections — the saved-connection / folder tree is region-authoritative
    // (#2401); no `appStore` slice. See the `connections` projection region.
    // Settings — the persisted document is region-authoritative (#2404); no
    // `appStore` slice. See the `settings` projection region (read via
    // `useProjectedSettings()` / `currentSettingsView()`).

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

    // Terminal search (runtime-only) — per-tab search-bar visibility + set/toggle
    // provided by createTerminalSearchSlice (extracted under #2077 via #2300).

    // Per-session syntax-highlighting toggle (runtime-only, never persisted)
    sessionHighlighting: {},
    setSessionHighlighting: (sessionId, enabled) =>
      set((s) =>
        enabled === undefined
          ? { sessionHighlighting: omitKey(s.sessionHighlighting, sessionId) }
          : { sessionHighlighting: { ...s.sessionHighlighting, [sessionId]: enabled } }
      ),

    // Dialogs — large-paste / open-saved-file / export-import / recovery-warning
    // open/close flags provided by createDialogsSlice (extracted under #2077 via
    // #2300).

    updateLayoutConfig: (partial) => {
      const updated = { ...get().layoutConfig, ...partial };
      set({ layoutConfig: updated });
      if (layoutPersistTimer) clearTimeout(layoutPersistTimer);
      layoutPersistTimer = setTimeout(() => {
        persistSettings({ ...currentSettingsView(), layout: updated }).catch((err) =>
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
        persistSettings({ ...currentSettingsView(), layout: config }).catch((err) =>
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
        persistSettings({ ...currentSettingsView(), layout: updated }).catch((err) =>
          frontendLog(
            "app_store",
            `Failed to persist layout config: ${err instanceof Error ? err.message : String(err)}`
          )
        );
      }, 300);
    },

    loadFromBackend: async () => {
      try {
        // The saved-connection / folder tree AND the agent list are
        // region-authoritative (#2401 / #2409): the backend seeds and folds the
        // `connections` and `agents` regions server-side (this
        // `load_connections_and_folders` call also re-folds both, #2389 / #2403),
        // so we only read `externalErrors` here and never seed a slice.
        const { externalErrors } = await loadConnections();
        // Prime the region subscription so `currentConnectionsView()` is populated
        // for the store's own connect / session / restore reads (which run before
        // the sidebar's `useProjectedConnections` may have mounted). Best-effort:
        // the eager transport build throws synchronously in a non-Tauri env, so
        // guard both the throw and the rejection.
        try {
          await ensureConnectionsSubscribed();
        } catch (subErr) {
          frontendLog(
            "app_store",
            `connections region subscribe failed: ${subErr instanceof Error ? subErr.message : String(subErr)}`
          );
        }
        // The persisted settings document is region-authoritative (#2404): the
        // backend seeds the `settings` region from the persisted document at
        // startup (#2386), so prime the region subscription here so
        // `currentSettingsView()` is populated for the store's own imperative reads
        // (connect / restore / line-ending). Best-effort — the eager transport
        // build throws synchronously in a non-Tauri env, so guard throw + rejection.
        try {
          await ensureSettingsSubscribed();
        } catch (subErr) {
          frontendLog(
            "app_store",
            `settings region subscribe failed: ${subErr instanceof Error ? subErr.message : String(subErr)}`
          );
        }
        // The agent list is region-authoritative (#2409): the backend seeds the
        // `agents` region from the persisted list at startup and re-folds it on the
        // `load_connections_and_folders` above (#2403), so prime the region
        // subscription here so `currentAgentsView()` is populated for the store's own
        // imperative reads (workspace hydration / restore / reconnect). Best-effort —
        // the eager transport build throws synchronously in a non-Tauri env, so guard
        // throw + rejection.
        try {
          await ensureAgentsSubscribed();
        } catch (subErr) {
          frontendLog(
            "app_store",
            `agents region subscribe failed: ${subErr instanceof Error ? subErr.message : String(subErr)}`
          );
        }
        // Still read the persisted document directly: it drives one-time startup
        // side-effects that do not live in the region view (theme apply, layout /
        // sidebar hydration, keybinding overrides, language packages / grammars).
        const settings = await getSettings();
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
        // The settings document is region-authoritative (#2404): read the
        // previous document from the projection to drive the side-effect diffs.
        const oldSettings = currentSettingsView();
        await persistSettings(newSettings);
        // Optimistic whole-document write into the authoritative region. The
        // persist above folds `save_settings` into the region server-side (#2386);
        // this dispatch reflects it client-side instantly, and `useProjectedSettings`
        // renders it back. There is no `appStore` slice to set any more.
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
      // Capture the previously-projected value for rollback. The shell-integration
      // write is a targeted field patch, so dispatch it as a `settings.patch`
      // (shallow-merge) rather than a whole-document replace — keeping a concurrent
      // general-settings edit intact. The backend `settings.patch` route reads the
      // partial from a `{ patch }` envelope (settings_projection/projection.rs), so
      // wrap the field there. This is the optimistic write into the authoritative
      // region (#2404); the persist below also folds server-side (#2407).
      const prevSi = currentSettingsView().shellIntegration;
      mirrorSettingsIntent("settings.patch", { patch: { shellIntegration: nextSi } });
      try {
        return await saveShellIntegrationSettings(nextSi);
      } catch (err) {
        // Roll the region back to the previously-projected shell-integration value.
        mirrorSettingsIntent("settings.patch", { patch: { shellIntegration: prevSi } });
        throw err;
      }
    },

    reloadExternalConnections: async () => {
      try {
        // Re-reads the configured external files and folds the refreshed unified
        // view into the authoritative `connections` region server-side (#2394), so
        // every reader updates via the region diff — no frontend slice to splice.
        await apiReloadExternalConnections();
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
      const existing = currentConnectionsView().folders.find((f) => f.id === folderId);
      if (!existing) return;
      const toggled = { ...existing, isExpanded: !existing.isExpanded };
      // Optimistic flip in the region, then persist (the persist command folds the
      // authoritative view back, #2389).
      mirrorConnectionIntent("connection.toggleFolder", { folderId });
      persistFolder(toggled).catch((err) => {
        frontendLog(
          "app_store",
          `Failed to persist folder toggle: ${err instanceof Error ? err.message : String(err)}`
        );
        toast.error(
          `Failed to save folder state: ${err instanceof Error ? err.message : String(err)}`
        );
      });
    },

    reloadConnectionsFromBackend: () => {
      frontendLog("connection_sync", "focus reload: triggered by external event");
      // Re-reads the unified connection view and re-folds it into the authoritative
      // `connections` region server-side (#2401), so the UI refreshes via the region
      // diff. No frontend slice to set.
      void loadConnections().catch((err) => {
        frontendLog(
          "app_store",
          `focus reload failed: ${err instanceof Error ? err.message : String(err)}`
        );
      });
    },

    // Session history (#1883) — data + load/record/pin/promote/remove/clear
    // provided by createSessionHistorySlice (extracted under #2077).

    addConnection: (connection) => {
      // Optimistic add in the region, then persist. The persist command recomputes
      // the name-derived id and folds the authoritative view back server-side
      // (#2389), so the optimistic `conn-<ts>` row is reconciled to the persisted id
      // without a frontend id-reconcile / reload pass.
      mirrorConnectionIntent("connection.add", { connection });
      frontendLog("connection_sync", `addConnection: persisting ${connection.id}`);
      persistConnection(stripPassword(connection))
        .then(() => {
          toast.success(`Saved ${connection.name}`);
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
      for (const connection of newConnections) {
        mirrorConnectionIntent("connection.add", { connection });
      }
      frontendLog(
        "connection_sync",
        `bulkAddConnections: persisting ${newConnections.length} connections`
      );
      Promise.all(newConnections.map((c) => persistConnection(stripPassword(c))))
        .then(() => {
          toast.success(
            `Imported ${newConnections.length} ${newConnections.length === 1 ? "connection" : "connections"}`
          );
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
      // Optimistic edit in the region, then persist. A rename changes the
      // name-derived persisted id; the persist command's server-side fold (#2389)
      // reconciles it back into the region under the new id, so a connect fired
      // after the save resolves reads the correct id (#875) without a frontend pass.
      mirrorConnectionIntent("connection.update", { connection });
      frontendLog("connection_sync", `updateConnection: persisting ${connection.id}`);
      persistConnection(stripPassword(connection))
        .then(() => {
          toast.success(`Saved ${connection.name}`);
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
      const conn = currentConnectionsView().connections.find((c) => c.id === connectionId);
      frontendLog("connection_sync", `deleteConnection: removing ${connectionId} optimistically`);
      mirrorConnectionIntent("connection.remove", { connectionId });
      removeConnection(connectionId, conn?.sourceFile)
        .then(() => {
          frontendLog("connection_sync", `deleteConnection: backend confirmed`);
          toast.success(`Deleted ${conn?.name ?? "connection"}`);
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
      const toDelete = currentConnectionsView().connections.filter((c) => idSet.has(c.id));
      frontendLog(
        "connection_sync",
        `bulkDeleteConnections: removing ${connectionIds.join(", ")} optimistically`
      );
      for (const c of toDelete) {
        mirrorConnectionIntent("connection.remove", { connectionId: c.id });
      }
      Promise.all(toDelete.map((c) => removeConnection(c.id, c.sourceFile)))
        .then(() => {
          frontendLog("connection_sync", `bulkDeleteConnections: backend confirmed`);
          toast.success(
            `Deleted ${toDelete.length} ${toDelete.length === 1 ? "connection" : "connections"}`
          );
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
      mirrorConnectionIntent("connection.addFolder", { folder });
      frontendLog("connection_sync", `addFolder: persisting ${folder.id}`);
      persistFolder(folder).catch((err) => {
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
      // The `connection.removeFolder` intent re-homes the folder's child
      // connections to root and reparents its child folders in the region
      // (optimistic), and the `removeFolder` command folds the authoritative
      // result back server-side (#2389) — so no frontend reparenting is needed.
      mirrorConnectionIntent("connection.removeFolder", { folderId });
      frontendLog("connection_sync", `deleteFolder: removing ${folderId}`);
      removeFolder(folderId).catch((err) => {
        frontendLog(
          "app_store",
          `Failed to persist folder deletion: ${err instanceof Error ? err.message : String(err)}`
        );
        toast.error(`Failed to delete folder: ${err instanceof Error ? err.message : String(err)}`);
      });
    },

    duplicateConnection: (connectionId) => {
      const original = currentConnectionsView().connections.find((c) => c.id === connectionId);
      if (!original) return;
      const duplicate: SavedConnection = {
        ...original,
        id: `conn-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        name: `Copy of ${original.name}`,
      };
      mirrorConnectionIntent("connection.add", { connection: duplicate });
      frontendLog("connection_sync", `duplicateConnection: persisting copy of ${connectionId}`);
      persistConnection(stripPassword(duplicate)).catch((err) => {
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
      const conn = currentConnectionsView().connections.find((c) => c.id === connectionId);
      if (!conn) return;
      const currentSource = conn.sourceFile ?? null;
      if (currentSource === targetSource) return;
      try {
        // The move command relocates the entry between config files and folds the
        // refreshed unified view into the region server-side (#2394); mirror the
        // update so the region reflects it immediately even before that diff lands.
        const updated = await apiMoveConnectionToFile(connectionId, currentSource, targetSource);
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
      const existing = currentConnectionsView().connections.find((c) => c.id === connectionId);
      if (!existing) return;
      // Optimistic move in the region for instant visual feedback.
      mirrorConnectionIntent("connection.move", { connectionId, folderId });

      // Persist to backend; the persist command folds any dedup rename (e.g. moving
      // a connection into a folder with a same-named sibling) back into the region
      // server-side (#2389).
      const moved = { ...existing, folderId };
      frontendLog("connection_sync", `moveConnectionToFolder: persisting ${connectionId}`);
      persistConnection(stripPassword(moved)).catch((err) => {
        frontendLog(
          "app_store",
          `Failed to persist connection move: ${err instanceof Error ? err.message : String(err)}`
        );
        toast.error(
          `Failed to move ${moved.name}: ${err instanceof Error ? err.message : String(err)}`
        );
      });
    },

    bulkMoveConnectionsToFolder: (connectionIds, folderId) => {
      const idSet = new Set(connectionIds);

      // Optimistic move in the region for instant visual feedback.
      for (const connectionId of connectionIds) {
        mirrorConnectionIntent("connection.move", { connectionId, folderId });
      }

      // Persist all connections in parallel; each persist folds the authoritative
      // view back into the region server-side (#2389).
      const moved = currentConnectionsView()
        .connections.filter((c) => idSet.has(c.id))
        .map((c) => ({ ...c, folderId }));
      frontendLog(
        "connection_sync",
        `bulkMoveConnectionsToFolder: persisting ${moved.length} connections`
      );
      Promise.all(moved.map((conn) => persistConnection(stripPassword(conn)))).catch((err) => {
        frontendLog(
          "app_store",
          `Failed to persist bulk connection move: ${err instanceof Error ? err.message : String(err)}`
        );
        toast.error(
          `Failed to move connections: ${err instanceof Error ? err.message : String(err)}`
        );
      });
    },

    // File browser — SFTP transfers
    transfers: {},

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

    // --- Transfer Queue panel mutations (#1337, region-authoritative #2229) ---
    //
    // The Transfer Queue panel state lives in the shared, authoritative
    // `transfers` projection region — the backend folds the live progress stream
    // into it at the source (#2387). These panel-only actions have no live-engine
    // data source, so they are reliable client `transfer.*` intents against that
    // region (dispatch is best-effort: a bridge hiccup is swallowed and logged,
    // never thrown out of a UI action). `appStore` holds no queue state.

    removeTransfer: (id: string) => {
      dispatchTransferIntentBestEffort("transfer.remove", { id });
    },

    clearCompleted: () => {
      dispatchTransferIntentBestEffort("transfer.clearCompleted", {});
    },

    setTransferQueueMinimized: (minimized: boolean) => {
      dispatchTransferIntentBestEffort("transfer.setMinimized", { minimized });
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
          // Mirror the new title into the content map (part of #2283).
          tabContent: patchTabContentEntry(state.tabContent, tabId, { title: newTitle }),
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
    terminalForceFreshReconnect: {},
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
      if (deadKey && currentMonitorsView().monitors[deadKey]) {
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
      if (deadKey && currentMonitorsView().monitors[deadKey]) {
        get().disconnectMonitoring(deadKey);
      }
    },
    settleBackendReconnectGaveUp: (tabId, error) => {
      // The backend already folded the give-up (region → Failed/gaveup); reflect
      // it locally without re-mirroring an intent. Clear the auto-reconnect loop
      // record and every in-flight connect flag (connecting / deadline / waiting /
      // spawn-error) so no competing overlay lingers, then show the disconnect
      // overlay with the give-up error (offering View Scrollback / Reconnect).
      set((state) => ({
        terminalAutoReconnect: omitKey(state.terminalAutoReconnect, tabId),
        terminalConnecting: omitKey(state.terminalConnecting, tabId),
        terminalConnectDeadline: omitKey(state.terminalConnectDeadline, tabId),
        terminalWaitingForAgent: omitKey(state.terminalWaitingForAgent, tabId),
        terminalAutoRetryCount: omitKey(state.terminalAutoRetryCount, tabId),
        terminalSpawnErrors: omitKey(state.terminalSpawnErrors, tabId),
        terminalReconnectingTabs: omitKey(state.terminalReconnectingTabs, tabId),
        terminalExitedTabs: { ...state.terminalExitedTabs, [tabId]: true },
        terminalDisconnectErrors: { ...state.terminalDisconnectErrors, [tabId]: error },
      }));
      get().settleRestoreTab(tabId, "failed");
      const deadKey = monitorKeyForTab(collectLiveTabs(get()).find((t) => t.id === tabId));
      if (deadKey && currentMonitorsView().monitors[deadKey]) {
        get().disconnectMonitoring(deadKey);
      }
    },

    settleSessionLost: (tabId) => {
      // The backend folded `session.sessionLost` into the region (the live agent
      // session was unrecoverable). Reflect it locally without re-mirroring an
      // intent: clear the loop record + every in-flight connect flag so no
      // competing overlay lingers, and mark the tab exited so the disconnect
      // overlay mounts. Deliberately no `terminalDisconnectErrors` write — the
      // session-lost variant sources its message from the projected region, and a
      // disconnect error would otherwise drive the generic "Reconnect failed"
      // variant.
      set((state) => ({
        terminalAutoReconnect: omitKey(state.terminalAutoReconnect, tabId),
        terminalConnecting: omitKey(state.terminalConnecting, tabId),
        terminalConnectDeadline: omitKey(state.terminalConnectDeadline, tabId),
        terminalWaitingForAgent: omitKey(state.terminalWaitingForAgent, tabId),
        terminalAutoRetryCount: omitKey(state.terminalAutoRetryCount, tabId),
        terminalSpawnErrors: omitKey(state.terminalSpawnErrors, tabId),
        terminalReconnectingTabs: omitKey(state.terminalReconnectingTabs, tabId),
        terminalReconnectTriggerErrors: omitKey(state.terminalReconnectTriggerErrors, tabId),
        terminalExitedTabs: { ...state.terminalExitedTabs, [tabId]: true },
      }));
      get().settleRestoreTab(tabId, "failed");
      const deadKey = monitorKeyForTab(collectLiveTabs(get()).find((t) => t.id === tabId));
      if (deadKey && currentMonitorsView().monitors[deadKey]) {
        get().disconnectMonitoring(deadKey);
      }
    },

    startFreshShellForTab: (tabId) => {
      // Arm the one-shot force-fresh flag first so the reconnect effect (re-run by
      // reconnectTerminal bumping the retry counter) reads it and skips the
      // re-attach branch, creating a brand-new session instead.
      set((state) => ({
        terminalForceFreshReconnect: { ...state.terminalForceFreshReconnect, [tabId]: true },
      }));
      get().reconnectTerminal(tabId);
    },

    // Aggregate partial-restore feedback (#1146, audit G4) + bulk retry (#1227,
    // M2). Region-authoritative (#2206): the `restore-cohort@<clientId>` store
    // owns the cohort, the captured failed-tab set and the settlement summary; the
    // actions below are thin dispatchers, and the summary toast fires from the
    // projected settlement via the renderer registered at store init (see below).
    beginRestoreCohort: (pendingTabIds, preFailedCount, toastId) => {
      // The region folds begin/settle and settles a no-live cohort itself. A
      // total-0 cohort is a backend no-op, matching the pre-cut early return.
      mirrorRestoreBegin({ pendingTabIds, preFailedCount, toastId });
    },
    settleRestoreTab: (tabId, outcome) => {
      // Dispatch unconditionally: the region is the sole guard and ignores a settle
      // for a tab that is not pending in the current cohort (a stray/duplicate, or
      // a disconnect outside any restore), so nothing settles and no toast fires.
      mirrorRestoreSettle({ tabId, outcome });
    },
    reconnectFailedRestoreTabs: () => {
      // The region keeps the raw captured failed-tab set; consume it here and, as
      // before, only re-drive tabs that still exist as live terminal tabs (the
      // live-terminal filter is a frontend concern). The fresh cohort begun below
      // clears the region's failed set.
      const captured = currentRestoreCohortView().failedTabIds;
      if (captured.length === 0) return;
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
    setTerminalReconnecting: (tabId, reconnecting) => {
      // Session-intents cut (#2442): reconnecting ending clears the region's
      // reconnect-trigger cause too, keeping the projected `reconnectError`
      // field in lockstep with the local slice (the two clear together).
      if (!reconnecting && sessionIntentsEnabled()) {
        mirrorSessionIntent("session.reconnectTrigger", tabId);
      }
      set((state) =>
        reconnecting
          ? { terminalReconnectingTabs: { ...state.terminalReconnectingTabs, [tabId]: true } }
          : {
              terminalReconnectingTabs: omitKey(state.terminalReconnectingTabs, tabId),
              terminalReconnectTriggerErrors: omitKey(state.terminalReconnectTriggerErrors, tabId),
            }
      );
    },
    setTerminalReattaching: (tabId, reattaching) =>
      set((state) => ({
        terminalReattaching: reattaching
          ? { ...state.terminalReattaching, [tabId]: true }
          : omitKey(state.terminalReattaching, tabId),
      })),
    setTerminalReconnectTriggerError: (tabId, error) => {
      // Session-intents cut (#2442): the reconnect-trigger cause is region-owned.
      // Mirror it to the shared `session-lifecycle` region so the disconnect
      // overlay can read it from the projection (a null error clears the field).
      if (sessionIntentsEnabled()) {
        mirrorSessionIntent("session.reconnectTrigger", tabId, error ?? undefined);
      }
      set((state) => ({
        terminalReconnectTriggerErrors:
          error === null
            ? omitKey(state.terminalReconnectTriggerErrors, tabId)
            : { ...state.terminalReconnectTriggerErrors, [tabId]: error },
      }));
    },
    dismissTerminalDisconnect: (tabId) =>
      set((state) => ({
        // Keep terminalExitedTabs[tabId] = true so the banner can detect the dead session;
        // only flip the overlay off by entering view mode.
        terminalViewMode: { ...state.terminalViewMode, [tabId]: true },
      })),
    reconnectTerminal: (tabId) =>
      set((state) => {
        // Backend-driven agent reconnect (#2476): the backend park/retry loop is
        // the sole driver and legitimately outlasts the fixed 90 s "connecting"
        // deadline on a prolonged agent drop. Arming it here would let the client
        // wall-clock timeout force-fail a tab the backend is still recovering, so
        // this reconnect leaves the deadline cleared — the backend give-up fold,
        // not a client timer, is what settles the tab (the give-up-aware wait in
        // Terminal.tsx resolves it). Every other tab keeps the safety-net deadline.
        // Flag off ⇒ this is always false ⇒ byte-identical to develop.
        const deferToBackendLoop = isBackendDrivenAgentReconnectTabId(tabId);
        return {
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
          // was cleared on disconnect) so the wall-clock timeout starts now —
          // except for a backend-driven agent reconnect, which owns its own timing.
          terminalConnectDeadline: deferToBackendLoop
            ? omitKey(state.terminalConnectDeadline, tabId)
            : {
                ...state.terminalConnectDeadline,
                [tabId]: {
                  kind: "connecting" as const,
                  at: Date.now() + connectTimeoutMs("connecting"),
                },
              },
          terminalRetryCounters: {
            ...state.terminalRetryCounters,
            [tabId]: (state.terminalRetryCounters[tabId] ?? 0) + 1,
          },
        };
      }),
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

    // Remote agents — the ordered agent list plus each agent's sessions /
    // definitions / folders are region-authoritative (#2409); no `appStore` slice.
    // See the `agents` projection region (read via `useProjectedAgents()` /
    // `currentAgentsView()`). The per-client update sub-slices below stay here.
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

      const agentName =
        currentAgentsView().remoteAgents.find((a) => a.id === agentId)?.name ?? "Agent";
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
      // Optimistic append in the authoritative region (#2409), then persist. The
      // backend folds the persisted agent list back at the source (#2403).
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
      // Optimistic edit in the region (#2409), then persist.
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
      // Compute the new id order from the authoritative region view, optimistically
      // reorder it in the region (#2409), then persist the new order.
      const agents = [...currentAgentsView().remoteAgents];
      const [moved] = agents.splice(oldIndex, 1);
      agents.splice(newIndex, 0, moved);
      const agentIds = agents.map((a) => a.id);
      mirrorAgentIntent("agent.reorder", { oldIndex, newIndex });
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
      // Disconnect first if connected
      const agent = currentAgentsView().remoteAgents.find((a) => a.id === agentId);
      if (agent && agent.connectionState !== "disconnected") {
        apiDisconnectAgent(agentId).catch(() => {});
      }
      // Optimistic remove in the region — drops the agent and all of its sub-state
      // (the store's `remove` clears sessions/definitions/folders too, #2409);
      // the persisted-list fold reconciles server-side (#2403).
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
      // Optimistically flip the sidebar expansion in the authoritative region (#2409).
      mirrorAgentIntent("agent.toggleExpanded", { id: agentId });
    },

    connectRemoteAgent: async (agentId, password) => {
      const agent = currentAgentsView().remoteAgents.find((a) => a.id === agentId);
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

        // Consume capabilities only (no connectionState write): record the
        // capabilities and the force-expand optimistically in the authoritative
        // region (#2409). `connectionState` stays a single-writer field driven by
        // the `agent-state-change` event (`setAgentConnectionState` →
        // `agent.status`), so it is deliberately not written here.
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
      // Optimistically force the region entry to disconnected and clear its live
      // sessions/folders (the store's `disconnect` does exactly this, #2409).
      mirrorAgentIntent("agent.disconnect", { id: agentId });
    },

    shutdownRemoteAgent: async (agentId) => {
      // Unlike disconnect (detach), shutdown stops the remote sessions and then
      // drops the transport. The backend returns how many sessions were
      // detached/killed so the UI can report the impact.
      const detached = await apiShutdownAgent(agentId);
      // As with disconnect, optimistically force the region entry to disconnected
      // and clear its live sessions/folders (#2409).
      mirrorAgentIntent("agent.disconnect", { id: agentId });
      return detached;
    },

    setAgentConnectionState: (agentId, connectionState, error) => {
      // Single writer for `connectionState` (G4/#1234): only the backend
      // `agent-state-change` event reaches this setter. Read the previous state
      // from the authoritative region to guard the once-per-connect refresh below.
      const previous = currentAgentsView().remoteAgents.find(
        (a) => a.id === agentId
      )?.connectionState;

      // Optimistically set the connection state in the region (#2409). This is the
      // single writer for `connectionState` (G4/#1234); the store's `set_status`
      // tracks `lastError` across auto-reconnect exhaustion (G3/#1236) with the same
      // rules the frontend used — record it on `disconnected` (falling back to the
      // stored one), clear it on `connecting`/`connected`, leave it otherwise.
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
      // Optimistically empty the region's live-session list for the agent (#2409).
      mirrorAgentIntent("agent.clearSessions", { id: agentId });
    },

    setAgentCapabilities: (agentId, capabilities) => {
      // Optimistically record the negotiated capabilities in the region (#2409).
      mirrorAgentIntent("agent.setCapabilities", { id: agentId, capabilities });
    },

    updateAgentSettings: async (agentId, settings) => {
      await apiApplyAgentSettings(agentId, settings);
      // Optimistically apply just the settings in the region (#2409).
      mirrorAgentIntent("agent.applySettings", { id: agentId, agentSettings: settings });
    },

    refreshAgentSessions: async (agentId) => {
      try {
        const [sessions, connectionsData] = await Promise.all([
          listAgentSessions(agentId),
          listAgentConnections(agentId),
        ]);
        // Optimistically replace the agent's live sessions plus its saved
        // definitions and folders in the region in one shot (the once-per-connect
        // refresh set, #2409).
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
        // Optimistically upsert the saved definition in the region (#2409).
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
      const original = currentAgentsView().agentDefinitions[agentId]?.find(
        (d) => d.id === definitionId
      );
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
        // Optimistically remove the definition from the region (#2409).
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
        // Optimistically replace the definition by id in the region (#2409).
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
        // Optimistically append the folder to the region (#2409).
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
        // Optimistically replace the folder by id in the region (#2409).
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
        // Optimistically remove the folder and reparent its child definitions to
        // the root (the store's `delete_folder` does both, #2409).
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
      const existing = (currentAgentsView().agentFolders[agentId] ?? []).find(
        (f) => f.id === folderId
      );
      if (!existing) return;
      const folder = { ...existing, isExpanded: !existing.isExpanded };
      // Optimistically replace the folder (with its flipped expansion) in the
      // region (#2409), then fire-and-forget persist the expansion state.
      mirrorAgentIntent("agent.updateFolder", { id: agentId, folder });
      apiUpdateAgentFolder(agentId, { id: folderId, is_expanded: folder.isExpanded }).catch(
        () => {}
      );
    },

    resolveAgentErrorTabs: (agentId) => {
      const defs = currentAgentsView().agentDefinitions[agentId] ?? [];

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

      setAndReseed((s) => {
        const rootPanel = convertPanel(s.rootPanel);
        const tabGroups = s.tabGroups.map((g) => ({ ...g, rootPanel: convertPanel(g.rootPanel) }));
        return {
          rootPanel,
          tabGroups,
          // Instrument the agent-error → terminal conversion so the by-id content
          // map never goes stale (#2539): re-track every tab from the converted
          // trees, so a resolved tab now resolves as a `terminal` from `tabContent`.
          tabContent: tabContentFromGroups(tabGroups, s.activeTabGroupId, rootPanel),
        };
      });
    },

    // File browser — the view is owned by the authoritative `file-browser` region
    // (#2283). Each action does the async list op and reports its transitions
    // through granular `fileBrowser.*` intents; the bridge overlays them
    // optimistically (gap-free loading/pane/clipboard feedback) and the backend
    // `FileBrowserStore` confirms. There is no local slice to `set` — every reader
    // sources the view from the region via `useProjectedFileBrowsers()` /
    // `currentFileBrowsersView()`.

    // Local file browser
    navigateLocal: async (path: string) => {
      // Normalize Windows backslashes to forward slashes so path manipulation
      // in the frontend (navigateUp, path join) works uniformly on all platforms.
      // Also expand bare drive letters (e.g. "C:") to their root form ("C:/")
      // so the Up button can reliably detect the drive root boundary.
      let normalizedPath = path.replace(/\\/g, "/");
      if (/^[A-Za-z]:$/.test(normalizedPath)) {
        normalizedPath = normalizedPath + "/";
      }
      mirrorFileBrowserIntent("fileBrowser.loadStarted", { pane: "local" });
      try {
        const entries = await localListDir(normalizedPath);
        mirrorFileBrowserIntent("fileBrowser.loadSucceeded", {
          pane: "local",
          path: normalizedPath,
          entries,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        mirrorFileBrowserIntent("fileBrowser.loadFailed", { pane: "local", error: message });
      }
    },

    refreshLocal: async () => {
      const localCurrentPath = currentFileBrowsersView().local.path;
      mirrorFileBrowserIntent("fileBrowser.loadStarted", { pane: "local" });
      try {
        const entries = await localListDir(localCurrentPath);
        mirrorFileBrowserIntent("fileBrowser.loadSucceeded", {
          pane: "local",
          path: localCurrentPath,
          entries,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        mirrorFileBrowserIntent("fileBrowser.loadFailed", { pane: "local", error: message });
      }
    },

    // Session-based file browser
    sessionFileBrowserId: null,
    setSessionFileBrowserId: (sessionId) => set({ sessionFileBrowserId: sessionId }),

    navigateSession: async (sessionId: string, path: string) => {
      mirrorFileBrowserIntent("fileBrowser.loadStarted", { pane: "session" });
      try {
        const entries = await sessionListFiles(sessionId, path);
        mirrorFileBrowserIntent("fileBrowser.loadSucceeded", {
          pane: "session",
          path,
          entries,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        mirrorFileBrowserIntent("fileBrowser.loadFailed", { pane: "session", error: message });
      }
    },

    refreshSession: async () => {
      const { sessionFileBrowserId } = useAppStore.getState();
      if (!sessionFileBrowserId) return;
      const sessionCurrentPath = currentFileBrowsersView().session.path;
      mirrorFileBrowserIntent("fileBrowser.loadStarted", { pane: "session" });
      try {
        const entries = await sessionListFiles(sessionFileBrowserId, sessionCurrentPath);
        mirrorFileBrowserIntent("fileBrowser.loadSucceeded", {
          pane: "session",
          path: sessionCurrentPath,
          entries,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        mirrorFileBrowserIntent("fileBrowser.loadFailed", { pane: "session", error: message });
      }
    },

    // File browser mode
    setFileBrowserMode: (mode) => {
      mirrorFileBrowserIntent("fileBrowser.setMode", { mode });
    },

    // File clipboard (copy/cut)
    setFileClipboard: (clipboard) => {
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

    // Monitoring — state lives in the authoritative `system-monitors` region
    // (#2224), not here (audit gap G6, #1231).
    sessionCapabilities: {},

    // Remote-desktop resolutions (remoteDesktopResolutions + set/clear) provided
    // by createRemoteDesktopResolutionsSlice (#1709, extracted under #2077 via
    // #2300).

    clearMonitoringError: (key) => {
      const entry = currentMonitorsView().monitors[key];
      if (!entry || entry.error == null) return;
      // Region-authoritative (#2224): dismissing an error banner is a
      // client-originated action with no backend command, so dispatch the intent
      // against the region directly; the diff clears the entry's error.
      dispatchMonitorIntentBestEffort("monitor.clearError", { key });
    },

    setSessionCapabilities: (sessionId, caps) =>
      set((state) => ({
        sessionCapabilities: { ...state.sessionCapabilities, [sessionId]: caps },
      })),

    connectMonitoring: async (sessionId: string, host: string | null = null) => {
      // Unified session-based (push) monitoring: the key is the id of the terminal
      // session that owns the monitor. The backend owns the entry lifecycle in the
      // authoritative `system-monitors` region (#2224): the `session_monitoring_open`
      // command folds `open` (connecting, priming any cached stats from the store),
      // then the connect outcome `opened` / `openFailed` — all server-side. The
      // collector loop folds every subsequent stats/status sample (#2376). No
      // client-side entry, no event listeners, no `appStore` writes.
      const key = sessionId;

      // Ensure the region subscription is live so the connecting / opened / failed
      // diffs reach the UI (the status bar mounts it too, but a connect can race
      // that mount). Non-Tauri / no socket just leaves the UI on the empty view.
      void ensureMonitorsSubscribed().catch(() => {});

      // Preserve a previously-chosen refresh interval across a reconnect so the
      // user's rate selection is not silently reset (#1233), sourced from the
      // authoritative region.
      const intervalMs =
        currentMonitorsView().monitors[key]?.intervalMs ?? DEFAULT_MONITORING_INTERVAL_MS;

      // A rejection means the backend recorded `openFailed` in the region (the
      // command's error branch folds it), so the UI already shows the error
      // without any client write. Propagate so callers — the status bar
      // auto-connect latch and the Open Connections retry toast — can react.
      await sessionMonitoringOpen(key, host ?? key, intervalMs);
    },

    disconnectMonitoring: async (key) => {
      // Kill exactly one entry when a key is given, or every entry otherwise
      // (Open Connections "Kill All", global toggle-off). The current set is read
      // from the authoritative region (#2224).
      const monitors = currentMonitorsView().monitors;
      const keys = key !== undefined ? [key] : Object.keys(monitors);

      for (const k of keys) {
        const entry = monitors[k];
        if (entry?.monitorSessionId) {
          // A live monitor: the `session_monitoring_close` command tears down the
          // provider subscription and folds `close` into the region server-side
          // (retaining the stats cache for an instant reconnect). Ignore close
          // errors — the entry is torn down regardless.
          try {
            await sessionMonitoringClose(entry.monitorSessionId);
          } catch {
            // Ignore — torn down regardless.
          }
        } else {
          // A still-connecting or failed entry has no backend session to close, so
          // drop it from the region directly (a client-originated teardown).
          dispatchMonitorIntentBestEffort("monitor.close", { key: k });
        }
      }
    },

    setMonitoringPaused: async (key, paused) => {
      const entry = currentMonitorsView().monitors[key];
      if (!entry) return;
      if (entry.monitorSessionId) {
        // The backend session loop is authoritative: the `session_monitoring_set_paused`
        // command folds the pause/resume into the region at the source (#2224), and
        // the collector loop also emits the authoritative `paused`/`live` status.
        // A failure folds nothing, so the region stays live — the caller re-throws
        // to surface the error toast.
        await sessionMonitoringSetPaused(entry.monitorSessionId, paused);
      } else {
        // No backend session (a still-connecting entry): reflect the pause in the
        // region directly.
        dispatchMonitorIntentBestEffort("monitor.setPaused", { key, paused });
      }
    },

    setMonitoringInterval: async (key, intervalMs) => {
      const entry = currentMonitorsView().monitors[key];
      if (!entry) return;
      if (entry.monitorSessionId) {
        // The `session_monitoring_set_interval` command reconfigures the backend
        // loop cadence and folds the new interval into the region (#2224).
        await sessionMonitoringSetInterval(entry.monitorSessionId, intervalMs);
      } else {
        // No backend session yet: persist the chosen cadence in the region so the
        // next connect picks it up.
        dispatchMonitorIntentBestEffort("monitor.setInterval", { key, intervalMs });
      }
    },

    cancelMonitoring: async (key) => {
      const entry = currentMonitorsView().monitors[key];
      if (!entry) return;
      // Abort the backend monitor connect (keyed by session id) so a stuck
      // handshake stops promptly (#1233); the command folds `close` into the
      // region. Ignore errors — torn down anyway.
      try {
        await sessionMonitoringCancel(key);
      } catch (err) {
        frontendLog("monitoring", `cancel failed for ${key}: ${err}`);
      }
      // Belt-and-suspenders: drop any lingering entry (e.g. one that never
      // established a session) from the region so the picker / Retry is reachable.
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
      setAndReseed((state) => {
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
        return {
          rootPanel,
          activePanelId: targetPanelId,
          // Track the new tab's content (incl. tunnelEditorMeta) in the map (#2283).
          tabContent: setTabContentEntry(state.tabContent, newTab),
        };
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
            return {
              rootPanel,
              activePanelId: leaf.id,
              selectedPluginId: pluginId,
              // Keep the mapped content in sync with the re-pointed title/meta (#2283).
              tabContent: patchTabContentEntry(state.tabContent, existing.id, {
                title,
                pluginDetailMeta: { pluginId },
              }),
            };
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
        return {
          rootPanel,
          activePanelId: targetPanelId,
          selectedPluginId: pluginId,
          // Track the new tab's content (incl. pluginDetailMeta) in the map (#2283).
          tabContent: setTabContentEntry(state.tabContent, newTab),
        };
      }),

    // Macro recording (#1674) + playback (#1675) provided by createMacrosSlice (#2114).

    // Broadcast input (#1955) — the membership state lives in the authoritative
    // `broadcast@<clientId>` region (#2206); these actions dispatch `broadcast.*`
    // intents and read `currentBroadcastView()`. `appStore` holds no broadcast
    // state (reducer removal, #2206). Broadcast has no server data source, so the
    // dispatched intents are the only path that mutates the machine.

    startBroadcast: (scope, sourceTabId, targetTabIds) => {
      // The store reproduces `{source} ∪ targets` from the same args, so pass the
      // raw resolved targets (not a source-prefixed set).
      dispatchBroadcastIntentBestEffort("broadcast.start", { scope, sourceTabId, targetTabIds });
    },

    stopBroadcast: () => {
      // The store retains scope/lastScope across the stop for the keyboard toggle.
      dispatchBroadcastIntentBestEffort("broadcast.stop", {});
    },

    toggleBroadcast: () => {
      // Second press (or any press while active) turns broadcast off, regardless
      // of which tab is focused — mirrors the toolbar toggle and the status-bar
      // Stop pill.
      if (currentBroadcastView().active) {
        get().stopBroadcast();
        return;
      }
      const state = get();
      const source = getActiveTab(state);
      if (!source || source.contentType !== "terminal") {
        toast.info("Focus a terminal to start broadcasting input");
        return;
      }
      // Reuse the last scope, skipping the dropdown. A remembered "custom"
      // selection lives only in the picker and cannot be rebuilt here, so it
      // degrades to "all terminals" (#1958).
      const lastScope = currentBroadcastView().lastScope;
      const scope: BroadcastScope = lastScope === "custom" ? "all" : lastScope;
      const targets = resolveBroadcastTargetTabIds(state, scope, source.id);
      get().startBroadcast(scope, source.id, targets);
    },

    addBroadcastTarget: (tabId) => {
      // Read-then-dispatch so the intent fires only on a real change (a no-op add
      // must not dispatch a redundant intent), matching the store's pure set-insert.
      if (currentBroadcastView().targetTabIds.includes(tabId)) return;
      dispatchBroadcastIntentBestEffort("broadcast.addTarget", { tabId });
    },

    removeBroadcastTarget: (tabId) => {
      if (!currentBroadcastView().targetTabIds.includes(tabId)) return;
      dispatchBroadcastIntentBestEffort("broadcast.removeTarget", { tabId });
    },

    isBroadcastTarget: (tabId) => currentBroadcastView().targetTabIds.includes(tabId),

    getBroadcastTargetTabIds: () => {
      const view = currentBroadcastView();
      if (!view.active) return [];
      const state = get();
      const statusMaps: TabStatusMaps = {
        terminalConnecting: state.terminalConnecting,
        terminalReconnectingTabs: state.terminalReconnectingTabs,
        terminalSpawnErrors: state.terminalSpawnErrors,
        terminalDisconnectErrors: state.terminalDisconnectErrors,
        terminalExitedTabs: state.terminalExitedTabs,
      };
      const tabsById = new Map(collectLiveTabs(state).map((t) => [t.id, t]));
      const result: string[] = [];
      for (const tabId of view.targetTabIds) {
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
      const view = currentBroadcastView();
      if (!view.active) return;
      const source = view.sourceTabId;
      if (!source) return;
      // Custom selection is frozen at pick time — never auto-add. Removal of
      // closed targets is handled at the tab-close seam.
      if (view.scope === "custom") return;
      const state = get();
      const resolved = resolveBroadcastTargetTabIds(state, view.scope, source);
      const next = new Set<string>([source, ...resolved]);
      const prev = new Set(view.targetTabIds);
      // Skip the work (and its intents) when membership is unchanged.
      if (next.size === prev.size && [...next].every((id) => prev.has(id))) return;
      // The store owns no bulk-set intent, so reconcile the region to the
      // recomputed membership via granular add/remove intents for the delta
      // (mirroring the connected-terminal refresh at the fan-out seam).
      for (const id of next) {
        if (!prev.has(id)) dispatchBroadcastIntentBestEffort("broadcast.addTarget", { tabId: id });
      }
      for (const id of prev) {
        if (!next.has(id))
          dispatchBroadcastIntentBestEffort("broadcast.removeTarget", { tabId: id });
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
        const settings = currentSettingsView();
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
          const current = currentSettingsView();
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
        // The panel's identity + status are authoritative in the projected region
        // (dispatched below); its streamed lines/exitCode/timedOut are frontend-
        // owned and live in the bridge's content store (#2206 reducer-removal).
        let lineSeq = 0;
        openWorkflowOutputContent(workflowId);
        await dispatchWorkflowOutputOpened({
          workflowId,
          workflowName: workflow.name,
          program,
          args,
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
          // Frontend-owned streamed content — appended to the bridge's content
          // store (bounded there), not the projection.
          appendWorkflowOutputLine(nextLine);
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
          // Record the process outcome on the inline surface (frontend-owned
          // streamed content). The overall run status (completed / cancelled /
          // failed) is stamped on the projected panel once the run resolves; here
          // we surface only the raw exit code / timeout (#1865).
          setWorkflowOutputProcessResult(outcome.exitCode, outcome.timedOut);
          return outcome;
        } catch (err) {
          // A backend rejection (e.g. opt-in disabled at the trust boundary)
          // surfaces as a failed step rather than crashing the run.
          const message = err instanceof Error ? err.message : String(err);
          frontendLog("workflow", `local process error: ${message}`);
          setWorkflowOutputProcessResult(1, false);
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
      // Clear any prior run's frontend-owned streamed content when a fresh run
      // starts; a new panel is created lazily only if this run spawns a local
      // process (#1865). The projected panel is reset by `runStarted` below.
      clearWorkflowOutputContent();
      // The workflow-run region is authoritative (#2206 reducer-removal): the run
      // progress + output-panel status are driven solely by dispatching the
      // `workflow.*` intents. Keep the subscription warm so the render hook
      // receives the resulting diffs.
      try {
        void ensureWorkflowSubscribed().catch(() => {
          /* logged in the bridge; render simply stays on the last-known view */
        });
      } catch {
        /* non-Tauri env without a socket — dispatch logs + no-ops */
      }
      await dispatchWorkflowRunStarted({
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
            // Advance the authoritative run progress (guarded server-side to the
            // still-current run). Fire-and-forget: the intent is submitted
            // synchronously, so successive advances apply in order.
            void dispatchWorkflowStepAdvanced({ workflowId, tabId: targetTabId, completed });
            toast.loading(`Running workflow "${workflow.name}"…`, {
              id: toastId,
              description: `${completed} / ${stepTotal} steps`,
            });
          },
        }
      );
      activeWorkflowRun = handle;

      const result = await handle.done;

      // Only settle the run when it is still the current one — a newer
      // runWorkflow may have replaced it while this one was cancelled. The settle
      // clears the projected run and stamps the terminal status onto the projected
      // output panel; the frontend streamed content (exit code / lines) is kept.
      if (activeWorkflowRun === handle) {
        activeWorkflowRun = null;
        await dispatchWorkflowRunSettled(
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

    dismissWorkflowRunOutput: () => {
      // Clear the frontend-owned streamed content and dismiss the projected panel
      // (the region is authoritative for the panel's presence + status).
      clearWorkflowOutputContent();
      void dispatchWorkflowDismissOutput();
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
      setAndReseed((state) => {
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
        return {
          rootPanel,
          activePanelId: targetPanelId,
          // Track the new tab's content (incl. workspaceEditorMeta) in the map (#2283).
          tabContent: setTabContentEntry(state.tabContent, newTab),
        };
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
        const disconnectedAgentsNeedingCreds = currentAgentsView().remoteAgents.filter((agent) => {
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
              const saved = currentConnectionsView().connections.find(
                (c) => c.id === tabDef.connectionRef
              );
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
          currentConnectionsView().connections.map(async (conn) => {
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
        const freshAgentsView = currentAgentsView();
        const agentContext = {
          agents: freshAgentsView.remoteAgents.map((a) => ({
            id: a.id,
            name: a.name,
            connected: a.connectionState === "connected" || justConnectedAgentIds.has(a.id),
          })),
          definitions: freshAgentsView.agentDefinitions,
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
        setAndReseed({
          tabGroups: builtGroups,
          activeTabGroupId: firstGroup.id,
          rootPanel: firstGroup.rootPanel,
          activePanelId: firstGroup.activePanelId,
          activeWorkspaceName: definition.name,
          // Track every restored tab — including `agent-error` — in the by-id
          // content map so it resolves from `tabContent` (#2539).
          tabContent: tabContentFromGroups(builtGroups),
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
            currentConnectionsView().connections
          );
          stampedGroups = stampWindowId(tabGroups, currentWindowLabel());
          windows = buildWindowsMeta(stampedGroups);
        } else {
          const tabGroups = captureAllTabGroups(
            state.tabGroups,
            state.activeTabGroupId,
            state.rootPanel,
            currentConnectionsView().connections
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
      if ((await resolveRestoreMode(currentSettingsView())) === "never") return;
      const ownGroups = captureAllTabGroups(
        state.tabGroups,
        state.activeTabGroupId,
        state.rootPanel,
        currentConnectionsView().connections
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
        const agentsView = currentAgentsView();
        const agentContext = {
          agents: agentsView.remoteAgents.map((a) => ({
            id: a.id,
            name: a.name,
            connected: a.connectionState === "connected",
          })),
          definitions: agentsView.agentDefinitions,
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
          currentConnectionsView().connections,
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
        setAndReseed({
          tabGroups: builtGroups,
          activeTabGroupId: activeGroup.id,
          rootPanel: activeGroup.rootPanel,
          activePanelId: activeGroup.activePanelId,
          // Track every restored tab — including `agent-error` — in the by-id
          // content map so it resolves from `tabContent` (#2539).
          tabContent: tabContentFromGroups(builtGroups),
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
        const summary = await summarizeLastSession(session, currentConnectionsView().connections);
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
          ...currentSettingsView(),
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
          ...currentSettingsView(),
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
          const currentSettings = currentSettingsView();
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
        // Refresh the persisted settings so skippedVersion is current, then reflect
        // it into the authoritative region (#2404) — no `appStore` slice to set.
        const updatedSettings = await import("@/services/storage").then((m) => m.getSettings());
        set({ updateNotificationDismissed: true });
        mirrorSettingsIntent("settings.replace", { settings: updatedSettings });
      } catch (err) {
        frontendLog("update", `Failed to skip version: ${err}`);
      }
    },
    clearSkippedUpdateVersion: async () => {
      try {
        await apiClearSkippedVersion();
        const updatedSettings = await import("@/services/storage").then((m) => m.getSettings());
        // Reflect the refreshed persisted document into the authoritative region
        // (#2404) — no `appStore` slice to set.
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

// Region→appStore layout mirror (#2283 slice E2). `appStore`'s layout fields
// (`rootPanel`/`activePanelId`/`tabGroups`/`activeTabGroupId`) are now derived
// **solely** from the `layout@<clientId>` projection: every structural op
// dispatches only its region intent (an optimistic overlay that emits
// synchronously), the non-intent writers reseed the region, and this mirror
// composes that view back into `appStore` — the region is the sole authority for
// the layout the UI renders (the local reducers were removed in this slice).
//
// Unconditional (E1's `viewMatchesTree` gate is gone): the mirror composes on
// every change. `composeLayoutState` guards against the transient cases — it
// returns `null` for an empty/absent view (the initial backend-default snapshot
// before the seed below lands) or a view that references a tab absent from both
// the content map and the current tree — leaving `appStore` on its last-good
// tree. Directional `lastActiveLeafId` marks are applied on top by the `#448`
// subscription above and reseeded into the region so they survive convergence.
subscribeLayoutRegion((view) => {
  const state = useAppStore.getState();
  const composed = composeLayoutState(view, state.rootPanel, state.tabGroups, state.tabContent);
  if (composed) useAppStore.setState(composed);
});

// Seed the region from `appStore`'s initial layout at startup so the mirror's
// first composition reproduces the initial tree (rather than composing a
// backend-default snapshot over it). Optimistic, so it lands synchronously.
reseedLayoutRegion(
  buildLayoutSnapshot(
    useAppStore.getState().tabGroups,
    useAppStore.getState().activeTabGroupId,
    useAppStore.getState().rootPanel,
    useAppStore.getState().activePanelId
  )
);

/**
 * Render a settled restore/launch cohort's aggregate summary toast from the
 * projected settlement (#2206, reducer removal). Fired once per new monotonic
 * settlement `seq` by the restore-cohort bridge. The store owns this render because
 * it needs the tab registry: the region keeps the raw retry set, and the summary's
 * bulk "Reconnect failed tabs" action is offered only for tabs that still exist as
 * live terminals (the live-terminal filter, exactly as before).
 */
function renderProjectedRestoreSummary(settlement: ProjectedSettlement): void {
  const { total, restored, failed, retryTabIds, toastId } = settlement;
  frontendLog(
    "workspace_restore",
    `restore cohort settled: ${restored}/${total} connected, ${failed} failed`
  );
  const liveTerminalIds = new Set(
    collectLiveTabs(useAppStore.getState())
      .filter((t) => t.contentType === "terminal")
      .map((t) => t.id)
  );
  const filtered = retryTabIds.filter((id) => liveTerminalIds.has(id));
  raiseRestoreSummary({ total, restored, failed, toastId: toastId ?? undefined }, filtered, () =>
    useAppStore.getState().reconnectFailedRestoreTabs()
  );
}

// Wire the projected-settlement render surface to the store once at module init.
setRestoreSettlementRenderer(renderProjectedRestoreSummary);

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
