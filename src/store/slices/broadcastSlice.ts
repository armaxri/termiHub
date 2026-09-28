import { StateCreator } from "zustand";

import {
  filterConnectedTerminalTabIds,
  getActiveTab,
  resolveBroadcastTargetTabIds,
  withComposedLayout,
  type AppState,
} from "../appStore";
import type { BroadcastScope } from "@/types/terminal";
import { currentBroadcastView, dispatchBroadcastIntentBestEffort } from "@/store/broadcastBridge";
import { toast } from "@/components/ui";

/**
 * Broadcast-input domain slice (#1955; ARCH-001/FES-011, appStore god-module
 * split via #2881): the start / stop / toggle / target-membership actions that
 * mirror typed input from a source terminal to many. The membership state
 * (`active` / `sourceTabId` / `scope` / `targetTabIds` / `lastScope`) lives in the
 * authoritative `broadcast@<clientId>` projection region (#2206), read via
 * `useProjectedBroadcast` / `currentBroadcastView`; these actions dispatch
 * `broadcast.*` intents and only read the live tab tree — `appStore` holds no
 * broadcast state.
 *
 * Extracted verbatim from the monolithic root store as a behavior-preserving
 * Zustand slice — every action still receives the shared `set`/`get` typed
 * against the full {@link AppState}, so the public store shape and behavior are
 * unchanged. The tab-close / tab-move / tab-open call sites that invoke these
 * actions stay in the root store (tabs/layout domain).
 */
export interface BroadcastSlice {
  /** Enter broadcast mode with the given scope, source tab, and target tabs. */
  startBroadcast: (scope: BroadcastScope, sourceTabId: string, targetTabIds: string[]) => void;
  /** Leave broadcast mode and clear the source/target selection. */
  stopBroadcast: () => void;
  /**
   * Toggle broadcast from the keyboard shortcut (#1958). When broadcast is
   * active it stops; otherwise it starts against the active terminal tab using
   * the remembered last scope — skipping the scope dropdown. A remembered
   * `"custom"` scope cannot be reconstructed without the picker, so the shortcut
   * falls back to `"all"`. Emits a hint toast when no terminal tab is focused
   * (nothing to broadcast from).
   */
  toggleBroadcast: () => void;
  /** Add a tab to the broadcast target set (no-op when inactive). */
  addBroadcastTarget: (tabId: string) => void;
  /** Remove a tab from the broadcast target set. */
  removeBroadcastTarget: (tabId: string) => void;
  /** Whether the given tab is currently a broadcast target. */
  isBroadcastTarget: (tabId: string) => boolean;
  /**
   * The subset of the broadcast target set that are *connected* terminal tabs —
   * the tabs the `onData` fan-out should mirror input to. Disconnected,
   * connecting, and non-terminal tabs are filtered out silently. Returns `[]`
   * when broadcast is inactive. Resolution of each tab id to a live session id
   * is done by the terminal registry at the dispatch seam.
   */
  getBroadcastTargetTabIds: () => string[];
  /**
   * Recompute the broadcast target set for the active scope so membership tracks
   * tabs opening during an active broadcast (#1956). No-op when inactive.
   *
   * - `"all"` / `"panel"` — re-derive members from the scope, so a terminal
   *   opened in range is auto-added and one no longer in range drops out.
   * - `"custom"` — never auto-adds; the explicit selection is authoritative
   *   (closed tabs are pruned at the tab-close seam). No-op here.
   *
   * Closing a target is handled at the tab-close seam for every scope, so this
   * only needs to run on tab open.
   */
  refreshBroadcastMembership: () => void;
}

export const createBroadcastSlice: StateCreator<AppState, [], [], BroadcastSlice> = (
  _set,
  get
) => ({
  // Broadcast has no server data source, so the dispatched intents are the only
  // path that mutates the machine.

  startBroadcast: (scope, sourceTabId, targetTabIds) => {
    // The store reproduces `{source} ∪ targets` from the same args, so pass the
    // raw resolved targets (not a source-prefixed set).
    dispatchBroadcastIntentBestEffort("broadcast.start", { scope, sourceTabId, targetTabIds });
  },

  stopBroadcast: () => {
    // The store retains scope/lastScope across the stop for the keyboard toggle.
    dispatchBroadcastIntentBestEffort("broadcast.stop", {});
  },

  toggleBroadcast: () => {
    // Second press (or any press while active) turns broadcast off, regardless
    // of which tab is focused — mirrors the toolbar toggle and the status-bar
    // Stop pill.
    if (currentBroadcastView().active) {
      get().stopBroadcast();
      return;
    }
    const state = get();
    const source = getActiveTab(state);
    if (!source || source.contentType !== "terminal") {
      toast.info("Focus a terminal to start broadcasting input");
      return;
    }
    // Reuse the last scope, skipping the dropdown. A remembered "custom"
    // selection lives only in the picker and cannot be rebuilt here, so it
    // degrades to "all terminals" (#1958).
    const lastScope = currentBroadcastView().lastScope;
    const scope: BroadcastScope = lastScope === "custom" ? "all" : lastScope;
    const targets = resolveBroadcastTargetTabIds(withComposedLayout(state), scope, source.id);
    get().startBroadcast(scope, source.id, targets);
  },

  addBroadcastTarget: (tabId) => {
    // Read-then-dispatch so the intent fires only on a real change (a no-op add
    // must not dispatch a redundant intent), matching the store's pure set-insert.
    if (currentBroadcastView().targetTabIds.includes(tabId)) return;
    dispatchBroadcastIntentBestEffort("broadcast.addTarget", { tabId });
  },

  removeBroadcastTarget: (tabId) => {
    if (!currentBroadcastView().targetTabIds.includes(tabId)) return;
    dispatchBroadcastIntentBestEffort("broadcast.removeTarget", { tabId });
  },

  isBroadcastTarget: (tabId) => currentBroadcastView().targetTabIds.includes(tabId),

  getBroadcastTargetTabIds: () => {
    const view = currentBroadcastView();
    if (!view.active) return [];
    return filterConnectedTerminalTabIds(get(), view.targetTabIds);
  },

  refreshBroadcastMembership: () => {
    const view = currentBroadcastView();
    if (!view.active) return;
    const source = view.sourceTabId;
    if (!source) return;
    // Custom selection is frozen at pick time — never auto-add. Removal of
    // closed targets is handled at the tab-close seam.
    if (view.scope === "custom") return;
    const state = withComposedLayout(get());
    const resolved = resolveBroadcastTargetTabIds(state, view.scope, source);
    const next = new Set<string>([source, ...resolved]);
    const prev = new Set(view.targetTabIds);
    // Skip the work (and its intents) when membership is unchanged.
    if (next.size === prev.size && [...next].every((id) => prev.has(id))) return;
    // The store owns no bulk-set intent, so reconcile the region to the
    // recomputed membership via granular add/remove intents for the delta
    // (mirroring the connected-terminal refresh at the fan-out seam).
    for (const id of next) {
      if (!prev.has(id)) dispatchBroadcastIntentBestEffort("broadcast.addTarget", { tabId: id });
    }
    for (const id of prev) {
      if (!next.has(id)) dispatchBroadcastIntentBestEffort("broadcast.removeTarget", { tabId: id });
    }
  },
});
