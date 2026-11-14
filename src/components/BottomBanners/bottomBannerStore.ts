/**
 * Ranking for the app-level banners at the bottom of the shell (#5548, #5549).
 *
 * Each banner reports whether it *wants* to show; only the highest-ranked one
 * that wants to is actually rendered, so the bottom of the window never stacks
 * two notices, each with its own call to action. A lower-ranked banner simply
 * waits: once the one above it is closed, it appears in its place (or on a
 * later launch, if it only shows once per session).
 *
 * The order is deliberate: a crash notice tells the user what happened to their
 * data and always wins.
 *
 * The store also records whether a crash notice came up this session (#5753):
 * the one-time file-manager offer is a toast, not a bottom banner, and it is
 * never shown in a session that shows a crash notice. The crash notices report
 * when their startup check has finished, so the offer can wait for both.
 */

import { useEffect } from "react";
import { create } from "zustand";

/** Every app-level bottom banner, by id. */
export type BottomBannerId = "crash-report" | "agent-crash-report";

/** Higher wins: the local crash notice before the agent crash notices. */
export const BOTTOM_BANNER_PRIORITY: Record<BottomBannerId, number> = {
  "crash-report": 300,
  "agent-crash-report": 200,
};

/** The two startup crash checks: the local one and the remote agents' one. */
export type CrashCheckKind = "local" | "agent";

interface BottomBannerState {
  /** Banners that currently want to be shown. */
  wanting: Partial<Record<BottomBannerId, true>>;
  setWanting: (id: BottomBannerId, wants: boolean) => void;
  /**
   * Whether a crash notice wanted to show at any point this session (#5753).
   * Sticky: closing the notice does not clear it.
   */
  crashNoticeThisSession: boolean;
  /** Which startup crash checks have finished (found something or not). */
  crashChecked: Record<CrashCheckKind, boolean>;
  /**
   * Record that the `kind` crash check finished; `found` says whether it
   * found a notice to show. Set both at once, so a reader never sees the check
   * done before the notice it found is recorded.
   */
  markCrashChecked: (kind: CrashCheckKind, found: boolean) => void;
}

export const useBottomBannerStore = create<BottomBannerState>((set) => ({
  wanting: {},
  setWanting: (id, wants) =>
    set((s) => {
      if (Boolean(s.wanting[id]) === wants) return s;
      const wanting = { ...s.wanting };
      if (wants) wanting[id] = true;
      else delete wanting[id];
      return { wanting, crashNoticeThisSession: s.crashNoticeThisSession || wants };
    }),
  crashNoticeThisSession: false,
  crashChecked: { local: false, agent: false },
  markCrashChecked: (kind, found) =>
    set((s) => {
      if (s.crashChecked[kind] && (!found || s.crashNoticeThisSession)) return s;
      return {
        crashChecked: { ...s.crashChecked, [kind]: true },
        crashNoticeThisSession: s.crashNoticeThisSession || found,
      };
    }),
}));

/** Both startup crash checks have finished. */
export function crashChecksDone(s: Pick<BottomBannerState, "crashChecked">): boolean {
  return s.crashChecked.local && s.crashChecked.agent;
}

/** The highest-ranked banner among `wanting`, or `null` when none wants to show. */
export function activeBottomBanner(
  wanting: Partial<Record<BottomBannerId, true>>
): BottomBannerId | null {
  let best: BottomBannerId | null = null;
  for (const id of Object.keys(wanting) as BottomBannerId[]) {
    if (best === null || BOTTOM_BANNER_PRIORITY[id] > BOTTOM_BANNER_PRIORITY[best]) best = id;
  }
  return best;
}

/**
 * Register banner `id` as wanting (or not wanting) to show, and return whether
 * it is the one banner that should render now. Call it unconditionally, before
 * any early return; the registration is withdrawn on unmount.
 */
export function useBottomBannerSlot(id: BottomBannerId, wants: boolean): boolean {
  const setWanting = useBottomBannerStore((s) => s.setWanting);
  const active = useBottomBannerStore((s) => activeBottomBanner(s.wanting));

  useEffect(() => {
    setWanting(id, wants);
  }, [id, wants, setWanting]);

  useEffect(() => () => setWanting(id, false), [id, setWanting]);

  // Before the effect has registered (first render), a banner that wants to
  // show only renders if nothing higher-ranked is already showing.
  if (!wants) return false;
  return active === null
    ? true
    : active === id || BOTTOM_BANNER_PRIORITY[id] > BOTTOM_BANNER_PRIORITY[active];
}
