import { useLayoutEffect, type RefObject } from "react";

/**
 * CSS custom property holding the height of the notice pinned to the top of a
 * terminal slot (the view-mode banner or the reconnect strip), `0px` when none.
 * Set on the slot's `.terminal-context-trigger` wrapper; the terminal search bar
 * (a sibling of the slot) reads it so it opens below the notice instead of over
 * its Reconnect / Cancel button (#5823).
 */
export const TOP_NOTICE_INSET_VAR = "--terminal-top-notice-inset";

/** The element that owns {@link TOP_NOTICE_INSET_VAR} for `notice`'s slot. */
function insetHost(notice: HTMLElement): HTMLElement | null {
  return notice.closest<HTMLElement>(".terminal-context-trigger");
}

/**
 * Publish the height of the top-of-slot notice at `ref` as
 * {@link TOP_NOTICE_INSET_VAR} while it is mounted, tracking wraps and resizes.
 */
export function useTopNoticeInset(ref: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const notice = ref.current;
    const host = notice ? insetHost(notice) : null;
    if (!notice || !host) return;
    const publish = () => {
      host.style.setProperty(TOP_NOTICE_INSET_VAR, `${Math.ceil(notice.offsetHeight)}px`);
    };
    publish();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(publish);
    observer?.observe(notice);
    return () => {
      observer?.disconnect();
      host.style.removeProperty(TOP_NOTICE_INSET_VAR);
    };
  }, [ref]);
}
