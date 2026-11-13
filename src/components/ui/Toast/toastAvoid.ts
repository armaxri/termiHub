import { useLayoutEffect } from "react";

/**
 * Attribute marking an element the toast stack must never cover (#5618): a
 * modal or editor footer with its Save buttons, the Transfers panel. Put it on
 * the element itself (`data-toast-avoid=""`); the toast hub measures every
 * marked element and lifts the stack above any that sits in its way.
 */
export const TOAST_AVOID_ATTR = "data-toast-avoid";

/** Spread onto an element to mark it as a toast keep-clear zone. */
export const TOAST_AVOID_PROPS = { [TOAST_AVOID_ATTR]: "" } as const;

/**
 * CSS custom property (on `<html>`) holding how far above the window bottom the
 * toast stack must start so it clears every marked keep-clear element — `0px`
 * when nothing is in the way. Read by `ToastProvider`'s bottom offset.
 */
export const TOAST_AVOID_INSET_VAR = "--app-toast-avoid-inset";

/** A box in viewport CSS pixels (the subset of `DOMRect` the math needs). */
export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Where the toast stack sits: a column at the right edge of the viewport. */
export interface ToastZone {
  /** Viewport width and height. */
  viewportWidth: number;
  viewportHeight: number;
  /** Width of the toast column (sonner's `--width`). */
  width: number;
  /** Height of the rendered stack (at least one toast's height). */
  height: number;
  /** Gap between the stack and the window edge / the element it clears. */
  edge: number;
  /** Inset already reserved below the stack (the bottom banner, #5556). */
  baseInset: number;
}

/**
 * How far above the window bottom the toast stack must start so it overlaps
 * none of `boxes` (#5618). A box counts only when it shares the stack's column
 * and reaches into the band the stack occupies; lifting the stack above one box
 * can bring it into the next one up, so this repeats until nothing is hit.
 * Returns `zone.baseInset` when nothing is in the way.
 */
export function computeToastAvoidInset(boxes: readonly Box[], zone: ToastZone): number {
  const columnRight = zone.viewportWidth - zone.edge;
  const columnLeft = columnRight - zone.width;
  const inColumn = boxes.filter(
    (b) => b.right > columnLeft && b.left < columnRight && b.bottom > b.top
  );
  let inset = zone.baseInset;
  for (let pass = 0; pass <= inColumn.length; pass++) {
    const stackBottom = zone.viewportHeight - inset - zone.edge;
    const stackTop = stackBottom - zone.height;
    let next = inset;
    for (const b of inColumn) {
      if (b.bottom > stackTop && b.top < stackBottom) {
        next = Math.max(next, Math.ceil(zone.viewportHeight - b.top));
      }
    }
    if (next === inset) return inset;
    inset = next;
  }
  return inset;
}

/** Smallest stack height assumed while no toast is showing (one short toast). */
const MIN_STACK_HEIGHT = 64;

/** The rendered stack's height: the span of the visible toasts' boxes. */
function measureStackHeight(): number {
  const toasts = document.querySelectorAll<HTMLElement>("[data-sonner-toast]");
  let top = Infinity;
  let bottom = -Infinity;
  for (const el of toasts) {
    if (el.getAttribute("data-removed") === "true") continue;
    const r = el.getBoundingClientRect();
    if (r.height <= 0) continue;
    top = Math.min(top, r.top);
    bottom = Math.max(bottom, r.bottom);
  }
  return Number.isFinite(top) ? Math.max(MIN_STACK_HEIGHT, bottom - top) : MIN_STACK_HEIGHT;
}

/** Read a `px` custom property off `<html>`, 0 when unset. */
function readPxVar(name: string): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name);
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? value : 0;
}

/**
 * Keep {@link TOAST_AVOID_INSET_VAR} current: measure every
 * `[data-toast-avoid]` element and publish the inset the stack needs to clear
 * them. Re-measures (at most once per frame) on DOM changes and window resize,
 * because a footer or the Transfers panel can appear, move or resize at any
 * time.
 */
export function useToastAvoidInset(width: number, edge: number): void {
  useLayoutEffect(() => {
    const root = document.documentElement;
    let frame = 0;
    let last = "";
    const publish = () => {
      frame = 0;
      const boxes = Array.from(
        document.querySelectorAll<HTMLElement>(`[${TOAST_AVOID_ATTR}]`),
        (el) => el.getBoundingClientRect()
      );
      const inset = computeToastAvoidInset(boxes, {
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        width,
        height: measureStackHeight(),
        edge,
        baseInset: readPxVar("--app-bottom-banner-inset"),
      });
      const value = `${inset}px`;
      if (value === last) return;
      last = value;
      root.style.setProperty(TOAST_AVOID_INSET_VAR, value);
    };
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(publish);
    };
    publish();
    const mutations = new MutationObserver(schedule);
    mutations.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "style", "data-state", TOAST_AVOID_ATTR],
    });
    window.addEventListener("resize", schedule);
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      mutations.disconnect();
      window.removeEventListener("resize", schedule);
      root.style.removeProperty(TOAST_AVOID_INSET_VAR);
    };
  }, [width, edge]);
}
