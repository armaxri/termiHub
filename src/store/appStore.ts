import { create } from "zustand";
import {
  TerminalTab,
  TabContent,
  LeafPanel,
  PanelNode,
  ConnectionConfig,
  TabContentType,
  TerminalOptions,
  EditorTabMeta,
  EditorSessionRef,
  TabGroup,
  BroadcastScope,
} from "@/types/terminal";
import { FileEntry, TransferState } from "@/types/connection";
import { deriveTabStatus, type TabStatusMaps } from "@/utils/tabStatus";
import { isAutoReconnectEnabled } from "@/utils/autoReconnect";
import {
  closeTerminal as apiCloseTerminal,
  reclaimSession as apiReclaimSession,
  detachPersistentTab as apiDetachPersistentTab,
  listSerialPorts,
  openWindow,
  releaseSession,
  reportWindowLayout,
  collectWindowLayouts,
} from "@/services/api";
import type { TabHandoffRecord, HandoffTab } from "@/types/window";
import { MAIN_WINDOW_LABEL } from "@/types/window";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { assembleWindowedGroups } from "@/utils/windowPersistence";
import type { CapturedWindowLayout, WindowRestorePlanEntry } from "@/utils/windowPersistence";
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

export type { MacroPlaybackState, PlayMacroOptions } from "./slices/macrosSlice";
export type {
  WorkflowRunState,
  WorkflowRunOutputLine,
  WorkflowRunOutputStatus,
  WorkflowRunOutputState,
  RunWorkflowOptions,
  LocalProcessAuthDecision,
  LocalProcessPromptState,
  WorkflowParamPromptState,
} from "./slices/workflowsSlice";
import { createWorkspacesSlice, WorkspacesSlice } from "./slices/workspacesSlice";

import { type WorkspaceTabGroupDef, type WorkspaceWindowDef } from "@/types/workspace";
import { type RestorePrompt } from "@/utils/restoreMode";
import { probeRestoreTargets } from "@/utils/restoreReachability";
import { probeTargetReachable } from "@/services/networkApi";
import { getTerminalInputInjector } from "@/services/macroPlayback";
import { newId } from "@/services/transport/ids";
import { getActiveWorkspace, subscribeActiveWorkspace } from "@/services/workspaceSettings";
import { fireAndForget, frontendLog } from "@/utils/frontendLog";
import { toast } from "@/components/ui";
import {
  createLeafPanel,
  findLeaf,
  findLeafByTab,
  getAllLeaves,
  markActiveLeaf,
  normalizeSizes,
} from "@/utils/panelTree";
import {
  buildLayoutSnapshot,
  type ComposedLayoutState,
  type LayoutSnapshot,
  type LayoutSplitMarks,
  type LayoutView,
  reconcileLayoutFromView,
  reseedLayoutRegion,
  splitMarksOfTree,
  subscribeLayoutRegion,
} from "@/store/layoutBridge";
import {
  currentSessionView,
  effectiveConnectingMap,
  effectiveDisconnectErrorMap,
  effectiveExitedMap,
  effectiveEvictedMap,
  effectiveReconnectingMap,
  ensureSessionSubscribed,
  logSessionBridgeFallback,
  onSessionView,
} from "@/store/sessionBridge";
import {
  setRestoreSettlementRenderer,
  type ProjectedSettlement,
} from "@/store/restoreCohortBridge";
import { errorMessage } from "@/utils/errorMessage";

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
export function omitKey<V>(rec: Record<string, V>, key: string): Record<string, V> {
  const { [key]: _, ...rest } = rec;
  return rest;
}

/**
 * Failed-state message shown when the user aborts an in-flight connect from the
 * connecting / waiting / auto-retry overlay. The tab stays open on a retryable
 * Failed state rather than closing (#1128).
 */
export const ABORTED_CONNECT_MESSAGE = "Connection aborted.";

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
 * The runtime label of the window this store belongs to (multi-window
 * persistence, #1905), used to stamp captured tab groups with their owning
 * window. Falls back to {@link MAIN_WINDOW_LABEL} when the Tauri window API is
 * unavailable (e.g. browser dev mode) so capture never throws.
 */
export function currentWindowLabel(): string {
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
export async function captureAllWindows(
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
export async function restoreWindowedLayout(
  plan: WindowRestorePlanEntry[]
): Promise<WorkspaceTabGroupDef[]> {
  await spawnPlanSecondaryWindows(plan);
  const mainEntry = plan.find((entry) => entry.isMain);
  return mainEntry ? mainEntry.tabGroups : plan.flatMap((entry) => entry.tabGroups);
}

export const LAST_SESSION_SAVE_DEBOUNCE_MS = 500;
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
export function beginRestoreGuard(setState: (partial: Partial<AppState>) => void): void {
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
export async function probeRestorePromptReachability(
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
export function collectWindowTabs(state: LayoutViewState): TerminalTab[] {
  const { tabGroups } = getComposedLayout(state);
  return tabGroups.flatMap((g) => getAllLeaves(g.rootPanel).flatMap((leaf) => leaf.tabs));
}

/**
 * Fire a multi-window ownership call (claim/release, #1939) as a best-effort
 * signal: a rejected IPC promise is swallowed, and a synchronous throw — which
 * only happens when a unit test stubs `@/services/api` without the command — is
 * caught. Ownership is advisory (it feeds the #1926 owning-window badge and
 * resize gating), so it must never disrupt the session assignment that triggered
 * it.
 */
export function bestEffortOwnership(op: () => Promise<unknown>): void {
  try {
    fireAndForget(op(), "advisory multi-window session ownership");
  } catch {
    // api layer unavailable (unit tests stub @/services/api).
  }
}

export function teardownAllSessions(state: LayoutViewState): void {
  const tabs = collectWindowTabs(state);
  let closed = 0;
  for (const tab of tabs) {
    if (!tab.sessionId) continue;
    const sessionId = tab.sessionId;
    closed++;
    if (tab.persistentConnectionId) {
      // Persistent session — detach so the background process keeps running.
      // A failed detach may leak the backend session, so surface it at ERROR
      // (bulk teardown — LogViewer visibility, no per-item toast) (UX-033).
      fireAndForget(
        apiDetachPersistentTab(sessionId, tab.id),
        `detach persistent session ${sessionId} during workspace teardown`,
        "error"
      );
    } else {
      fireAndForget(
        apiCloseTerminal(sessionId),
        `close session ${sessionId} during workspace teardown`,
        "error"
      );
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
export function collectRestoreCohort(groups: TabGroup[]): {
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
export function resolveEditorSessionKey(
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
  state: LayoutViewState,
  meta: Pick<EditorTabMeta, "isRemote" | "sessionBrowser" | "sessionKey">
): string | null {
  if (!meta.isRemote || !meta.sessionBrowser) return null;
  const tabs = getAllLeaves(getComposedLayout(state).rootPanel).flatMap((l) => l.tabs);
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
export function collectLiveTabs(state: LayoutViewState): TerminalTab[] {
  const { tabGroups } = getComposedLayout(state);
  return tabGroups.flatMap((g) => getAllLeaves(g.rootPanel).flatMap((leaf) => leaf.tabs));
}

// ── Resilient reconnect eligibility + on-reconnect command (#1962 / #2205) ──
//
// The resilient-reconnect *loop* is owned entirely by the backend redrive since
// #2205 PR-B — the client no longer runs a backoff timer or a `driveAutoReconnect`
// engine. What survives on the client is the pure eligibility classification (fed
// to the backend at connect time so it knows which tabs to redrive) and the
// on-reconnect command the overlay announces and `setTabSessionId` runs.

/**
 * Whether a tab is eligible for resilient reconnect. Two distinct populations,
 * both excluding persistent sessions (those have their own continuity machinery):
 *
 * - **Agentless direct SSH (#1962):** a plain SSH terminal whose connection has the
 *   unified "Auto-Reconnect" setting enabled — on by default (PARITY-008), so only
 *   an explicit opt-out excludes it. Backend-driven backoff loop.
 * - **Agent-hosted (#2476):** a shell session on a remote agent — always
 *   resilient. The agent reconnect is backend-driven (park + retry + new-sessionId
 *   re-attach), and backend-reattach is now unconditional (#2560), so every
 *   agent-hosted tab is eligible.
 *
 * Reads the auto-reconnect setting / agent marker from the tab's connection config.
 */
export function isResilientReconnectTab(tab: TerminalTab | undefined): boolean {
  if (!tab) return false;
  if (tab.contentType !== "terminal") return false;
  if (tab.persistentConnectionId) return false;
  const cfg = tab.config?.config as Record<string, unknown> | undefined;
  if (!cfg) return false;
  if (cfg.agentId) {
    // Agent-hosted tab (#2476): always resilient — the backend redrive is the sole
    // reconnect authority and backend-reattach is unconditional (#2560).
    return true;
  }
  if (tab.connectionType !== "ssh") return false;
  return isAutoReconnectEnabled(cfg);
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
 * by the backend redrive (#2476), as opposed to an agentless direct-SSH resilient
 * tab (#1962/#2457) whose reconnect the client still drives (with the
 * backend-reattach id as a fast path).
 *
 * This is the discriminator for the two agent-specific cuts of the reconnect path:
 *  - `Terminal.tsx` routes only these tabs through the give-up-aware wait that
 *    stays deferred to the backend loop across a prolonged drop (never falling
 *    through to the non-idempotent client agent engine — the double-drive fix);
 *  - `reconnectTerminal` skips arming the fixed 90 s "connecting" deadline for
 *    these tabs, since the backend park/retry legitimately outlasts it and the
 *    give-up fold — not a client wall-clock timeout — is what settles the tab.
 */
export function isBackendDrivenAgentReconnectTabId(tabId: string): boolean {
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
 * The trimmed on-reconnect command for a tab id (#1978), or `undefined` when none
 * is set / the tab is gone. The exported entry the reconnect-countdown overlay
 * uses to re-attach the per-client presentation onto the projected loop record
 * ({@link import("./useSessionLifecycle").useSessionAutoReconnect}) now that the
 * region — not a local `appStore` record — is the source of the loop (#2205).
 */
export function onReconnectCommandForTabId(tabId: string): string | undefined {
  return onReconnectCommandForTab(findTabById(tabId));
}

/**
 * Find a terminal tab by id across the active panel tree (#1978 helper). Used by
 * the auto-reconnect loop to read a tab's live connection config when settling.
 */
function findTabById(tabId: string): TerminalTab | undefined {
  return getAllLeaves(getComposedLayout(useAppStore.getState()).rootPanel)
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
export function runOnReconnectCommand(tabId: string): void {
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

// The region reconnect observer is wired exactly once (it reads the live store,
// so one listener serves every tab). Wired eagerly at store init so the backend
// redrive drives a reconnect even before any component subscribes.
let sessionReconnectObserverWired = false;

/**
 * Wire the reconnect observer once (#2205 PR-B): subscribe to the shared
 * `session-lifecycle` region — the sole reconnect authority now the client engine
 * is gone — and, on the backend redrive's `Waiting → Connecting` reconnect edge,
 * re-drive the owning tab through {@link AppState.reconnectTerminal}. That bumps
 * the tab's retry counter so its `Terminal` effect re-runs and re-attaches to the
 * fresh backend session id the redrive publishes (agent + direct-SSH alike).
 *
 * The edge is read purely from the region's own `prev`/`next` phases (no local
 * loop record to consult), so a redrive that races the projected diff is
 * idempotent: `reconnectTerminal` from an already-driven tab only re-bumps the
 * counter, and a phase that is not the `waiting → connecting` edge is ignored.
 *
 * Wired eagerly at store init (not lazily), so a drop folded into the region by
 * the backend is redriven even when no overlay/hook has subscribed yet.
 */
export function wireSessionReconnectObserver(): void {
  if (!sessionReconnectObserverWired) {
    sessionReconnectObserverWired = true;
    onSessionView((next, prev) => {
      for (const [tabId, life] of Object.entries(next)) {
        const before = prev[tabId];
        if (life.reconnect.phase === "connecting" && before?.reconnect.phase === "waiting") {
          useAppStore.getState().reconnectTerminal(tabId);
        }
      }
    });
  }
  // `ensureSessionSubscribed` builds the transport eagerly, so a non-Tauri env
  // without a socket throws synchronously (not just a rejection) — guard both, so
  // the eager module-init wiring never throws at import (best-effort, like the
  // overlay hooks that also subscribe).
  try {
    ensureSessionSubscribed().catch((err) => logSessionBridgeFallback("subscribe", err));
  } catch (err) {
    logSessionBridgeFallback("subscribe", err);
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
 * The subset of `tabIds` that are *connected* terminal tabs able to receive
 * input right now — live, terminal content, backed by a session, status
 * `connected`, and not taken over by another desktop/window (SM-003 / #3368).
 * Order follows `tabIds`. The single connected-terminal filter shared by the
 * broadcast fan-out ({@link AppState.getBroadcastTargetTabIds}) and multi-target
 * macro playback (PROD-042, #3443), so both skip exactly the same tabs.
 */
export function filterConnectedTerminalTabIds(state: AppState, tabIds: Iterable<string>): string[] {
  // Connect / reconnect / disconnect-error / exited status is sourced from the
  // shared `session-lifecycle` region — the sole authority since the `appStore`
  // twins were removed (#2205 PR-B / #2625); only spawn errors stay per-client.
  const sessionView = currentSessionView();
  const statusMaps: TabStatusMaps = {
    terminalConnecting: effectiveConnectingMap(sessionView),
    terminalReconnectingTabs: effectiveReconnectingMap(sessionView),
    terminalSpawnErrors: state.terminalSpawnErrors,
    terminalDisconnectErrors: effectiveDisconnectErrorMap(sessionView),
    terminalExitedTabs: effectiveExitedMap(sessionView),
    // SM-003: a tab another desktop took over must never receive input.
    terminalEvicted: effectiveEvictedMap(sessionView),
  };
  const tabsById = new Map(collectLiveTabs(state).map((t) => [t.id, t]));
  const result: string[] = [];
  for (const tabId of tabIds) {
    const tab = tabsById.get(tabId);
    // Only connected terminal sessions receive input. Disconnected/
    // connecting sessions and non-terminal tabs are skipped silently.
    if (!tab || tab.contentType !== "terminal" || !tab.sessionId) continue;
    if (deriveTabStatus(statusMaps, tabId) !== "connected") continue;
    // #3368: nor a tab whose session another window took over.
    if (state.isSessionWindowEvicted(tab.sessionId)) continue;
    result.push(tabId);
  }
  return result;
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

export function createTab(
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
  return {
    id: newId("tab"),
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
export function setTabContentEntry(
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
export function tabContentFromGroups(
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
export function patchTabContentEntry(
  map: Record<string, TabContent>,
  tabId: string,
  patch: Partial<TabContent>
): Record<string, TabContent> {
  const current = map[tabId];
  if (!current) return map;
  return { ...map, [tabId]: { ...current, ...patch } };
}

// ── Region-derived layout composition (#2562) ────────────────────────────────
//
// The rich layout (`rootPanel`/`activePanelId`/`tabGroups`/`activeTabGroupId`) is
// no longer stored on `appStore`; it is composed on demand from the raw
// `layoutView` + `tabContent` + `layoutSplitMarks` via
// {@link composeLayoutFromView}. `getComposedLayout` memoizes that composition per
// `layoutView` identity (keyed also on `tabContent`/`layoutSplitMarks` identity),
// so repeated reads across a render and across unrelated store changes return the
// **same** object reference — this is the render-storm guard the reducer-removal
// design calls for.

/** The minimal state slice the layout composition reads. */
type LayoutViewState = {
  layoutView: LayoutView;
  tabContent: Record<string, TabContent>;
  layoutSplitMarks: LayoutSplitMarks;
};

/** State augmented with its composed layout — what layout reducers see so their
 * `state.rootPanel` / `state.tabGroups` / … reads keep working unchanged (#2562). */
export type LayoutAwareState = AppState & ComposedLayoutState;

/** A layout reducer's result: ordinary `appStore` fields plus the (virtual) layout
 * keys it computes so {@link postLayoutSnapshot} can derive the dispatched view. */
export type LayoutReducerResult = Partial<AppState> & Partial<ComposedLayoutState>;

const EMPTY_COMPOSED: ComposedLayoutState = {
  rootPanel: createLeafPanel(),
  activePanelId: null,
  tabGroups: [],
  activeTabGroupId: "",
};

const composedLayoutCache = new WeakMap<
  LayoutView,
  { tabContent: Record<string, TabContent>; marks: LayoutSplitMarks; result: ComposedLayoutState }
>();
/** Last successful composition — reused **only** when the view has nothing to
 * derive a tree from (absent, or no groups). A view that references tabs absent
 * from `tabContent` is reconciled instead (SM-024): the dangling tabs are dropped
 * and the tree is derived from the view, never frozen on this stale copy. */
let lastComposedLayout: ComposedLayoutState = EMPTY_COMPOSED;

/** The composed rich layout for `state`, memoized on the identities of
 * `layoutView` / `tabContent` / `layoutSplitMarks` (#2562). Stable ref across
 * unrelated store changes — the render-storm guard the reducer-removal design
 * requires. Every layout read (reducers, selectors, snapshots) flows through here.
 *
 * A view tab absent from `tabContent` (a view/content desync) is dropped from the
 * composed tree rather than failing the compose (SM-024, #3336): the result is
 * always derived from the current inputs, and a tab whose content catches up
 * reappears on the next read (the cache is keyed on `tabContent` identity). */
export function getComposedLayout(state: LayoutViewState): ComposedLayoutState {
  const { layoutView, tabContent, layoutSplitMarks } = state;
  const cached = composedLayoutCache.get(layoutView);
  if (cached && cached.tabContent === tabContent && cached.marks === layoutSplitMarks) {
    return cached.result;
  }
  const composed = reconcileLayoutFromView(layoutView, tabContent, layoutSplitMarks)?.composed;
  const result = composed ?? lastComposedLayout;
  if (composed) lastComposedLayout = composed;
  composedLayoutCache.set(layoutView, {
    tabContent,
    marks: layoutSplitMarks,
    result,
  });
  return result;
}

/** Augment `state` with its composed layout so layout reducers read `state.rootPanel`
 * etc. unchanged (#2562). Shallow — the composed fields override the (absent) raw ones. */
export function withComposedLayout(state: AppState): LayoutAwareState {
  return { ...state, ...getComposedLayout(state) };
}

/**
 * The rich multi-group {@link LayoutSnapshot} of `appStore`'s current layout —
 * the seed / overlay payload passed to {@link mirrorLayoutIntent} (#2283 slice
 * D'). Composed from the raw region view (#2562).
 */
export function currentLayoutSnapshot(state: AppState): LayoutSnapshot {
  const c = getComposedLayout(state);
  return buildLayoutSnapshot(c.tabGroups, c.activeTabGroupId, c.rootPanel, c.activePanelId);
}

/**
 * The (virtual) layout keys a structural op's reducer computes so the `post`
 * snapshot can be dispatched. They are no longer real `appStore` fields (#2562) —
 * {@link nonLayoutPartial} strips them from the reducer result before `set`.
 */
const MIRROR_LAYOUT_KEYS = new Set<keyof ComposedLayoutState>([
  "rootPanel",
  "activePanelId",
  "tabGroups",
  "activeTabGroupId",
]);

/** A plain object record (a by-id map such as `tabContent`), not an array. */
function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    Object.getPrototypeOf(v) === Object.prototype
  );
}

/**
 * The value one coupled field should take when a rejected optimistic layout apply
 * is rolled back (SM-027, #3256): `before` is its pre-apply value, `written` what
 * the apply wrote, `current` what the store holds now. A field a newer write has
 * since superseded is left alone. A by-id map is reverted per entry, so only the
 * entries the apply changed — and that still hold its value — go back; entries a
 * concurrent write added or changed survive. Returns `current` when nothing reverts.
 */
export function revertCoupledField(before: unknown, written: unknown, current: unknown): unknown {
  if (current === written) return before;
  if (!isPlainRecord(before) || !isPlainRecord(written) || !isPlainRecord(current)) {
    return current;
  }
  let out: Record<string, unknown> | null = null;
  const entryKeys = new Set([...Object.keys(before), ...Object.keys(written)]);
  for (const k of entryKeys) {
    if (before[k] === written[k]) continue; // not touched by this apply
    if (current[k] !== written[k]) continue; // superseded by a newer write
    out ??= { ...current };
    if (k in before) out[k] = before[k];
    else delete out[k];
  }
  return out ?? current;
}

/** The **non-layout** portion of a reducer result — everything that is a real
 * `appStore` field (e.g. `zoomedTabId`, `tabContent`, the per-tab maps). The
 * virtual layout keys are dropped; the layout is dispatched to the region and
 * composed back on read. */
export function nonLayoutPartial(next: LayoutReducerResult): Partial<AppState> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(next)) {
    if (!MIRROR_LAYOUT_KEYS.has(key as keyof ComposedLayoutState)) {
      out[key] = (next as Record<string, unknown>)[key];
    }
  }
  return out as Partial<AppState>;
}

/** The `post` layout snapshot a reducer result implies, merged over the prior
 * (composed) state — the overlay the region composes back (#2283 slice E2). */
export function postLayoutSnapshot(prev: AppState, next: LayoutReducerResult): LayoutSnapshot {
  const pc = getComposedLayout(prev);
  return buildLayoutSnapshot(
    next.tabGroups ?? pc.tabGroups,
    next.activeTabGroupId ?? pc.activeTabGroupId,
    next.rootPanel ?? pc.rootPanel,
    "activePanelId" in next ? (next.activePanelId ?? null) : pc.activePanelId
  );
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
export function buildTransferAwareHandoff(tab: TerminalTab): {
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
export function removeTransferSessionsFromWindow(
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
type OwnershipView = LayoutViewState & {
  sessionOwners: Record<string, string>;
  windowLabel: string;
};

/**
 * Whether this window renders `sessionId` locally (#1964): a live tab in any of
 * this window's tab groups is bound to it. This is authoritative for *this*
 * window regardless of how fresh {@link AppState.sessionOwners} is, so the owning
 * window never suppresses (nor prunes) a row for a session it is actually showing.
 */
function windowRendersSession(state: LayoutViewState, sessionId: string): boolean {
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
export function windowOwnsTransferSession(state: OwnershipView, sessionId: string): boolean {
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
export function pruneForeignTransfers(
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
export function removeTabFromLeaf(leaf: LeafPanel, tabId: string): LeafPanel {
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
export function setSplitSizesInTree(root: PanelNode, splitId: string, sizes: number[]): PanelNode {
  if (root.type === "leaf") return root;
  const children = root.children.map((c) => setSplitSizesInTree(c, splitId, sizes));
  if (root.id === splitId) {
    return { ...root, children, sizes: normalizeSizes(sizes) };
  }
  return { ...root, children };
}

let groupCounter = 0;

/** Generate a unique tab group ID. */
export function generateGroupId(): string {
  groupCounter++;
  return `group-${Date.now()}-${groupCounter}-${Math.random().toString(36).slice(2, 6)}`;
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

/**
 * Keep `activeWorkspaceName` in step with the backend's active workspace (#3517):
 * the `active-workspace-changed` broadcast (from any window) clears it when the
 * active workspace is deleted, follows a rename, and sets it when a workspace is
 * re-activated from the last session. Exported for tests, which may reset the
 * active-workspace listeners.
 */
export function syncActiveWorkspaceName(): () => void {
  return subscribeActiveWorkspace(() => {
    const name = getActiveWorkspace()?.name ?? null;
    if (useAppStore.getState().activeWorkspaceName !== name) {
      useAppStore.setState({ activeWorkspaceName: name });
    }
  });
}
syncActiveWorkspaceName();

// Track last-focused leaf in split containers for directional navigation (#448).
// When the (composed) active panel changes, mark all ancestor SplitContainers so
// that navigating back into a subtree restores the last-focused panel. The marks
// live in the dedicated `layoutSplitMarks` field (#2562) — relocated out of the
// layout tree so the compose stays region-derived and the mark is never one-op
// stale: it is written here synchronously and read back by `getComposedLayout`.
useAppStore.subscribe((state, prev) => {
  const composed = getComposedLayout(state);
  const prevComposed = getComposedLayout(prev);
  if (composed.activePanelId && composed.activePanelId !== prevComposed.activePanelId) {
    const marked = markActiveLeaf(composed.rootPanel, composed.activePanelId);
    if (marked !== composed.rootPanel) {
      const groupId = composed.activeTabGroupId;
      const groupMarks = splitMarksOfTree(marked);
      useAppStore.setState({
        layoutSplitMarks: { ...state.layoutSplitMarks, [groupId]: groupMarks },
      });
    }
  }
});

// Region→appStore layout mirror (#2283 slice E2 / #2562). `appStore` no longer
// stores the rich layout fields; it stores only the raw `layout@<clientId>` view
// in `layoutView`, and composes the rich tree on demand (`getComposedLayout`).
// Every structural op dispatches its region intent (an optimistic overlay that
// emits synchronously) and the non-intent writers reseed the region; this handler
// copies the resulting view into `layoutView`, from which every read composes.
//
// Reconcile, never freeze (SM-024, #3336). An absent/empty view has nothing to
// derive a tree from and is ignored (logged). A view referencing tabs absent from
// `tabContent` is still **applied** — `getComposedLayout` drops the dangling tabs
// when it composes — so `appStore` always follows the authoritative structure
// instead of silently skipping the update and freezing on a stale tree. Such a
// desync is usually transient (e.g. a rejected intent's overlay rollback emits
// before its coupled `tabContent` rollback runs, #3256): once content catches up
// the tab reappears on the next compose. If it still dangles after the current
// turn settles, {@link reconcileDanglingLayout} reseeds the region to the
// reconciled tree so the region converges too, and logs the dropped tab ids.
subscribeLayoutRegion((view) => {
  if (!view) return;
  const state = useAppStore.getState();
  if (view === state.layoutView) return;
  const reconciled = reconcileLayoutFromView(view, state.tabContent, state.layoutSplitMarks);
  if (!reconciled) {
    frontendLog("layout_bridge", "region view has no groups; kept last-good layout");
    return;
  }
  useAppStore.setState({ layoutView: view });
  if (reconciled.droppedTabIds.length > 0) scheduleDanglingLayoutReconcile();
  else lastDanglingReconcileKey = null; // a clean view re-arms the reconcile
});

/** Structural key of the last region view {@link reconcileDanglingLayout} reseeded
 * over — a loop guard so a reseed the backend rejects (whose rollback re-emits the
 * same dangling view) is not retried forever. Cleared whenever a clean view lands. */
let lastDanglingReconcileKey: string | null = null;
let danglingReconcileScheduled = false;

/** Defer {@link reconcileDanglingLayout} past the current turn (a macrotask, so
 * every microtask-chained coupled rollback has run first). Coalesced. */
function scheduleDanglingLayoutReconcile(): void {
  if (danglingReconcileScheduled) return;
  danglingReconcileScheduled = true;
  setTimeout(() => {
    danglingReconcileScheduled = false;
    reconcileDanglingLayout();
  }, 0);
}

/**
 * Converge the region when `appStore`'s applied view still references tabs this
 * client has no content for once the turn has settled (SM-024): the rendered tree
 * already omits them (see {@link getComposedLayout}); reseed the region to that
 * reconciled tree so the authoritative layout drops the unrenderable refs too, and
 * log the dropped ids so the recovery is visible in the LogViewer. A no-op when
 * content caught up in the meantime (a transient desync).
 */
function reconcileDanglingLayout(): void {
  const state = useAppStore.getState();
  const reconciled = reconcileLayoutFromView(
    state.layoutView,
    state.tabContent,
    state.layoutSplitMarks
  );
  if (!reconciled || reconciled.droppedTabIds.length === 0) {
    lastDanglingReconcileKey = null;
    return;
  }
  const key = JSON.stringify(state.layoutView);
  const ids = reconciled.droppedTabIds.join(", ");
  if (key === lastDanglingReconcileKey) {
    frontendLog("layout_bridge", `region still references tabs without content: ${ids}`);
    return;
  }
  frontendLog("layout_bridge", `reconciled layout: dropped tabs without content: ${ids}`);
  // The reseed's optimistic overlay emits the clean view synchronously (which
  // re-arms the guard), so record the key only after it: a rejection's rollback
  // re-emits this same dangling view and must not trigger another reseed.
  reseedLayoutRegion(currentLayoutSnapshot(state));
  lastDanglingReconcileKey = key;
}

// Seed the region from `appStore`'s initial layout at startup so the region's
// view matches `layoutView` before the first authoritative diff (rather than a
// backend-default snapshot clobbering it). Optimistic, so it lands synchronously.
reseedLayoutRegion(currentLayoutSnapshot(useAppStore.getState()));

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

// Wire the reconnect observer (#2205 PR-B) once at module init so the backend
// redrive is the sole reconnect authority: a drop folded into the
// `session-lifecycle` region drives the owning tab's re-attach even before any
// overlay/hook has subscribed. Idempotent and best-effort (a subscribe failure in
// a non-Tauri env is logged, never thrown).
wireSessionReconnectObserver();

/**
 * Get the active tab from the current store state.
 */
export function getActiveTab(state: AppState): TerminalTab | null {
  const { activePanelId, rootPanel } = getComposedLayout(state);
  if (!activePanelId) return null;
  const leaf = findLeaf(rootPanel, activePanelId);
  if (!leaf || !leaf.activeTabId) return null;
  return leaf.tabs.find((t) => t.id === leaf.activeTabId) ?? null;
}
