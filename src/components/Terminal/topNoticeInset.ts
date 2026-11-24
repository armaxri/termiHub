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
 *
 * The inset moves the xterm element's `top`, and `Terminal.tsx` observes that
 * element with its own ResizeObserver. Writing the inset from inside this
 * observer's delivery would resize an observed element in the same cycle and
 * WebKit reports "ResizeObserver loop completed with undelivered notifications"
 * (#5948). So the observer only schedules the write for the next animation
 * frame (coalescing bursts), and unchanged heights are not written at all.
 */
export function useTopNoticeInset(ref: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const notice = ref.current;
    const host = notice ? insetHost(notice) : null;
    if (!notice || !host) return;
    let published: string | null = null;
    let frame: number | null = null;
    const publish = () => {
      frame = null;
      const value = `${Math.ceil(notice.offsetHeight)}px`;
      if (value === published) return;
      published = value;
      host.style.setProperty(TOP_NOTICE_INSET_VAR, value);
    };
    const schedule = () => {
      if (frame === null) frame = requestAnimationFrame(publish);
    };
    // Mount: publish synchronously so the first paint already has the inset.
    publish();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    observer?.observe(notice);
    return () => {
      observer?.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
      host.style.removeProperty(TOP_NOTICE_INSET_VAR);
    };
  }, [ref]);
}
