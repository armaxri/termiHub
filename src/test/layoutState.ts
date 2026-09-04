/**
 * Test helpers for the region-derived layout (#2562).
 *
 * `appStore` no longer stores `rootPanel` / `tabGroups` / `activePanelId` /
 * `activeTabGroupId`; the rich layout is composed on demand from the raw
 * `layoutView` + `tabContent` + `layoutSplitMarks` (see
 * {@link import("@/store/appStore").getComposedLayout}). These helpers let a test
 * seed a layout by its familiar rich shape and read the composed layout back
 * without every test having to construct a region view by hand.
 */

import { getComposedLayout, tabContentFromGroups, useAppStore } from "@/store/appStore";
import {
  buildLayoutSnapshot,
  type ComposedLayoutState,
  extractSplitMarks,
  viewFromSnapshot,
} from "@/store/layoutBridge";
import type { PanelNode, TabContent, TabGroup } from "@/types/terminal";

/**
 * Seed `appStore`'s layout from a rich shape (the pre-#2562 `setState({ rootPanel,
 * … })` form). Builds the region view + directional marks + the by-id
 * `tabContent` the compose sources content from, so the seeded tree renders. Any
 * field omitted keeps its current composed value. Non-layout state is untouched —
 * set it with a separate `useAppStore.setState({ … })`.
 */
export function seedLayoutState(partial: {
  rootPanel?: PanelNode;
  activePanelId?: string | null;
  tabGroups?: TabGroup[];
  activeTabGroupId?: string;
  /** Explicit content overrides (merged over the trees' derived content). Some
   * tests pre-built `tabContent` alongside the old `setState({ rootPanel })`. */
  tabContent?: Record<string, TabContent>;
}): void {
  const cur = getComposedLayout(useAppStore.getState());
  const tabGroups = partial.tabGroups ?? cur.tabGroups;
  const activeTabGroupId = partial.activeTabGroupId ?? cur.activeTabGroupId;
  const rootPanel = partial.rootPanel ?? cur.rootPanel;
  const activePanelId =
    partial.activePanelId !== undefined ? partial.activePanelId : cur.activePanelId;
  const snapshot = buildLayoutSnapshot(tabGroups, activeTabGroupId, rootPanel, activePanelId);
  const tabContent: Record<string, TabContent> = {
    ...useAppStore.getState().tabContent,
    ...tabContentFromGroups(tabGroups, activeTabGroupId, rootPanel),
    ...(partial.tabContent ?? {}),
  };
  useAppStore.setState({
    layoutView: viewFromSnapshot(snapshot),
    layoutSplitMarks: extractSplitMarks(snapshot),
    tabContent,
  });
}

/** The composed rich layout for the current store state (test read helper). */
export function layoutState(): ComposedLayoutState {
  return getComposedLayout(useAppStore.getState());
}
