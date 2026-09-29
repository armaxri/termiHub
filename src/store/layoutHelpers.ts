/**
 * Layout and tab helpers shared by the root store and its slices
 * (ARCH-001/FES-011, #2881): the region-derived layout composition (#2562), the
 * by-id tab content map, and the pure panel-tree / tab builders. Moved verbatim
 * out of `appStore.ts` (which re-exports them) so slices import them without
 * pulling in the root store.
 */

import type {
  ConnectionConfig,
  LeafPanel,
  PanelNode,
  TabContent,
  TabContentType,
  TabGroup,
  TerminalTab,
} from "@/types/terminal";
import { newId } from "@/services/transport/ids";
import { createLeafPanel, findLeaf, getAllLeaves, normalizeSizes } from "@/utils/panelTree";
import {
  buildLayoutSnapshot,
  type ComposedLayoutState,
  type LayoutSnapshot,
  type LayoutSplitMarks,
  type LayoutView,
  reconcileLayoutFromView,
} from "@/store/layoutBridge";
import type { AppState } from "./appStore";

/** Return a new Record with `key` removed. */
export function omitKey<V>(rec: Record<string, V>, key: string): Record<string, V> {
  const { [key]: _, ...rest } = rec;
  return rest;
}

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
 * Enumerate every live tab across all tab groups (the active group is
 * represented by the live `rootPanel`, the others by their stored trees). Used
 * by the bulk-reconnect control to filter captured failed ids down to tabs that
 * still exist and can actually be re-driven (#1227).
 */
export function collectLiveTabs(state: LayoutViewState): TerminalTab[] {
  const { tabGroups } = getComposedLayout(state);
  return tabGroups.flatMap((g) => getAllLeaves(g.rootPanel).flatMap((leaf) => leaf.tabs));
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
export type LayoutViewState = {
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
 * Get the active tab from the current store state.
 */
export function getActiveTab(state: AppState): TerminalTab | null {
  const { activePanelId, rootPanel } = getComposedLayout(state);
  if (!activePanelId) return null;
  const leaf = findLeaf(rootPanel, activePanelId);
  if (!leaf || !leaf.activeTabId) return null;
  return leaf.tabs.find((t) => t.id === leaf.activeTabId) ?? null;
}
