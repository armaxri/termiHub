import type { StateCreator } from "zustand";

import {
  type AppState,
  getComposedLayout,
  type LayoutAwareState,
  type LayoutReducerResult,
  nonLayoutPartial,
  postLayoutSnapshot,
  revertCoupledField,
  withComposedLayout,
} from "../appStore";
import { type ComposedLayoutState, reseedLayoutRegion } from "@/store/layoutBridge";

/** The layout commit helpers a layout-writing slice closes over (#2562 / #3256). */
export interface LayoutCommit {
  setLayoutLocal: (
    reducer: (state: LayoutAwareState) => LayoutReducerResult
  ) => LayoutReducerResult;
  layoutCoupledRollback: (prev: AppState, next: LayoutReducerResult) => (() => void) | undefined;
  curLayout: () => ComposedLayoutState;
  setAndReseed: (
    partial: LayoutReducerResult | ((state: LayoutAwareState) => LayoutReducerResult)
  ) => void;
}

/**
 * Bind the root store's layout commit helpers to a slice's `set` / `get`
 * (ARCH-001/FES-011, #2881). Extracted verbatim from the monolithic root store,
 * where these were closures in the `create` body; every layout-writing slice
 * calls this once so it commits through the exact same code. The helpers hold no
 * state of their own, so each slice's copy behaves identically.
 */
export function createLayoutCommit(
  set: Parameters<StateCreator<AppState>>[0],
  get: () => AppState
): LayoutCommit {
  /**
   * Run a layout reducer as a region-authoritative op (#2283 slice E2). The
   * reducer computes the transform (and any side effects) exactly as before, but
   * only its **non-layout** fields are written to `appStore` here — the four
   * layout fields are dispatched as `post` and the region→appStore mirror writes
   * them back, so the region is their sole writer. Returns the reducer result so
   * callers can read the computed layout / ids. A no-op reducer (`return state`)
   * writes nothing.
   */
  const setLayoutLocal = (
    reducer: (state: LayoutAwareState) => LayoutReducerResult
  ): LayoutReducerResult => {
    const s0 = withComposedLayout(get());
    const next = reducer(s0);
    if (next !== s0) {
      const rest = nonLayoutPartial(next);
      if (Object.keys(rest).length > 0) set(rest);
    }
    return next;
  };

  /**
   * Build the transactional rollback for the coupled **non-layout** fields an
   * optimistic layout reducer committed via `set(rest)` — in {@link setLayoutLocal}
   * (granular `layout.*` intents) or {@link setAndReseed} (the `layout.replaceGroups`
   * reseed) (SM-027, #3256). The `ProjectionClient` overlay reverts only the
   * panel-tree structure on a rejection; these fields (`tabContent`, `zoomedTabId`,
   * the per-tab maps, `pendingSettings*`) live outside the region and would
   * otherwise stay mutated, diverging the store. Given the pre-apply `prev` state
   * and the reducer `next` result, this returns a closure that restores the keys
   * the reducer wrote to their pre-apply values — passed as `onReject` so a
   * rejection reverts structure and coupled fields together. Returns `undefined`
   * when the reducer wrote no coupled field (nothing to revert).
   *
   * The restore never clobbers a newer write that superseded the optimistic one
   * before the rejection arrived: a scalar key is restored only while it still
   * holds the value this apply wrote, and a by-id map (a plain-object field such as
   * `tabContent`) is reverted **per entry** — only the entries this apply changed
   * and that still hold its value go back, so concurrent entries survive.
   */
  const layoutCoupledRollback = (
    prev: AppState,
    next: LayoutReducerResult
  ): (() => void) | undefined => {
    const rest = nonLayoutPartial(next) as Record<string, unknown>;
    const keys = Object.keys(rest);
    if (keys.length === 0) return undefined;
    const before = prev as unknown as Record<string, unknown>;
    return () => {
      const current = get() as unknown as Record<string, unknown>;
      const revert: Record<string, unknown> = {};
      for (const key of keys) {
        const merged = revertCoupledField(before[key], rest[key], current[key]);
        if (merged !== current[key]) revert[key] = merged;
      }
      if (Object.keys(revert).length > 0) set(revert as Partial<AppState>);
    };
  };

  /** The current composed layout — the choke point for the `get()`-time guards
   * (`curLayout().tabGroups`, `.activePanelId`, …) that read the live structure
   * outside a reducer body (#2562). Memoized, so repeated reads are cheap. */
  const curLayout = (): ComposedLayoutState => getComposedLayout(get());

  /**
   * `set` for a **non-intent** structural writer (#2283 slice E2 / #2562): it
   * computes the target layout (there is no granular `layout.*` intent for it —
   * the singleton tab openers, cross-window handoff, restore, the
   * agent-error→terminal conversion) and reseeds the region to it (the region's
   * optimistic overlay installs the new view, which the mirror composes back into
   * `layoutView`). Its non-layout fields are `set` locally first so the reseed's
   * composition sees them (e.g. a newly-tracked `tabContent` entry).
   */
  const setAndReseed = (
    partial: LayoutReducerResult | ((state: LayoutAwareState) => LayoutReducerResult)
  ): void => {
    const augmented = withComposedLayout(get());
    const next = typeof partial === "function" ? partial(augmented) : partial;
    if (next === augmented) return;
    const prev = get();
    const rest = nonLayoutPartial(next);
    if (Object.keys(rest).length > 0) set(rest);
    // A rejected reseed reverts the coupled fields with the structure (#3256).
    reseedLayoutRegion(postLayoutSnapshot(get(), next), layoutCoupledRollback(prev, next));
  };

  return { setLayoutLocal, layoutCoupledRollback, curLayout, setAndReseed };
}
