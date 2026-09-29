/**
 * Multi-window helpers (ARCH-001/FES-011, #2881): window labels, capturing and
 * restoring a windowed layout (#1905 / #1925), advisory session ownership
 * (#1939), and the transfer-aware tab hand-off between windows (#1951 / #1964).
 * Moved verbatim out of `appStore.ts` (which re-exports them) so slices import
 * them without pulling in the root store.
 */

import type { TerminalTab } from "@/types/terminal";
import type { TransferState } from "@/types/connection";
import type { TabHandoffRecord, HandoffTab } from "@/types/window";
import { MAIN_WINDOW_LABEL } from "@/types/window";
import type { WorkspaceTabGroupDef, WorkspaceWindowDef } from "@/types/workspace";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { openWindow, reportWindowLayout, collectWindowLayouts } from "@/services/api";
import { assembleWindowedGroups } from "@/utils/windowPersistence";
import type { CapturedWindowLayout, WindowRestorePlanEntry } from "@/utils/windowPersistence";
import { fireAndForget, frontendLog } from "@/utils/frontendLog";
import type { AppState } from "./appStore";
import { collectLiveTabs, type LayoutViewState } from "./layoutHelpers";

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
