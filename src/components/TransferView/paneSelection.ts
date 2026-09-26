/**
 * Keyboard cursor and range-selection helpers for a transfer-view pane
 * (PROD-007, #3558).
 */

import type { FileEntry } from "@/types/connection";

/** Rows a PageUp / PageDown moves. */
const PAGE = 10;

/**
 * The cursor index after a navigation key, or `null` when `key` does not move
 * the cursor (or the list is empty). Always clamped to the list.
 */
export function nextPaneCursor(key: string, current: number, count: number): number | null {
  if (count === 0) return null;
  const clamp = (i: number) => Math.max(0, Math.min(count - 1, i));
  switch (key) {
    case "ArrowDown":
      return clamp(current + 1);
    case "ArrowUp":
      return clamp(current - 1);
    case "PageDown":
      return clamp(current + PAGE);
    case "PageUp":
      return clamp(current - PAGE);
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

/** The paths of the entries between `from` and `to`, inclusive. */
export function rangeSelection(entries: FileEntry[], from: number, to: number): Set<string> {
  const [lo, hi] = from <= to ? [from, to] : [to, from];
  return new Set(entries.slice(lo, hi + 1).map((e) => e.path));
}
