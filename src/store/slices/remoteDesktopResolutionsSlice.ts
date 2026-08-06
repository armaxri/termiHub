import { StateCreator } from "zustand";

import type { AppState } from "../appStore";

/**
 * Remote-desktop resolution domain slice (extracted under #2077 via #2300): the
 * runtime-only (never persisted) live framebuffer resolution of each active
 * graphical remote-desktop session, keyed by session id (#1709), plus the
 * set/clear actions that feed it from the `remote-desktop-frame` / `onDimensions`
 * path so the shared status-bar segment can show `WxH` for the active tab.
 * Extracted verbatim from the monolithic root store as a behavior-preserving
 * Zustand slice — every action still receives the shared `set` typed against the
 * full {@link AppState}, so the public store shape and behavior are unchanged.
 * Mirrors the SSH tunnel slice (#2077) and the embedded-server / macros /
 * plugins / session-history / zoom / command-palette / http-monitors / dialogs
 * slices (#2113/#2114/#2115/#2299/#2300).
 */

/** Return a copy of `rec` with `key` removed, without mutating the original. */
function omitKey<V>(rec: Record<string, V>, key: string): Record<string, V> {
  const { [key]: _, ...rest } = rec;
  return rest;
}

export interface RemoteDesktopResolutionsSlice {
  /**
   * Live framebuffer resolution of each active graphical remote-desktop session,
   * keyed by session id (#1709). Fed from the `remote-desktop-frame` /
   * `onDimensions` path so the shared status-bar segment can show `WxH` for the
   * active tab. Cleared when the session ends.
   */
  remoteDesktopResolutions: Record<string, { width: number; height: number }>;
  setRemoteDesktopResolution: (sessionId: string, width: number, height: number) => void;
  clearRemoteDesktopResolution: (sessionId: string) => void;
}

export const createRemoteDesktopResolutionsSlice: StateCreator<
  AppState,
  [],
  [],
  RemoteDesktopResolutionsSlice
> = (set) => ({
  remoteDesktopResolutions: {},
  setRemoteDesktopResolution: (sessionId, width, height) =>
    set((state) => {
      const prev = state.remoteDesktopResolutions[sessionId];
      if (prev && prev.width === width && prev.height === height) return {};
      return {
        remoteDesktopResolutions: {
          ...state.remoteDesktopResolutions,
          [sessionId]: { width, height },
        },
      };
    }),
  clearRemoteDesktopResolution: (sessionId) =>
    set((state) => {
      if (!(sessionId in state.remoteDesktopResolutions)) return {};
      return {
        remoteDesktopResolutions: omitKey(state.remoteDesktopResolutions, sessionId),
      };
    }),
});
