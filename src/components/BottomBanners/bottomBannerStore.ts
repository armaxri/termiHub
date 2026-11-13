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
 * data and always wins; a promotional prompt (the file-manager integration
 * offer) never competes with it.
 */

import { useEffect } from "react";
import { create } from "zustand";

/** Every app-level bottom banner, by id. */
export type BottomBannerId = "crash-report" | "agent-crash-report" | "shell-integration";

/** Higher wins. Safety-relevant notices first, promotional prompts last. */
export const BOTTOM_BANNER_PRIORITY: Record<BottomBannerId, number> = {
  "crash-report": 300,
  "agent-crash-report": 200,
  "shell-integration": 100,
};

interface BottomBannerState {
  /** Banners that currently want to be shown. */
  wanting: Partial<Record<BottomBannerId, true>>;
  setWanting: (id: BottomBannerId, wants: boolean) => void;
}

export const useBottomBannerStore = create<BottomBannerState>((set) => ({
  wanting: {},
  setWanting: (id, wants) =>
    set((s) => {
      if (Boolean(s.wanting[id]) === wants) return s;
      const wanting = { ...s.wanting };
      if (wants) wanting[id] = true;
      else delete wanting[id];
      return { wanting };
    }),
}));

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
