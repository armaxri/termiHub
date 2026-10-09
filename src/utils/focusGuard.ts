/**
 * Whether moving focus to `anchor` (or a control near it) would not steal it
 * from the user (#4331, #4513): focus is nowhere (the page body) or already
 * inside the anchor's host — the nearest `[data-overlay-host]` ancestor (a
 * split-view panel or the zoom overlay), else the anchor's parent. Focus held by
 * a dialog, the sidebar or another panel is never taken.
 */
export function isFocusUnclaimed(anchor: HTMLElement): boolean {
  const active = document.activeElement;
  if (!active || active === document.body) return true;
  const host = anchor.closest("[data-overlay-host]") ?? anchor.parentElement;
  return host?.contains(active) ?? false;
}
