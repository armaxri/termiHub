import { useCallback, useRef } from "react";

/** What {@link useOpenAfterMenuClose} returns. */
export interface OpenAfterMenuClose {
  /** Call from the menu item's `onSelect`: `open` runs once the menu has closed. */
  request: () => void;
  /** Pass to the menu content's `onCloseAutoFocus`. */
  onCloseAutoFocus: (event: Event) => void;
}

/**
 * Run `open` only once a context menu has fully closed, and keep the menu from
 * moving focus back to its trigger.
 *
 * Use it for a menu item that opens an inline input (New Subfolder, New
 * Folder). Opened from `onSelect`, the input mounts while the menu is still
 * closing; the menu then hands focus back to the row, which blurs the input,
 * and the inline input cancels on blur (#5322, #5323).
 */
export function useOpenAfterMenuClose(open: () => void): OpenAfterMenuClose {
  const pendingRef = useRef(false);
  const openRef = useRef(open);
  openRef.current = open;

  const request = useCallback(() => {
    pendingRef.current = true;
  }, []);

  const onCloseAutoFocus = useCallback((event: Event) => {
    if (!pendingRef.current) return;
    pendingRef.current = false;
    event.preventDefault();
    openRef.current();
  }, []);

  return { request, onCloseAutoFocus };
}
