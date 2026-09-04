/**
 * `layoutSelectors` — the single region-derived read surface for the layout
 * structure that `appStore` currently mirrors into its `rootPanel` / `tabGroups`
 * / `activePanelId` / `activeTabGroupId` fields (composed from the
 * `layout@<clientId>` projection by the region→appStore mirror; see
 * {@link import("./layoutBridge").composeLayoutState}).
 *
 * Every component / hook / util that used to read those four fields directly now
 * goes through the accessors here (part of #2562). Today each accessor is a thin
 * read of the mirror field, so behaviour is byte-identical; funnelling the reads
 * into one module is what lets the fields themselves be deleted in a follow-up
 * (the accessors get re-implemented to compose straight from the region view +
 * `tabContent`, and the fields — plus the mirror subscription — go away) without
 * touching ~20 call sites again.
 *
 * The reducer working-tree reads inside `appStore` (which mutate a rich tree to
 * derive `layout.*` intents) are intentionally NOT funnelled here — those are the
 * separate, live-graded "reducer removal" half of #2562.
 */

import { getComposedLayout, useAppStore, type AppState } from "@/store/appStore";
import { useLayoutRenderTree } from "@/store/useLayoutRenderTree";
import type { PanelNode, TabGroup, TerminalTab } from "@/types/terminal";
import { getAllLeaves } from "@/utils/panelTree";

/** The minimal slice of `appStore` state these selectors read: the raw region
 * view + the by-id content + the relocated split marks (#2562). The rich layout
 * is composed from it via {@link getComposedLayout}. Kept explicit so the
 * state-in helpers can be called against `useAppStore.getState()` (effects /
 * handlers) and inside reactive `useAppStore((s) => …)` selectors alike. */
export type LayoutStateSlice = Pick<
  AppState,
  "layoutView" | "tabContent" | "layoutSplitMarks"
>;

// Re-export so callers have a single import surface for the layout render tree.
export { useLayoutRenderTree };

// ── Reactive hooks (component render reads) ────────────────────────────────────
//
// Each selector reads the memoized composition (`getComposedLayout`), whose result
// is a stable reference while the underlying `layoutView` / `tabContent` /
// `layoutSplitMarks` are unchanged — so an unrelated store change never re-renders
// these consumers.

/** The active tab group's tab groups list (region-derived). */
export function useLayoutTabGroups(): TabGroup[] {
  return useAppStore((s) => getComposedLayout(s).tabGroups);
}

/** The id of the active tab group (region-derived). */
export function useActiveTabGroupId(): string {
  return useAppStore((s) => getComposedLayout(s).activeTabGroupId);
}

/** The id of the focused panel in the active group, or null (region-derived). */
export function useActivePanelId(): string | null {
  return useAppStore((s) => getComposedLayout(s).activePanelId);
}

// ── Non-reactive accessors (getState reads in effects / handlers / services) ──

/** The active group's render tree, read once (non-reactive). */
export function getLayoutRenderTree(): PanelNode {
  return getComposedLayout(useAppStore.getState()).rootPanel;
}

/** The tab groups list, read once (non-reactive). */
export function getLayoutTabGroups(): TabGroup[] {
  return getComposedLayout(useAppStore.getState()).tabGroups;
}

/** The active tab group id, read once (non-reactive). */
export function getActiveTabGroupId(): string {
  return getComposedLayout(useAppStore.getState()).activeTabGroupId;
}

/** The focused panel id, read once (non-reactive). */
export function getActivePanelId(): string | null {
  return getComposedLayout(useAppStore.getState()).activePanelId;
}

// ── Derived helpers (funnel the recurring group-tree / all-tabs idioms) ────────

/**
 * The render tree for `group`: the active group is served the live `activeTree`
 * (always up to date), every other group its own `rootPanel`. Pure — pass the
 * current active tree + active group id. (Post-#2562 the composed active group's
 * entry already equals `activeTree`, so this is an identity for it, but the shape
 * is kept for callers that pass a group list + a separately-held active tree.)
 */
export function groupRenderTree(
  group: TabGroup,
  activeTree: PanelNode,
  activeGroupId: string
): PanelNode {
  return group.id === activeGroupId ? activeTree : group.rootPanel;
}

/** {@link groupRenderTree} over every group of a state slice (state-in). */
export function groupRenderTreesOf(s: LayoutStateSlice): PanelNode[] {
  const c = getComposedLayout(s);
  return c.tabGroups.map((g) => groupRenderTree(g, c.rootPanel, c.activeTabGroupId));
}

/** The tabs of the active group's render tree (state-in — usable inside a
 * reactive `useAppStore((s) => …)` selector). */
export function activeTreeTabs(s: LayoutStateSlice): TerminalTab[] {
  return getAllLeaves(getComposedLayout(s).rootPanel).flatMap((l) => l.tabs);
}

/**
 * Every tab reachable across **every** group's composed tree. The title-resolution
 * `.find()` sites use this union so they match a tab mid-transition. Non-reactive.
 */
export function getAllTabsAcrossGroupTrees(): TerminalTab[] {
  const c = getComposedLayout(useAppStore.getState());
  return c.tabGroups.flatMap((g) => getAllLeaves(g.rootPanel).flatMap((l) => l.tabs));
}
