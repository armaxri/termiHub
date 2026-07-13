import { useCallback, useMemo } from "react";
import { useRovingListNav } from "./useRovingListNav";

/**
 * Roving-tabindex props for a single row, spread-friendly for the row element.
 * The `ref` is passed separately (React reserves `ref`); everything else can be
 * spread onto the row.
 */
export interface FlatRovingItemProps<E extends HTMLElement> {
  /** Wires the row into the roving-nav focus tracking. */
  ref: (el: E | null) => void;
  /** `0` for the active row, `-1` for the rest (roving-tabindex). */
  tabIndex: number;
  /** Sync the roving active index when the row gains DOM focus (Tab/click). */
  onFocus: () => void;
  /** Tree row semantics — the list container carries `role="tree"`. */
  role: "treeitem";
  /** Flat list, so every row is a top-level tree node. */
  "aria-level": number;
}

/** Public surface of {@link useFlatRovingNav}. */
export interface FlatRovingNav<E extends HTMLElement> {
  /** Roving-tabindex active index into the items array. */
  activeIndex: number;
  /**
   * Keyboard handler for the list container that wraps the roving rows. Covers
   * arrow/Home/End movement, Enter to activate, and type-ahead jumping.
   */
  onKeyDown: (e: React.KeyboardEvent) => void;
  /** Roving-tabindex props (ref, tabIndex, onFocus) for the row at `index`. */
  getItemProps: (index: number) => FlatRovingItemProps<E>;
}

/**
 * Roving-tabindex keyboard navigation for a **flat, single-select** sidebar
 * list (Tunnels, Workspaces, …). A thin adapter over {@link useRovingListNav}
 * that fills in the multi-select/tree callbacks with no-ops so the caller only
 * has to supply an `onActivate` (Enter / activation) handler.
 *
 * Wire it up by spreading {@link FlatRovingNav.getItemProps} onto each row and
 * attaching {@link FlatRovingNav.onKeyDown} to the row container. Arrow keys move
 * focus, Enter activates, and printable characters type-ahead by label.
 *
 * @param items - Rows in display order (the single source of order for both the
 *   rendered rows and keyboard navigation).
 * @param getLabel - Extracts the type-ahead label (usually the display name).
 * @param onActivate - Invoked for Enter on the focused row.
 */
export function useFlatRovingNav<T, E extends HTMLElement = HTMLElement>(
  items: T[],
  getLabel: (item: T) => string,
  onActivate: (item: T, index: number) => void
): FlatRovingNav<E> {
  const { activeIndex, setActiveIndex, getRowRef, makeKeyDownHandler } = useRovingListNav<T, E>(
    items,
    getLabel
  );

  // A flat single-select list uses none of the tree/multi-select callbacks;
  // only Enter activation is meaningful here.
  const onKeyDown = useMemo(
    () =>
      makeKeyDownHandler({
        onActivate,
        onNavigateUp: () => {},
        onRename: () => {},
        onSelectAll: () => {},
        onClearSelection: () => {},
        getAnchorIndex: () => -1,
        onSelectRange: () => {},
        onSelectSingle: () => {},
      }),
    [makeKeyDownHandler, onActivate]
  );

  const getItemProps = useCallback(
    (index: number): FlatRovingItemProps<E> => ({
      ref: getRowRef(index),
      tabIndex: index === activeIndex ? 0 : -1,
      onFocus: () => setActiveIndex(index),
      role: "treeitem",
      "aria-level": 1,
    }),
    [getRowRef, activeIndex, setActiveIndex]
  );

  return { activeIndex, onKeyDown, getItemProps };
}
