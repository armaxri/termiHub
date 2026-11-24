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
 * Attribute marking an editor's form fields (#5830): the scrolling body of the
 * connection, workspace and tunnel editors. Lifting the stack above the
 * editor's footer still lands it on the fields the user is filling in, so
 * while a marked form sits where the stack would go, the stack is pinned to
 * the top-right instead, just above the form (over the editor's title strip),
 * one compact toast at a time. Put it on the form element, below the editor's
 * header.
 */
export const TOAST_AVOID_FORM_ATTR = "data-toast-avoid-form";

/** Spread onto an editor's form body to keep the toast stack off its fields. */
export const TOAST_AVOID_FORM_PROPS = { [TOAST_AVOID_FORM_ATTR]: "" } as const;

/**
 * Class on `<html>` while the stack is pinned top-right above an editor form
 * (#5830); it shows the compact single-line toast form, as when docked.
 */
export const TOAST_PINNED_CLASS = "th-toast-pinned";

/** Height of one compact (single-line) toast, assumed until one is measured. */
export const COMPACT_TOAST_HEIGHT = 32;

/** Gap between a pinned toast and the top of the form it keeps off. */
const PIN_GAP = 2;

/** The pinned stack never starts closer than this to the window's top edge. */
const PIN_MIN_TOP = 4;

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
  /**
   * Height of one compact toast, for pinning the stack above an editor form
   * (#5830). Defaults to {@link COMPACT_TOAST_HEIGHT}.
   */
  compactHeight?: number;
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
  /**
   * Where the top of the stack goes while it is pinned top-right above an
   * editor form (#5830), in px from the window's top edge; `null` when the
   * stack is not pinned. Never set while {@link ToastLayout.docked}.
   */
  pinnedTop: number | null;
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
 *
 * `forms` are editor form bodies (#5830, {@link TOAST_AVOID_FORM_ATTR}). When
 * the stack, laid out as above, would still land on one, it is pinned to the
 * top-right just above the form instead (`pinnedTop`), over the editor's
 * title strip, so it never covers a field being filled in.
 */
export function computeToastLayout(
  boxes: readonly Box[],
  zone: ToastZone,
  forms: readonly Box[] = []
): ToastLayout {
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
  return {
    inset,
    width,
    docked,
    pinnedTop: docked ? null : pinnedTopFor(forms, zone, inset, width),
  };
}

/**
 * The pinned stack's top (#5830) when the stack — `width` wide, `inset` above
 * the window bottom — would overlap one of the editor `forms`: one compact
 * toast's height above the highest such form. `null` when no form is hit.
 */
function pinnedTopFor(
  forms: readonly Box[],
  zone: ToastZone,
  inset: number,
  width: number
): number | null {
  const right = zone.viewportWidth - zone.edge;
  const left = right - width;
  const bottom = zone.viewportHeight - inset - zone.edge;
  const top = bottom - zone.height;
  let formTop = Infinity;
  for (const b of forms) {
    if (b.bottom <= b.top || b.right <= b.left) continue;
    if (b.right > left && b.left < right && b.bottom > top && b.top < bottom) {
      formTop = Math.min(formTop, b.top);
    }
  }
  if (!Number.isFinite(formTop)) return null;
  const height = zone.compactHeight ?? COMPACT_TOAST_HEIGHT;
  return Math.max(PIN_MIN_TOP, Math.floor(formTop - height - PIN_GAP));
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

/** The tallest visible toast: one compact toast's height while pinned. */
function measureToastHeight(): number {
  let tallest = 0;
  for (const el of document.querySelectorAll<HTMLElement>("[data-sonner-toast]")) {
    if (el.getAttribute("data-removed") === "true") continue;
    tallest = Math.max(tallest, el.getBoundingClientRect().height);
  }
  return tallest > 0 ? Math.ceil(tallest) : COMPACT_TOAST_HEIGHT;
}

/** Where the toast hub puts the stack: docked, pinned, or bottom-right. */
export interface ToastPlacement {
  /** Docked at the top edge over a tall dialog (#5715). */
  docked: boolean;
  /** Pinned top-right above an editor form, at this top offset (#5830). */
  pinnedTop: number | null;
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
 * deferred ({@link setTransientDeferred}). Also returns where the stack is
 * pinned above an editor form (#5830, {@link TOAST_PINNED_CLASS}).
 */
export function useToastAvoidInset(width: number, edge: number): ToastPlacement {
  const [placement, setPlacement] = useState<ToastPlacement>({ docked: false, pinnedTop: null });
  useLayoutEffect(() => {
    const root = document.documentElement;
    let frame = 0;
    let last = "";
    // While docked only one compact toast shows, so the measured stack is
    // short; measuring it then could make a dialog look liftable and undock,
    // re-dock, … every frame. The height from before docking stands in.
    let stackHeight = MIN_STACK_HEIGHT;
    let isDocked = false;
    let isPinned = false;
    const publish = () => {
      frame = 0;
      const boxes = Array.from(
        document.querySelectorAll<HTMLElement>(`[${TOAST_AVOID_ATTR}]`),
        (el) => el.getBoundingClientRect()
      );
      const forms = Array.from(
        document.querySelectorAll<HTMLElement>(`[${TOAST_AVOID_FORM_ATTR}]`),
        (el) => el.getBoundingClientRect()
      );
      // Pinned, the stack sits elsewhere (and compact), so it is measured for
      // its compact height only; the bottom band keeps the height from before.
      const frozen = isDocked || isPinned;
      const layout = computeToastLayout(
        boxes,
        {
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
          width,
          height: frozen ? stackHeight : (stackHeight = measureStackHeight()),
          edge,
          baseInset: readPxVar("--app-bottom-banner-inset"),
          compactHeight: isPinned ? measureToastHeight() : COMPACT_TOAST_HEIGHT,
        },
        forms
      );
      isDocked = layout.docked;
      isPinned = layout.pinnedTop !== null;
      const value = `${layout.inset}px|${layout.width}|${layout.docked}|${layout.pinnedTop}`;
      if (value === last) return;
      last = value;
      root.style.setProperty(TOAST_AVOID_INSET_VAR, `${layout.inset}px`);
      root.classList.toggle(TOAST_DOCKED_CLASS, layout.docked);
      root.classList.toggle(TOAST_PINNED_CLASS, isPinned);
      setTransientDeferred(layout.docked);
      setPlacement({ docked: layout.docked, pinnedTop: layout.pinnedTop });
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
      attributeFilter: ["class", "style", "data-state", TOAST_AVOID_ATTR, TOAST_AVOID_FORM_ATTR],
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
      root.classList.remove(TOAST_PINNED_CLASS);
      setTransientDeferred(false);
    };
  }, [width, edge]);
  return placement;
}
