import { useCallback, useEffect, useRef, useState } from "react";
import { findTypeAheadIndex } from "@/utils/fileBrowserNav";

/** How long (ms) a type-ahead buffer stays "hot" before the next keystroke resets it. */
const TYPE_AHEAD_RESET_MS = 700;

/**
 * Callbacks the keydown handler invokes for actions the hook itself does not own.
 *
 * The hook owns the roving focus index, the type-ahead buffer, and the row-ref
 * wiring; selection and navigation semantics live with the consumer and are
 * reached through these callbacks. This split is what untangles the
 * nav-reset ↔ keydown ordering cycle: the consumer's nav-reset handlers can
 * depend on the hook's stable `reset()`, while the keydown handler is built
 * from these callbacks *after* those handlers are defined (see
 * `makeKeyDownHandler`).
 */
export interface RovingListNavCallbacks<T> {
  /** Activate (open/edit) the entry at `index` — bound to Enter. */
  onActivate: (item: T, index: number) => void;
  /** Navigate up one level — bound to Backspace and Alt+ArrowLeft. */
  onNavigateUp: () => void;
  /** Begin renaming the entry at `index` — bound to F2. */
  onRename: (item: T, index: number) => void;
  /** Select every entry — bound to Ctrl/Cmd+A. */
  onSelectAll: () => void;
  /** Clear the current selection — bound to Escape. */
  onClearSelection: () => void;
  /** Index of the current selection anchor, or -1 when there is none. */
  getAnchorIndex: () => number;
  /** Replace the selection with the inclusive range `[start, end]`. */
  onSelectRange: (start: number, end: number) => void;
  /** Replace the selection with just `item` and set it as the new anchor. */
  onSelectSingle: (item: T, index: number) => void;
}

/** Public surface of {@link useRovingListNav}. */
export interface RovingListNav<T, E extends HTMLElement = HTMLElement> {
  /** Roving-tabindex focus index into the items array. */
  activeIndex: number;
  /** Directly set the active index (e.g. to follow a mouse click). */
  setActiveIndex: React.Dispatch<React.SetStateAction<number>>;
  /** Stable per-index ref callback so rows don't detach/reattach each render. */
  getRowRef: (index: number) => (el: E | null) => void;
  /** Return roving focus to the top of the list (e.g. after navigation). */
  reset: () => void;
  /**
   * Move roving focus to `index`: mark it active and move DOM focus to its row.
   *
   * The shared keydown handler only moves focus for the keys it owns; a
   * consumer that adds its own keys (e.g. a tree's ArrowLeft/ArrowRight to jump
   * to a parent/child row) calls this to keep the roving focus in sync.
   */
  focusRow: (index: number) => void;
  /**
   * Build the list's `onKeyDown` handler from the supplied callbacks. Call this
   * in render *after* the consumer's navigation/selection callbacks exist; the
   * returned handler closes over the current `items` and `activeIndex`.
   */
  makeKeyDownHandler: (callbacks: RovingListNavCallbacks<T>) => (e: React.KeyboardEvent) => void;
}

/**
 * Roving-tabindex keyboard navigation for a flat list view.
 *
 * Owns the active focus index, the type-ahead buffer, and the per-row ref
 * wiring; keeps the active index in range as the list length changes; and
 * produces a keydown handler covering arrow/Home/End movement (with optional
 * Shift range-extend), Enter to activate, F2 to rename, Backspace/Alt+ArrowLeft
 * to go up, Ctrl/Cmd+A select-all, Escape to clear, and type-ahead jumping.
 *
 * Generic over the item type `T` and the row element type `E`, so it can drive
 * any single-column list (file browser, connection tree, …). Selection and
 * navigation behavior are supplied by the consumer via
 * {@link RovingListNavCallbacks}.
 *
 * @param items - Items in current display order (the single source of order for
 *   both the rendered rows and keyboard navigation).
 * @param getLabel - Extracts the type-ahead label (usually the display name)
 *   from an item.
 */
export function useRovingListNav<T, E extends HTMLElement = HTMLElement>(
  items: T[],
  getLabel: (item: T) => string
): RovingListNav<T, E> {
  const [activeIndex, setActiveIndex] = useState(0);
  const rowRefs = useRef<(E | null)[]>([]);
  const rowRefCbs = useRef<Map<number, (el: E | null) => void>>(new Map());
  const typeAhead = useRef<{ buffer: string; ts: number }>({ buffer: "", ts: 0 });

  // Keep the label accessor current without churning the memoized handler's
  // identity when the consumer passes a fresh closure each render.
  const getLabelRef = useRef(getLabel);
  getLabelRef.current = getLabel;

  // Stable per-index ref callback so rows don't detach/reattach every render.
  const getRowRef = useCallback((index: number) => {
    const cache = rowRefCbs.current;
    let cb = cache.get(index);
    if (!cb) {
      cb = (el: E | null) => {
        rowRefs.current[index] = el;
      };
      cache.set(index, cb);
    }
    return cb;
  }, []);

  // Keep the active index in range as the list length changes.
  useEffect(() => {
    setActiveIndex((i) => Math.min(Math.max(0, i), Math.max(0, items.length - 1)));
  }, [items.length]);

  const reset = useCallback(() => setActiveIndex(0), []);

  const focusRow = useCallback((index: number) => {
    setActiveIndex(index);
    rowRefs.current[index]?.focus();
  }, []);

  const makeKeyDownHandler = useCallback(
    (callbacks: RovingListNavCallbacks<T>) => (e: React.KeyboardEvent) => {
      const entries = items;
      const len = entries.length;
      const key = e.key;

      // Move the roving focus/selection to `index`. With `extend`, grows the
      // selection from the anchor to `index`; otherwise selects just the
      // target. Focus follows so keyboard and screen-reader users stay in sync.
      const moveActive = (index: number, extend: boolean) => {
        const item = entries[index];
        if (!item) return;
        setActiveIndex(index);
        rowRefs.current[index]?.focus();
        if (extend) {
          const anchorIdx = callbacks.getAnchorIndex();
          if (anchorIdx >= 0) {
            const [start, end] = anchorIdx < index ? [anchorIdx, index] : [index, anchorIdx];
            callbacks.onSelectRange(start, end);
            return;
          }
        }
        callbacks.onSelectSingle(item, index);
      };

      if ((e.ctrlKey || e.metaKey) && key.toLowerCase() === "a") {
        e.preventDefault();
        callbacks.onSelectAll();
        return;
      }
      if (key === "Escape") {
        callbacks.onClearSelection();
        return;
      }
      if (key === "Backspace" || (e.altKey && key === "ArrowLeft")) {
        e.preventDefault();
        callbacks.onNavigateUp();
        return;
      }
      if (len === 0) return;

      if (key === "ArrowDown" || key === "ArrowUp") {
        e.preventDefault();
        const delta = key === "ArrowDown" ? 1 : -1;
        moveActive(Math.min(len - 1, Math.max(0, activeIndex + delta)), e.shiftKey);
        return;
      }
      if (key === "Home" || key === "End") {
        e.preventDefault();
        moveActive(key === "Home" ? 0 : len - 1, e.shiftKey);
        return;
      }
      if (key === "Enter") {
        e.preventDefault();
        const item = entries[activeIndex];
        if (item) callbacks.onActivate(item, activeIndex);
        return;
      }
      if (key === "F2") {
        e.preventDefault();
        const item = entries[activeIndex];
        if (item) callbacks.onRename(item, activeIndex);
        return;
      }
      // Type-ahead: a printable character with no command modifiers.
      if (key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const now = Date.now();
        const ta = typeAhead.current;
        const fresh = now - ta.ts > TYPE_AHEAD_RESET_MS;
        ta.buffer = fresh ? key : ta.buffer + key;
        ta.ts = now;
        const idx = findTypeAheadIndex(
          entries,
          getLabelRef.current,
          ta.buffer,
          activeIndex,
          ta.buffer.length === 1
        );
        if (idx >= 0) moveActive(idx, false);
      }
    },
    [items, activeIndex]
  );

  return { activeIndex, setActiveIndex, getRowRef, reset, focusRow, makeKeyDownHandler };
}
