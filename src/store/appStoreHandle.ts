/**
 * The root store as seen by the helper modules (ARCH-001/FES-011, #2881).
 *
 * A few helpers read the live store (e.g. {@link import("./reconnectHelpers").isResilientReconnectTabId}),
 * but they are imported by the slices that `appStore.ts` composes, so they must
 * not import `appStore.ts` at runtime — that is the slice ↔ root-store cycle.
 * `appStore.ts` binds its store here right after `create`, and this live binding
 * gives the helpers the same `useAppStore` object without the import cycle.
 */

import type { StoreApi, UseBoundStore } from "zustand";
import type { AppState } from "./appStore";

/** The root store, bound by `appStore.ts` at module init (see {@link bindAppStore}). */
export let useAppStore: UseBoundStore<StoreApi<AppState>>;

/** Bind the root store for the helper modules. Called once by `appStore.ts`. */
export function bindAppStore(store: UseBoundStore<StoreApi<AppState>>): void {
  useAppStore = store;
}
