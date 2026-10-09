/**
 * Hand-off between the terminal connection-state overlays and `TerminalSlot`
 * (#4513): when the user activates an overlay's reconnect action (Retry,
 * Reconnect, Start New Shell), the overlay marks the tab here. Once the session
 * is back, the slot that shows the terminal again consumes the mark and returns
 * focus to the terminal only if focus is unclaimed (see `isFocusUnclaimed`), so a
 * dialog or another panel the user moved to meanwhile keeps it.
 */
const pendingRefocus = new Set<string>();

/** Record that `tabId`'s overlay started a user-initiated reconnect. */
export function markTerminalRefocusPending(tabId: string): void {
  pendingRefocus.add(tabId);
}

/** Return whether a reconnect refocus is pending for `tabId`, clearing it. */
export function consumeTerminalRefocusPending(tabId: string): boolean {
  return pendingRefocus.delete(tabId);
}
