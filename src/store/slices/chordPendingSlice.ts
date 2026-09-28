import { StateCreator } from "zustand";

import type { AppState } from "../appStore";

/**
 * Chord-pending indicator slice (ARCH-001/FES-011, appStore god-module split via
 * #2881): the runtime-only label of a keyboard chord whose first stroke has been
 * pressed and is awaiting its second, shown by the status bar.
 *
 * Extracted verbatim from the monolithic root store as a behavior-preserving
 * Zustand slice, so the public store shape and behavior are unchanged.
 */
export interface ChordPendingSlice {
  chordPending: string | null;
  setChordPending: (pending: string | null) => void;
}

export const createChordPendingSlice: StateCreator<AppState, [], [], ChordPendingSlice> = (
  set
) => ({
  chordPending: null,
  setChordPending: (pending) => set({ chordPending: pending }),
});
