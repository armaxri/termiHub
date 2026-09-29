import { StateCreator } from "zustand";

import type { AppState } from "../appStore";
import { omitKey } from "../layoutHelpers";

/**
 * Per-session syntax-highlighting override slice (ARCH-001/FES-011, appStore
 * god-module split via #2881). Extracted verbatim from the monolithic root store
 * as a behavior-preserving Zustand slice, so the public store shape and behavior
 * are unchanged.
 */
export interface SessionHighlightingSlice {
  /**
   * Per-session temporary syntax-highlighting toggle (runtime-only, never
   * persisted). Keyed by session id. Set by the status-bar quick toggle
   * (epic #1696, child #1704) to override the resolved config for a single
   * live session without touching saved settings. A missing entry means
   * "follow the resolved config"; `setSessionHighlighting(id, undefined)`
   * clears the override back to that state.
   */
  sessionHighlighting: Record<string, boolean>;
  setSessionHighlighting: (sessionId: string, enabled: boolean | undefined) => void;
}

export const createSessionHighlightingSlice: StateCreator<
  AppState,
  [],
  [],
  SessionHighlightingSlice
> = (set) => ({
  sessionHighlighting: {},
  setSessionHighlighting: (sessionId, enabled) =>
    set((s) =>
      enabled === undefined
        ? { sessionHighlighting: omitKey(s.sessionHighlighting, sessionId) }
        : { sessionHighlighting: { ...s.sessionHighlighting, [sessionId]: enabled } }
    ),
});
