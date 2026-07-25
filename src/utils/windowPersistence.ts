/**
 * Window-dimension persistence helpers (#1905, epic #1899).
 *
 * Workspace save/restore and last-session restore capture `tabGroups[]` with a
 * layout tree but historically had **no window field** — a restored layout had
 * nowhere to record "this group is in window 2". These pure helpers add that
 * dimension on top of the existing capture/restore utilities:
 *
 * - {@link stampWindowId} / {@link buildWindowsMeta} record which window owns
 *   each captured group (the **save** side).
 * - {@link planWindowRestore} partitions saved groups back into per-window
 *   restore entries (the **restore** side).
 *
 * The persisted `windowId` is a **logical grouping key**, not a runtime window
 * label: the primary window uses the {@link MAIN_WINDOW_LABEL} sentinel and its
 * groups omit the field, so a single-window save is byte-identical to the legacy
 * schema and a legacy save (no window dimension) restores entirely into the main
 * window. See `docs/concepts/implemented/multi-window.html` → "Persistence &
 * lifecycle have no window dimension".
 */

import { MAIN_WINDOW_LABEL } from "@/types/window";
import type { WorkspaceTabGroupDef, WorkspaceWindowDef } from "@/types/workspace";

/** One native window's captured layout slice, for assembly on save (#1925). */
export interface CapturedWindowLayout {
  /** Runtime window label (`MAIN_WINDOW_LABEL` for the primary window). */
  windowId: string;
  /** The tab groups captured from that window, in order. */
  tabGroups: WorkspaceTabGroupDef[];
}

/** One native window's slice of a restored layout. */
export interface WindowRestorePlanEntry {
  /** Logical window id (`MAIN_WINDOW_LABEL` for the primary window). */
  windowId: string;
  /** Whether this is the primary window (reused rather than spawned on restore). */
  isMain: boolean;
  /** The tab groups assigned to this window, in their saved order. */
  tabGroups: WorkspaceTabGroupDef[];
}

/** The logical window a group is assigned to, defaulting an absent id to main. */
function groupWindowId(group: WorkspaceTabGroupDef): string {
  return group.windowId ?? MAIN_WINDOW_LABEL;
}

/**
 * Stamp a `windowId` onto each captured group so a multi-window layout records
 * which window owns it.
 *
 * The main window's id is deliberately **omitted** (left `undefined`): this
 * keeps single-window and primary-window saves identical to the legacy schema,
 * and pairs with {@link planWindowRestore} treating an absent id as the main
 * window. Any existing `windowId` is overwritten so re-capturing a group after a
 * cross-window move records its new owner.
 */
export function stampWindowId(
  groups: WorkspaceTabGroupDef[],
  windowId: string
): WorkspaceTabGroupDef[] {
  const isMain = windowId === MAIN_WINDOW_LABEL;
  return groups.map((group) => {
    if (isMain) {
      // Drop any stale windowId so a group moved back to main serializes clean.
      const { windowId: _omit, ...rest } = group;
      return rest;
    }
    return { ...group, windowId };
  });
}

/**
 * The distinct logical window ids across a set of captured groups, in a stable
 * order: the main window first, then every secondary window in first-appearance
 * order. Groups with no `windowId` count as the main window.
 */
export function collectWindowIds(groups: WorkspaceTabGroupDef[]): string[] {
  const ordered: string[] = [];
  let sawMain = false;
  for (const group of groups) {
    const id = groupWindowId(group);
    if (id === MAIN_WINDOW_LABEL) {
      sawMain = true;
      continue;
    }
    if (!ordered.includes(id)) ordered.push(id);
  }
  // Main is listed first whenever any group lives in it (or nothing is secondary).
  if (sawMain || ordered.length === 0) return [MAIN_WINDOW_LABEL, ...ordered];
  return ordered;
}

/**
 * Build the `windows[]` metadata for a captured layout, or `undefined` when the
 * layout is a single main window (the legacy shape — no window dimension is
 * written).
 *
 * `extraWindowIds` records windows that own **no** tab groups (the #1902
 * empty-window state); without it an empty window would vanish because no group
 * carries its id. Empty windows are appended after the windows that do own
 * groups, in the given order.
 */
export function buildWindowsMeta(
  groups: WorkspaceTabGroupDef[],
  extraWindowIds: string[] = []
): WorkspaceWindowDef[] | undefined {
  const ids = collectWindowIds(groups);
  for (const id of extraWindowIds) {
    if (id !== MAIN_WINDOW_LABEL && !ids.includes(id)) ids.push(id);
  }
  // Only main and nothing else → legacy single-window layout; omit the dimension.
  if (ids.length === 1 && ids[0] === MAIN_WINDOW_LABEL) return undefined;
  return ids.map((id) => ({ id }));
}

/**
 * Whether a saved layout carries a window dimension worth acting on (more than
 * the implicit main window).
 */
export function hasWindowDimension(
  groups: WorkspaceTabGroupDef[],
  windows?: WorkspaceWindowDef[]
): boolean {
  if (windows && windows.some((w) => w.id !== MAIN_WINDOW_LABEL)) return true;
  return groups.some((g) => g.windowId != null && g.windowId !== MAIN_WINDOW_LABEL);
}

/**
 * Assemble every open window's captured layout slice into the single windowed
 * document persisted to a workspace / last session (#1925).
 *
 * Each slice's groups are stamped with its window's logical id (the main
 * window's id is omitted, keeping a single-window save byte-identical to the
 * legacy schema), then concatenated in the given order — which the backend
 * authority returns main-window-first. A window that reports **no** groups is
 * still recorded in `windows[]` (an empty secondary window, #1902), so the
 * empty-window state round-trips. When only the main window is present with no
 * secondary windows, `windows` is `undefined` (the legacy shape).
 */
export function assembleWindowedGroups(layouts: CapturedWindowLayout[]): {
  tabGroups: WorkspaceTabGroupDef[];
  windows: WorkspaceWindowDef[] | undefined;
} {
  const stampedGroups: WorkspaceTabGroupDef[] = [];
  const emptyWindowIds: string[] = [];
  for (const layout of layouts) {
    const stamped = stampWindowId(layout.tabGroups, layout.windowId);
    stampedGroups.push(...stamped);
    // A secondary window that owns no groups would otherwise vanish (no group
    // carries its id), so record it as an explicit empty window.
    if (stamped.length === 0 && layout.windowId !== MAIN_WINDOW_LABEL) {
      emptyWindowIds.push(layout.windowId);
    }
  }
  return {
    tabGroups: stampedGroups,
    windows: buildWindowsMeta(stampedGroups, emptyWindowIds),
  };
}

/**
 * Partition saved tab groups into per-window restore entries so the restore
 * lifecycle can recreate the saved windows and re-parent each group into its
 * window.
 *
 * Ordering: the main window is always first; secondary windows follow the
 * explicit `windows[]` order when present, then any window seen only on a group
 * (not in `windows[]`) in first-appearance order. An entry from `windows[]` that
 * owns no groups is preserved as an **empty** window so the #1902 empty-window
 * state round-trips. A layout with no window dimension yields a single main
 * entry holding every group — the legacy/back-compat path.
 */
export function planWindowRestore(
  groups: WorkspaceTabGroupDef[],
  windows?: WorkspaceWindowDef[]
): WindowRestorePlanEntry[] {
  // Group the saved tab groups by their logical window id.
  const byWindow = new Map<string, WorkspaceTabGroupDef[]>();
  for (const group of groups) {
    const id = groupWindowId(group);
    const bucket = byWindow.get(id);
    if (bucket) bucket.push(group);
    else byWindow.set(id, [group]);
  }

  // Establish the window order: main first, then declared windows, then any
  // window that only appears on a group.
  const order: string[] = [MAIN_WINDOW_LABEL];
  const pushUnique = (id: string) => {
    if (!order.includes(id)) order.push(id);
  };
  if (windows) {
    for (const w of windows) pushUnique(w.id);
  }
  for (const id of byWindow.keys()) pushUnique(id);

  return order.map((windowId) => ({
    windowId,
    isMain: windowId === MAIN_WINDOW_LABEL,
    tabGroups: byWindow.get(windowId) ?? [],
  }));
}
