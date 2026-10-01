import { useSyncExternalStore } from "react";

/** The media query the OS "reduce motion" / "animation effects off" setting drives. */
export const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/** Resolve the query, or `null` where `matchMedia` is unavailable (SSR, old jsdom). */
function getMediaQueryList(): MediaQueryList | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return null;
  return window.matchMedia(REDUCED_MOTION_QUERY);
}

function subscribe(onChange: () => void): () => void {
  const mql = getMediaQueryList();
  if (!mql) return () => {};
  // `addEventListener` on MediaQueryList is the modern API; older WebKit only
  // exposes the deprecated `addListener`, so fall back to it.
  if (typeof mql.addEventListener === "function") {
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }
  mql.addListener(onChange);
  return () => mql.removeListener(onChange);
}

function getSnapshot(): boolean {
  return getMediaQueryList()?.matches ?? false;
}

/**
 * Whether the user asked the OS to minimize motion (`prefers-reduced-motion:
 * reduce`). Live — re-renders when the setting flips.
 *
 * Under reduced motion essential progress spinners (`.motion-essential-spinner`)
 * render as a **static** icon (animations.css, #4039), so a spinner alone no
 * longer signals "in progress". Components use this hook to put a steady text
 * label (e.g. "Connecting…", "Working…") next to such a spinner where full
 * motion would otherwise rely on the rotation alone.
 */
export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
