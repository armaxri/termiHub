import { StateCreator } from "zustand";

import type { AppState } from "../appStore";
import {
  buildTransferAwareHandoff,
  canCarryEditorBuffer,
  currentWindowLabel,
  pruneForeignTransfers,
} from "../windowHelpers";
import { collectWindowTabs, getComposedLayout, withComposedLayout } from "../layoutHelpers";
import { dirtyEditorTabs } from "@/utils/tabLiveSession";
import { LAST_SESSION_SAVE_DEBOUNCE_MS } from "../restoreHelpers";
import {
  closeTerminal as apiCloseTerminal,
  detachPersistentTab as apiDetachPersistentTab,
  openWindow,
  sendHandoffToWindow,
  claimSession,
  listSessionOwners,
  takePendingHandoffs,
  reportWindowLayout,
} from "@/services/api";
import type {
  MoveWindowTarget,
  TabHandoffRecord,
  WindowInfo,
  WindowCloseDirtyEditor,
  WindowCloseRequest,
} from "@/types/window";
import type { TerminalTab } from "@/types/terminal";
import { classifyWindowCloseSessions, windowCloseWouldLoseData } from "@/utils/windowClose";
import { resolveWindowEviction } from "@/utils/tabOwnership";
import { captureAllTabGroups } from "@/utils/workspaceLayout";
import { currentConnectionsView } from "@/store/connectionsBridge";
import { toast } from "@/components/ui";
import { errorMessage } from "@/utils/errorMessage";
import { frontendError, frontendLog } from "@/utils/frontendLog";

/** Debounce timer for reporting a secondary window's layout slice (#1925). */
let windowLayoutReportTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Window-management slice (ARCH-001/FES-011, appStore god-module split via #2881):
 * the multi-window session-ownership mirror (#1900 / #1964 / #3368), draining
 * queued tab hand-offs, reporting this window's layout to the aggregation
 * authority (#1925), opening a new window (#1902), and the close-with-live-tabs
 * classification and outcomes (#1903).
 *
 * Extracted verbatim from the monolithic root store as a behavior-preserving
 * Zustand slice. The only textual change is that the root-local `curLayout()`
 * closure is spelled out as its definition, `getComposedLayout(get())`.
 * Cross-domain calls (`hydrateHandoffTab`, `endWindowSessions`,
 * `clearMovingSession`, `refreshSessionOwners`) go through `get()`, so call order
 * is unchanged. The three actions that rewrite the tab trees (`moveTabToWindow`,
 * `hydrateHandoffTab` and `receivePendingWindowRestore`) live in TabGroupsSlice:
 * they commit through the `setAndReseed` layout reseed (#2562), which belongs to
 * the core tabs/layout domain.
 */
export interface WindowManagementSlice {
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
  /**
   * Whether *this* window is evicted from `sessionId` (#3368): another window
   * has taken the session over, so this window must send it no input or resize
   * until the user explicitly reclaims it. Resolved from {@link sessionOwners}
   * via `resolveWindowEviction` (unclaimed / owned here / mid-move → `false`).
   */
  isSessionWindowEvicted: (sessionId: string | null | undefined) => boolean;
  /**
   * Explicit **Reclaim** of a session another window took over (#3368): claim it
   * for this window (the backend supersedes the other window atomically and that
   * window folds to its Evicted overlay in turn), then refresh the ownership
   * mirror so this window leaves the evicted state immediately. Never called
   * automatically — only from the overlay's Reclaim button — so control cannot
   * ping-pong between windows. Resolves `true` on success.
   */
  reclaimWindowSession: (sessionId: string) => Promise<boolean>;
  /** Whether a session is mid-move (read by the source Terminal's unmount cleanup). */
  isSessionMoving: (sessionId: string) => boolean;
  /** Clear a session's moving flag once the source has released its view. */
  clearMovingSession: (sessionId: string) => void;
  /** Drain and hydrate any hand-off records queued for this window. */
  receivePendingHandoffs: () => Promise<void>;
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
   * - `"prompt"` — at least one non-persistent session would be terminated, or
   *   an editor tab holds unsaved changes (UX2-003), so the decision dialog is
   *   raised ({@link pendingWindowClose}); the caller
   *   must NOT destroy the window — the dialog resolves it.
   */
  prepareWindowClose: (otherWindows: WindowInfo[]) => Promise<"proceed" | "prompt">;
  /**
   * Assess this window when the app is asked to quit (#4296), using the same
   * classification as {@link prepareWindowClose}:
   *
   * - `"ready"` — nothing would be lost (no live session, or only persistent /
   *   agent ones, which keep running), so this window agrees to the quit.
   * - `"prompt"` — a non-persistent session or an unsaved editor would be lost,
   *   so the decision dialog is raised in quit mode ({@link pendingWindowClose}).
   *
   * Unlike a window close, nothing is detached or ended here: another window
   * may still cancel the quit, and the app exit itself ends the sessions.
   */
  prepareAppQuit: () => "ready" | "prompt";
  /**
   * Destructive close outcome (#1903): detach every persistent/agent session
   * and terminate every non-persistent one owned by this window.
   */
  endWindowSessions: () => Promise<void>;
  /**
   * Safe close outcome (#1903): re-parent every owned live session tab into
   * another window so nothing is lost, reusing the #1900 hand-off seam. Dirty
   * file editors move too, carrying their unsaved buffer (#4412). Rejects,
   * moving nothing, while a dirty editor cannot carry its unsaved state.
   */
  moveWindowSessionsToWindow: (target: MoveWindowTarget) => Promise<void>;
}

/**
 * The window-close dialog rows for this window's unsaved editors (UX2-003),
 * each flagged with whether "Move tabs" can carry its buffer (#4412).
 */
function dirtyEditorRows(
  tabs: TerminalTab[],
  editorDirty: Readonly<Record<string, boolean>>
): WindowCloseDirtyEditor[] {
  return dirtyEditorTabs(tabs, editorDirty).map((tab) => ({
    tabId: tab.id,
    title: tab.title,
    movable: canCarryEditorBuffer(tab),
  }));
}

export const createWindowManagementSlice: StateCreator<AppState, [], [], WindowManagementSlice> = (
  set,
  get
) => ({
  // ── Multi-window foundation (#1900) ──
  movingSessionIds: [],
  releasedTransferSessions: [],
  windowLabel: currentWindowLabel(),
  sessionOwners: {},
  setSessionOwners: (owners) =>
    set((state) => ({
      sessionOwners: owners,
      ...pruneForeignTransfers(withComposedLayout(state), owners),
    })),
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
  isSessionWindowEvicted: (sessionId) => {
    const state = get();
    return (
      resolveWindowEviction({
        sessionId,
        sessionOwners: state.sessionOwners,
        windowLabel: state.windowLabel,
        moving: !!sessionId && state.movingSessionIds.includes(sessionId),
      }) !== null
    );
  },
  reclaimWindowSession: async (sessionId) => {
    try {
      await claimSession(sessionId);
    } catch (err) {
      frontendLog("multi_window", `Failed to reclaim session ${sessionId}: ${errorMessage(err)}`);
      toast.error(`Could not reclaim the session: ${errorMessage(err)}`);
      return false;
    }
    // Leave the evicted state at once rather than waiting for the
    // `session-ownership-changed` round-trip, then converge on the backend map.
    set((state) => ({
      sessionOwners: { ...state.sessionOwners, [sessionId]: state.windowLabel },
    }));
    await get().refreshSessionOwners();
    return true;
  },
  clearMovingSession: (sessionId) =>
    set((state) => ({
      movingSessionIds: state.movingSessionIds.filter((id) => id !== sessionId),
    })),

  receivePendingHandoffs: async () => {
    let records: TabHandoffRecord[];
    try {
      records = await takePendingHandoffs();
    } catch (err) {
      frontendLog("multi_window", `takePendingHandoffs failed: ${errorMessage(err)}`);
      return;
    }
    for (const record of records) {
      // Claim ownership for this window so the backend `session → window` map
      // points here (single-owner invariant + resize gating).
      if (record.tab.sessionId) {
        try {
          await claimSession(record.tab.sessionId);
        } catch (err) {
          frontendLog("multi_window", `claimSession failed: ${errorMessage(err)}`);
        }
      }
      get().hydrateHandoffTab(record);
    }
  },

  reportOwnWindowLayout: async () => {
    const layout = getComposedLayout(get());
    const tabGroups = captureAllTabGroups(
      layout.tabGroups,
      layout.activeTabGroupId,
      layout.rootPanel,
      currentConnectionsView().connections
    );
    const activeGroupIndex = Math.max(
      0,
      layout.tabGroups.findIndex((g) => g.id === layout.activeTabGroupId)
    );
    try {
      await reportWindowLayout(tabGroups, activeGroupIndex);
    } catch (err) {
      frontendLog("multi_window", `reportWindowLayout failed: ${errorMessage(err)}`);
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
      frontendLog("multi_window", `openNewWindow failed: ${errorMessage(err)}`);
      toast.error("Could not open a new window");
    }
  },

  // ── Close-with-live-tabs decision surface (#1903) ────────────────────
  pendingWindowClose: null,
  setPendingWindowClose: (request) => set({ pendingWindowClose: request }),

  prepareWindowClose: async (otherWindows) => {
    const tabs = collectWindowTabs(get());
    const sessions = classifyWindowCloseSessions(tabs);
    // Unsaved editors carry no session, so the session classification never
    // sees them; a dirty editor alone must still stop the close (UX2-003).
    const dirtyEditors = dirtyEditorRows(tabs, get().editorDirtyTabs);
    if (dirtyEditors.length > 0) {
      set({ pendingWindowClose: { sessions, otherWindows, dirtyEditors } });
      return "prompt";
    }
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

  prepareAppQuit: () => {
    const tabs = collectWindowTabs(get());
    const sessions = classifyWindowCloseSessions(tabs);
    const dirtyEditors = dirtyEditorRows(tabs, get().editorDirtyTabs);
    if (dirtyEditors.length === 0 && !windowCloseWouldLoseData(sessions)) return "ready";
    set({
      pendingWindowClose: {
        sessions,
        otherWindows: [],
        mode: "quit",
        ...(dirtyEditors.length > 0 ? { dirtyEditors } : {}),
      },
    });
    return "prompt";
  },

  endWindowSessions: async () => {
    const tabs = collectWindowTabs(get()).filter((tab) => tab.sessionId);
    await Promise.all(
      tabs.map((tab) => {
        const sessionId = tab.sessionId as string;
        // Bulk window-session teardown: surface a failed detach/close at ERROR
        // (a leaked session), LogViewer-only with no per-item toast (UX-033).
        const teardown = tab.persistentConnectionId
          ? apiDetachPersistentTab(sessionId, tab.id)
          : apiCloseTerminal(sessionId);
        return teardown.catch((err: unknown) => {
          frontendError(
            "workspace",
            `Failed to tear down session ${sessionId} on window close: ${errorMessage(err)}`
          );
        });
      })
    );
  },

  moveWindowSessionsToWindow: async (target) => {
    const windowTabs = collectWindowTabs(get());
    const dirty = dirtyEditorTabs(windowTabs, get().editorDirtyTabs);
    // An editor whose unsaved state cannot travel blocks the whole move: moving
    // the rest and closing the window would discard it silently (#4412).
    const stuck = dirty.filter((tab) => !canCarryEditorBuffer(tab));
    if (stuck.length > 0) {
      throw new Error(
        `Save or discard ${stuck.map((tab) => `"${tab.title}"`).join(", ")} before moving tabs`
      );
    }
    // Session tabs first, so a remote editor's backing session is already in
    // the destination when the editor reloads its file there.
    const tabs = [
      ...windowTabs.filter((tab) => tab.sessionId),
      ...dirty.filter((tab) => !tab.sessionId),
    ];
    if (tabs.length === 0) return;

    // Build a hand-off record per tab before anything else happens. Each
    // record holds its editor buffer by value, so the source window's teardown
    // (#4313) dropping the editor's state cannot reach the moved copy (#4412).
    // The Transfer Queue is region-authoritative and shared (#2229), so no queue
    // rows are carried — the destination window already sees them; this window
    // is being torn down, so no source-side transient-map release is needed.
    const records: TabHandoffRecord[] = tabs.map((tab) => buildTransferAwareHandoff(tab).record);

    // Mark every session as moving up front so a source Terminal unmounting
    // during the window teardown does NOT tear down the backend session — the
    // destination window adopts each still-running session (#1900 seam).
    const sessionIds = tabs.flatMap((tab) => (tab.sessionId ? [tab.sessionId] : []));
    set((state) => ({
      movingSessionIds: Array.from(new Set([...state.movingSessionIds, ...sessionIds])),
    }));
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
      frontendLog("multi_window", `move window sessions failed: ${errorMessage(err)}`);
      throw err;
    }
  },
});
