import { useLayoutEffect, useState } from "react";
import { setTransientDeferred } from "./toast";

/**
 * Attribute marking an element the toast stack must never cover (#5618): an
 * open dialog (#5686), a modal or editor footer with its Save buttons, the
 * Transfers panel. Put it on
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

/**
 * CSS custom property (on `<html>`) holding a narrowed toast column width, set
 * only while an open dialog leaves no room above it but enough beside it
 * (#5686). {@link TOAST_NARROW_CLASS} on `<html>` applies it to the stack.
 */
export const TOAST_WIDTH_VAR = "--app-toast-width";

/** Class on `<html>` while {@link TOAST_WIDTH_VAR} narrows the toast column. */
export const TOAST_NARROW_CLASS = "th-toast-narrow";

/** Narrowest column the stack is squeezed to beside a dialog (#5686). */
export const MIN_TOAST_WIDTH = 240;

/**
 * Class on `<html>` while the stack is docked (#5715): a tall dialog leaves no
 * room above it nor a {@link MIN_TOAST_WIDTH} column beside it, so the stack
 * moves to the window's top edge, shows one compact single-line toast at a
 * time, and success/info toasts wait until the dialog closes.
 */
export const TOAST_DOCKED_CLASS = "th-toast-docked";

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

/** Where the stack goes: its bottom inset and its column width. */
export interface ToastLayout {
  inset: number;
  width: number;
  /**
   * A tall box leaves neither room above it nor a {@link MIN_TOAST_WIDTH}
   * column beside it (#5715): dock the stack at the top edge in its compact
   * form and defer success/info toasts until the box goes away.
   */
  docked: boolean;
}

/**
 * Lay the toast stack out clear of every keep-clear box (#5618, #5686).
 *
 * A box with room above it for the stack (a footer, the Transfers panel, a
 * short dialog) is cleared by lifting the stack above it
 * ({@link computeToastAvoidInset}). A box without that room — a tall open
 * dialog — cannot be lifted over without pushing the stack off the window, so
 * the column is narrowed to fit beside it instead, down to
 * {@link MIN_TOAST_WIDTH}. When even that does not fit (a `lg` dialog in a
 * narrow window, a `full` dialog), the layout is `docked` (#5715): the stack
 * leaves the bottom-right corner for the top edge, where a single compact
 * error stays readable over the dialog head instead of its body, and
 * success/info toasts are deferred until the dialog closes.
 */
export function computeToastLayout(boxes: readonly Box[], zone: ToastZone): ToastLayout {
  const live = boxes.filter((b) => b.bottom > b.top && b.right > b.left);
  const liftable = (b: Box) => b.top >= zone.height + 2 * zone.edge;
  const columnRight = zone.viewportWidth - zone.edge;
  const bandBottom = zone.viewportHeight - zone.baseInset - zone.edge;
  const bandTop = bandBottom - zone.height;
  let width = zone.width;
  let docked = false;
  for (const b of live) {
    if (liftable(b)) continue;
    const inColumn = b.right > columnRight - zone.width && b.left < columnRight;
    const inBand = b.bottom > bandTop && b.top < bandBottom;
    if (!inColumn || !inBand) continue;
    const room = Math.floor(columnRight - b.right - zone.edge);
    if (room >= MIN_TOAST_WIDTH) width = Math.min(width, room);
    else docked = true;
  }
  if (docked) width = zone.width;
  const inset = computeToastAvoidInset(live.filter(liftable), { ...zone, width });
  return { inset, width, docked };
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
 * Keep {@link TOAST_AVOID_INSET_VAR} (and, beside a tall dialog,
 * {@link TOAST_WIDTH_VAR}) current: measure every `[data-toast-avoid]` element
 * and publish where the stack must sit to clear them. Re-measures (at most
 * once per frame) on DOM changes and window resize, because a footer or the
 * Transfers panel can appear, move or resize at any time.
 *
 * Returns whether the stack is docked at the top edge (#5715); while it is,
 * {@link TOAST_DOCKED_CLASS} is on `<html>` and success/info toasts are
 * deferred ({@link setTransientDeferred}).
 */
export function useToastAvoidInset(width: number, edge: number): boolean {
  const [docked, setDocked] = useState(false);
  useLayoutEffect(() => {
    const root = document.documentElement;
    let frame = 0;
    let last = "";
    // While docked only one compact toast shows, so the measured stack is
    // short; measuring it then could make a dialog look liftable and undock,
    // re-dock, … every frame. The height from before docking stands in.
    let stackHeight = MIN_STACK_HEIGHT;
    let isDocked = false;
    const publish = () => {
      frame = 0;
      const boxes = Array.from(
        document.querySelectorAll<HTMLElement>(`[${TOAST_AVOID_ATTR}]`),
        (el) => el.getBoundingClientRect()
      );
      const layout = computeToastLayout(boxes, {
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        width,
        height: isDocked ? stackHeight : (stackHeight = measureStackHeight()),
        edge,
        baseInset: readPxVar("--app-bottom-banner-inset"),
      });
      isDocked = layout.docked;
      const value = `${layout.inset}px|${layout.width}|${layout.docked}`;
      if (value === last) return;
      last = value;
      root.style.setProperty(TOAST_AVOID_INSET_VAR, `${layout.inset}px`);
      root.classList.toggle(TOAST_DOCKED_CLASS, layout.docked);
      setTransientDeferred(layout.docked);
      setDocked(layout.docked);
      if (layout.width < width) {
        root.style.setProperty(TOAST_WIDTH_VAR, `${layout.width}px`);
        root.classList.add(TOAST_NARROW_CLASS);
      } else {
        root.style.removeProperty(TOAST_WIDTH_VAR);
        root.classList.remove(TOAST_NARROW_CLASS);
      }
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
      root.style.removeProperty(TOAST_WIDTH_VAR);
      root.classList.remove(TOAST_NARROW_CLASS);
      root.classList.remove(TOAST_DOCKED_CLASS);
      setTransientDeferred(false);
    };
  }, [width, edge]);
  return docked;
}
