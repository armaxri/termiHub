/**
 * The root store's startup subscriptions (ARCH-001/FES-011, #2881): the
 * active-workspace name sync, the split-mark tracker, the region→store layout
 * mirror with its dangling-layout reconcile, the initial region seed, the
 * projected restore-summary renderer, and the reconnect observer. Moved verbatim
 * out of `appStore.ts`, which calls {@link installStoreSubscriptions} once right
 * after creating (and binding) the store; the order of the steps is behavior.
 */

import { getActiveWorkspace, subscribeActiveWorkspace } from "@/services/workspaceSettings";
import { frontendLog } from "@/utils/frontendLog";
import { markActiveLeaf } from "@/utils/panelTree";
import {
  reconcileLayoutFromView,
  reseedLayoutRegion,
  splitMarksOfTree,
  subscribeLayoutRegion,
} from "@/store/layoutBridge";
import {
  ensureSessionSubscribed,
  logSessionBridgeFallback,
  onSessionView,
} from "@/store/sessionBridge";
import {
  setRestoreSettlementRenderer,
  type ProjectedSettlement,
} from "@/store/restoreCohortBridge";
import { useAppStore } from "./appStoreHandle";
import { collectLiveTabs, currentLayoutSnapshot, getComposedLayout } from "./layoutHelpers";
import { raiseRestoreSummary } from "./restoreHelpers";

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

// Track last-focused leaf in split containers for directional navigation (#448).
// When the (composed) active panel changes, mark all ancestor SplitContainers so
// that navigating back into a subtree restores the last-focused panel. The marks
// live in the dedicated `layoutSplitMarks` field (#2562) — relocated out of the
// layout tree so the compose stays region-derived and the mark is never one-op
// stale: it is written here synchronously and read back by `getComposedLayout`.
function trackSplitMarks(): void {
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
}

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
function mirrorLayoutRegion(): void {
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
}

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
function seedLayoutRegion(): void {
  reseedLayoutRegion(currentLayoutSnapshot(useAppStore.getState()));
}

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

/**
 * Install the startup subscriptions, in the order the monolithic root store ran
 * them at module init. Called once by `appStore.ts` after the store is created
 * and bound to {@link import("./appStoreHandle").useAppStore}.
 */
export function installStoreSubscriptions(): void {
  syncActiveWorkspaceName();
  trackSplitMarks();
  mirrorLayoutRegion();
  seedLayoutRegion();
  // Wire the projected-settlement render surface to the store once at module init.
  setRestoreSettlementRenderer(renderProjectedRestoreSummary);

  // Wire the reconnect observer (#2205 PR-B) once at module init so the backend
  // redrive is the sole reconnect authority: a drop folded into the
  // `session-lifecycle` region drives the owning tab's re-attach even before any
  // overlay/hook has subscribed. Idempotent and best-effort (a subscribe failure in
  // a non-Tauri env is logged, never thrown).
  wireSessionReconnectObserver();
}
