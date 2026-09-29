import { StateCreator } from "zustand";

import { collectLiveTabs, type AppState } from "../appStore";
import { toast } from "@/components/ui";
import {
  currentRestoreCohortView,
  mirrorRestoreBegin,
  mirrorRestoreSettle,
} from "@/store/restoreCohortBridge";
import { frontendLog } from "@/utils/frontendLog";

/**
 * Restore-cohort slice (ARCH-001/FES-011, appStore god-module split via #2881):
 * the aggregate partial-restore feedback (#1146, audit G4) and the bulk retry of
 * failed restore tabs (#1227, M2). The cohort itself is region-authoritative
 * (#2206); these actions are thin dispatchers to that region.
 *
 * Extracted verbatim from the monolithic root store as a behavior-preserving
 * Zustand slice. `reconnectTerminal` is still called through `get()`. The
 * cohort-collecting restore/launch paths that call {@link
 * RestoreCohortSlice.beginRestoreCohort} stay in the root store (they rebuild the
 * tab trees), and `reclaimSession` stays there because the takeover audit
 * (`src/services/takeoverAudit.test.ts`, #3395) pins the reclaim API call to
 * `store/appStore.ts`.
 */
export interface RestoreCohortSlice {
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
}

export const createRestoreCohortSlice: StateCreator<AppState, [], [], RestoreCohortSlice> = (
  _set,
  get
) => ({
  // Aggregate partial-restore feedback (#1146, audit G4) + bulk retry (#1227,
  // M2). Region-authoritative (#2206): the `restore-cohort@<clientId>` store
  // owns the cohort, the captured failed-tab set and the settlement summary; the
  // actions below are thin dispatchers, and the summary toast fires from the
  // projected settlement via the renderer registered at store init (in appStore).
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
    frontendLog("workspace_restore", `bulk reconnect: re-driving ${targets.length} failed tab(s)`);
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
});
