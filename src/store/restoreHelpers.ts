/**
 * Restore / launch helpers (ARCH-001/FES-011, #2881): the restore-in-progress
 * guard (#1146), the restore prompt's reachability probe (#1931), session
 * teardown before a restore, the restore cohort and its summary toast. Moved
 * verbatim out of `appStore.ts` (which re-exports them) so slices import them
 * without pulling in the root store.
 */

import type { TabGroup } from "@/types/terminal";
import {
  closeTerminal as apiCloseTerminal,
  detachPersistentTab as apiDetachPersistentTab,
  listSerialPorts,
  releaseSession,
} from "@/services/api";
import { type RestorePrompt } from "@/utils/restoreMode";
import { probeRestoreTargets } from "@/utils/restoreReachability";
import { probeTargetReachable } from "@/services/networkApi";
import { fireAndForget, frontendLog, frontendWarn } from "@/utils/frontendLog";
import { onRestoreCohortSettled } from "./restoreCohortBridge";
import { toast } from "@/components/ui";
import { getAllLeaves } from "@/utils/panelTree";
import type { AppState } from "./appStore";
import { collectWindowTabs, type LayoutViewState } from "./layoutHelpers";
import { bestEffortOwnership } from "./windowHelpers";
import { errorMessage } from "@/utils/errorMessage";

export const LAST_SESSION_SAVE_DEBOUNCE_MS = 500;
/**
 * Safety timeout for the restore-in-progress guard (GAP G5, #1146; #4387).
 * After a restore/launch places its layout, per-tab connects keep mutating the
 * tree until every tab has connected or failed; we hold
 * {@link AppState.restoreInProgress} until then so those transient
 * (still-connecting / agent-error) states are not auto-saved over the good
 * session. The guard lowers on the real signal — the restore cohort settling
 * ({@link onRestoreCohortSettled}) — and this generous timeout only exists so a
 * lost settlement (bridge/transport failure, a tab that never reports) cannot
 * disable auto-save for the rest of the session.
 */
export const RESTORE_GUARD_SAFETY_TIMEOUT_MS = 30_000;
let restoreSafetyTimer: ReturnType<typeof setTimeout> | null = null;
/** The setter of the currently raised guard; `null` while the guard is down. */
let raisedGuardSetState: ((partial: Partial<AppState>) => void) | null = null;
let settledSubscription: (() => void) | null = null;

function lowerRestoreGuard(reason: "settled" | "timeout"): void {
  const setState = raisedGuardSetState;
  if (!setState) return;
  raisedGuardSetState = null;
  if (restoreSafetyTimer) {
    clearTimeout(restoreSafetyTimer);
    restoreSafetyTimer = null;
  }
  setState({ restoreInProgress: false });
  if (reason === "settled") {
    frontendLog("workspace", "restore cohort settled; auto-save re-enabled");
  } else {
    frontendWarn(
      "workspace",
      `restore cohort did not report settled within ${RESTORE_GUARD_SAFETY_TIMEOUT_MS}ms; ` +
        "auto-save re-enabled by safety timeout"
    );
  }
}

/**
 * Raise the restore-in-progress guard (GAP G5, #1146). Call immediately before a
 * restore/launch places its layout (and before it begins its restore cohort) so
 * the auto-save subscription and any in-flight per-tab connects are skipped until
 * the cohort settles. The guard lowers when the most recently begun cohort
 * settles (#4387), or after {@link RESTORE_GUARD_SAFETY_TIMEOUT_MS} at the
 * latest. Safe to call repeatedly — overlapping restores re-arm the timeout and
 * wait for the newest cohort.
 */
export function beginRestoreGuard(setState: (partial: Partial<AppState>) => void): void {
  if (!settledSubscription) {
    settledSubscription = onRestoreCohortSettled(() => lowerRestoreGuard("settled"));
  }
  raisedGuardSetState = setState;
  setState({ restoreInProgress: true });
  if (restoreSafetyTimer) clearTimeout(restoreSafetyTimer);
  restoreSafetyTimer = setTimeout(() => {
    restoreSafetyTimer = null;
    lowerRestoreGuard("timeout");
  }, RESTORE_GUARD_SAFETY_TIMEOUT_MS);
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
    frontendLog("workspace", `restore reachability probe failed: ${errorMessage(err)}`);
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
  // A tab held for confirming an imported inline config (#4434) does not
  // connect until the user confirms it, so it is not waited on.
  const pendingTabIds = tabs
    .filter((t) => t.contentType === "terminal" && !t.pendingImportedConnection)
    .map((t) => t.id);
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
export function raiseRestoreSummary(
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
