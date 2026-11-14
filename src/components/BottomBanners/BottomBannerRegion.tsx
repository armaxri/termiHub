import { useLayoutEffect, useRef, type ReactNode } from "react";
import "./BottomBanners.css";

/**
 * CSS custom property (on `<html>`) holding how far the top edge of the visible
 * bottom banner sits above the bottom of the window, in px — `0px` when no
 * banner is showing. The toast stack anchors above it (#5556) so a toast never
 * covers a banner's buttons.
 */
export const BOTTOM_BANNER_INSET_VAR = "--app-bottom-banner-inset";

/** Distance from the region's top edge to the window bottom, or 0 when empty. */
export function measureBottomBannerInset(el: HTMLElement, viewportHeight: number): number {
  const rect = el.getBoundingClientRect();
  if (rect.height <= 0) return 0;
  return Math.max(0, Math.round(viewportHeight - rect.top));
}

/**
 * Hosts the app-level bottom banners (the local and agent crash notices).
 * Which one renders is decided by {@link useBottomBannerSlot}; this region only
 * publishes the space they take so floating layers (toasts) can stay clear.
 */
export function BottomBannerRegion({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const root = document.documentElement;
    const publish = () => {
      root.style.setProperty(
        BOTTOM_BANNER_INSET_VAR,
        `${measureBottomBannerInset(el, window.innerHeight)}px`
      );
    };
    publish();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(publish);
    observer?.observe(el);
    // Banners mount/unmount inside the region; layout below it (status bar,
    // transfer queue) can also move it, so re-measure on any child change too.
    const mutations = new MutationObserver(publish);
    mutations.observe(el, { childList: true, subtree: true });
    window.addEventListener("resize", publish);
    return () => {
      observer?.disconnect();
      mutations.disconnect();
      window.removeEventListener("resize", publish);
      root.style.removeProperty(BOTTOM_BANNER_INSET_VAR);
    };
  }, []);

  return (
    <div ref={ref} className="bottom-banners" data-testid="bottom-banners">
      {children}
    </div>
  );
}
