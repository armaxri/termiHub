import { create } from "zustand";
import { FileEntry } from "@/types/connection";
import { TabContentType, TerminalOptions } from "@/types/terminal";
import { reclaimSession as apiReclaimSession } from "@/services/api";
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
import { createFileBrowsersSlice, FileBrowsersSlice } from "./slices/fileBrowsersSlice";
import { createTransfersSlice, TransfersSlice } from "./slices/transfersSlice";
import { createConnectionTreeSlice, ConnectionTreeSlice } from "./slices/connectionTreeSlice";
import { createMonitoringSlice, MonitoringSlice } from "./slices/monitoringSlice";
import { createWorkflowsSlice, WorkflowsSlice } from "./slices/workflowsSlice";
import { createSchedulesSlice, SchedulesSlice } from "./slices/schedulesSlice";
import { createCredentialStoreSlice, CredentialStoreSlice } from "./slices/credentialStoreSlice";
import { createUpdateCheckerSlice, UpdateCheckerSlice } from "./slices/updateCheckerSlice";
import { createPortableModeSlice, PortableModeSlice } from "./slices/portableModeSlice";
import { createEditorSlice, EditorSlice } from "./slices/editorSlice";
import { createSettingsSlice, SettingsSlice } from "./slices/settingsSlice";
import { createUiChromeSlice, UiChromeSlice } from "./slices/uiChromeSlice";
import { createAgentsSlice, AgentsSlice } from "./slices/agentsSlice";
import { createBroadcastSlice, BroadcastSlice } from "./slices/broadcastSlice";
import { createPanelZoomSlice, PanelZoomSlice } from "./slices/panelZoomSlice";
import { createChordPendingSlice, ChordPendingSlice } from "./slices/chordPendingSlice";
import {
  createSessionHighlightingSlice,
  SessionHighlightingSlice,
} from "./slices/sessionHighlightingSlice";
import { createTabRuntimeSlice, TabRuntimeSlice } from "./slices/tabRuntimeSlice";
import {
  createTerminalSessionStateSlice,
  TerminalSessionStateSlice,
} from "./slices/terminalSessionStateSlice";
import {
  createPersistentSessionsSlice,
  PersistentSessionsSlice,
} from "./slices/persistentSessionsSlice";
import { createRestoreCohortSlice, RestoreCohortSlice } from "./slices/restoreCohortSlice";
import { createStartupSlice, StartupSlice } from "./slices/startupSlice";
import { createWindowManagementSlice, WindowManagementSlice } from "./slices/windowManagementSlice";
import { createTabGroupsSlice, TabGroupsSlice } from "./slices/tabGroupsSlice";
import { createLayoutSlice, LayoutSlice } from "./slices/layoutSlice";
import { createTabOpenersSlice, TabOpenersSlice } from "./slices/tabOpenersSlice";
import {
  createLayoutPersistenceSlice,
  LayoutPersistenceSlice,
} from "./slices/layoutPersistenceSlice";

export type { MacroPlaybackState } from "./slices/macrosSlice";
export type {
  WorkflowRunState,
  WorkflowRunOutputLine,
  WorkflowRunOutputStatus,
  WorkflowRunOutputState,
  LocalProcessAuthDecision,
} from "./slices/workflowsSlice";
import { createWorkspacesSlice, WorkspacesSlice } from "./slices/workspacesSlice";

import { frontendLog } from "@/utils/frontendLog";
import { toast } from "@/components/ui";
import { errorMessage } from "@/utils/errorMessage";
import { bindAppStore } from "./appStoreHandle";
import { installStoreSubscriptions } from "./storeSubscriptions";

// The module-level helpers live in their own modules (ARCH-001/FES-011, #2881) so
// the slices import them without pulling in this root store; they are
// re-exported here so every existing `@/store/appStore` import keeps working.
export {
  collectLiveTabs,
  extractTabContent,
  tabContentFromGroups,
  getComposedLayout,
  getActiveTab,
} from "./layoutHelpers";
export {
  deriveEditorHostLabel,
  resolveBroadcastTargetTabIds,
  filterConnectedTerminalTabIds,
  monitorKeyForTab,
} from "./tabQueries";
export {
  ABORTED_CONNECT_MESSAGE,
  isResilientReconnectTabId,
  isBackendDrivenAgentReconnectTabId,
  onReconnectCommandForTabId,
} from "./reconnectHelpers";

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
    TerminalSearchSlice,
    FileBrowsersSlice,
    TransfersSlice,
    ConnectionTreeSlice,
    MonitoringSlice,
    WorkflowsSlice,
    SchedulesSlice,
    WorkspacesSlice,
    CredentialStoreSlice,
    UpdateCheckerSlice,
    PortableModeSlice,
    EditorSlice,
    SettingsSlice,
    UiChromeSlice,
    AgentsSlice,
    BroadcastSlice,
    PanelZoomSlice,
    ChordPendingSlice,
    SessionHighlightingSlice,
    TabRuntimeSlice,
    TerminalSessionStateSlice,
    PersistentSessionsSlice,
    RestoreCohortSlice,
    StartupSlice,
    WindowManagementSlice,
    TabGroupsSlice,
    LayoutSlice,
    TabOpenersSlice,
    LayoutPersistenceSlice {
  /**
   * Explicitly **reclaim** a tab whose session another desktop/window took over
   * (SM-003, single-attach): the one user action that leaves the sticky `evicted`
   * state. Performs a takeover attach (evicting the other side); the backend folds
   * the region `evicted → connected`. On failure the tab stays evicted and an
   * error toast explains why — nothing retries automatically. Resolves `true` on
   * success.
   */
  reclaimSession: (tabId: string) => Promise<boolean>;
}

/**
 * The root store: a composition of the domain slices under `./slices/` (#2077,
 * ARCH-001/FES-011 via #2881), each spread in with the shared `set` / `get`. Only
 * `reclaimSession` stays inline: the takeover audit (#3395) pins the one
 * takeover-attach call site to this file.
 */
export const useAppStore = create<AppState>((set, get, store) => {
  return {
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
    ...createFileBrowsersSlice(set, get, store),
    ...createTransfersSlice(set, get, store),
    ...createConnectionTreeSlice(set, get, store),
    ...createMonitoringSlice(set, get, store),
    ...createWorkflowsSlice(set, get, store),
    ...createSchedulesSlice(set, get, store),
    ...createWorkspacesSlice(set, get, store),
    ...createCredentialStoreSlice(set, get, store),
    ...createUpdateCheckerSlice(set, get, store),
    ...createPortableModeSlice(set, get, store),
    ...createSettingsSlice(set, get, store),
    ...createUiChromeSlice(set, get, store),
    ...createAgentsSlice(set, get, store),
    ...createBroadcastSlice(set, get, store),
    ...createPanelZoomSlice(set, get, store),
    ...createChordPendingSlice(set, get, store),
    ...createSessionHighlightingSlice(set, get, store),
    ...createTabRuntimeSlice(set, get, store),
    ...createTerminalSessionStateSlice(set, get, store),
    ...createPersistentSessionsSlice(set, get, store),
    ...createRestoreCohortSlice(set, get, store),
    ...createStartupSlice(set, get, store),
    ...createWindowManagementSlice(set, get, store),
    ...createTabGroupsSlice(set, get, store),
    ...createLayoutSlice(set, get, store),
    ...createTabOpenersSlice(set, get, store),
    ...createEditorSlice(set, get, store),
    ...createLayoutPersistenceSlice(set, get, store),

    reclaimSession: async (tabId) => {
      try {
        await apiReclaimSession(tabId);
        return true;
      } catch (err) {
        frontendLog("app_store", `Failed to reclaim session for ${tabId}: ${errorMessage(err)}`);
        toast.error(`Could not reclaim the session: ${errorMessage(err)}`);
        return false;
      }
    },
  };
});

// Bind the store for the helper modules, then install the startup subscriptions
// in their original order: the active-workspace name sync, the split-mark
// tracker, the layout mirror and seed, the restore-summary renderer and the
// reconnect observer.
bindAppStore(useAppStore);
installStoreSubscriptions();
