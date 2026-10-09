import type { KeyboardEvent } from "react";

/** Keys the WAI-ARIA tabs pattern uses to move focus within a tablist. */
const ROVING_KEYS = ["ArrowLeft", "ArrowRight", "Home", "End"];

/**
 * Roving-focus keyboard navigation for a horizontal `role="tablist"` (#2071,
 * shared since #4349). Attach to the tablist's `onKeyDown`: ArrowLeft/Right
 * move focus to the previous/next `role="tab"` (wrapping), Home/End to the
 * first/last. Only the focused tab moves — activation stays with the tab's own
 * click handler. Returns the index of the tab that had focus when a navigation
 * key was handled, or `-1` when the event was not a roving key from a tab.
 */
export function rovingTabIndexFromKey(e: KeyboardEvent<HTMLElement>): number {
  if (!ROVING_KEYS.includes(e.key)) return -1;
  const tabEls = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]'));
  if (tabEls.length === 0) return -1;
  return tabEls.indexOf(document.activeElement as HTMLElement);
}

/**
 * Move focus from tab `current` per the roving key in `e` (see
 * {@link rovingTabIndexFromKey}). Prevents the key's default scroll.
 */
export function focusRovingTab(e: KeyboardEvent<HTMLElement>, current: number): void {
  const tabEls = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]'));
  if (current < 0 || current >= tabEls.length) return;
  e.preventDefault();
  let next = current;
  if (e.key === "ArrowLeft") next = (current - 1 + tabEls.length) % tabEls.length;
  else if (e.key === "ArrowRight") next = (current + 1) % tabEls.length;
  else if (e.key === "Home") next = 0;
  else if (e.key === "End") next = tabEls.length - 1;
  tabEls[next].focus();
}
