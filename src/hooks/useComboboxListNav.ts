import { useCallback, useEffect, useId, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { isImeComposing } from "@/utils/imeComposition";

/** Options for {@link useComboboxListNav}. */
export interface UseComboboxListNavOptions<T> {
  /** The selectable options, in display (= keyboard navigation) order. */
  items: readonly T[];
  /** Called when an option is picked with Enter or a click. */
  onSelect: (item: T) => void;
  /**
   * Any value whose change re-targets the top option (typically the query).
   * Compared by identity, like an effect dependency.
   */
  resetKey?: unknown;
  /**
   * DOM id of the listbox. Defaults to a `useId()`-derived id. Option ids are
   * derived from it as `${listId}-opt-${key}`.
   */
  listId?: string;
  /**
   * Stable key of an option, used as the suffix of its DOM id. Defaults to the
   * option's index. Characters unsafe in a DOM id are replaced with `_`.
   */
  getItemKey?: (item: T, index: number) => string;
  /** Whether Home / End jump to the first / last option. Default `false`. */
  homeEnd?: boolean;
  /**
   * Called for any keydown the hook does not handle itself (after the IME
   * guard), e.g. a picker's Backspace-to-go-back.
   */
  onUnhandledKeyDown?: (event: ReactKeyboardEvent<HTMLElement>) => void;
}

/** Props to spread onto an option row. */
export interface ComboboxOptionProps {
  id: string;
  role: "option";
  "aria-selected": boolean;
  onMouseMove: () => void;
  onClick: () => void;
}

/** What {@link useComboboxListNav} returns. */
export interface ComboboxListNav<T> {
  /** Index of the active option, clamped into range; `-1` when there are none. */
  activeIndex: number;
  /** Move the active option (e.g. to reset it when switching sub-pickers). */
  setActiveIndex: (index: number) => void;
  /** The active option, or `undefined` when there are none. */
  activeItem: T | undefined;
  /** DOM id of the active option, for `aria-activedescendant`. */
  activeId: string | undefined;
  /** DOM id of the listbox, for `aria-controls`. */
  listId: string;
  /** DOM id of the option at `index`. */
  optionId: (index: number) => string;
  /** Keydown handler for the combobox input. */
  handleKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void;
  /**
   * The combobox ARIA wiring and keydown handler for the search input.
   * `aria-expanded` is left to the caller, whose semantics differ per picker.
   */
  inputProps: {
    role: "combobox";
    "aria-autocomplete": "list";
    "aria-controls": string;
    "aria-activedescendant": string | undefined;
    onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void;
  };
  /** Props for the listbox element. */
  listboxProps: { id: string; role: "listbox" };
  /** Props for the option row at `index`. */
  getOptionProps: (index: number) => ComboboxOptionProps;
}

/** Make a string safe to embed in a DOM id. */
function idPart(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_");
}

/**
 * Shared keyboard navigation for search pickers built on the WAI-ARIA combobox
 * pattern (#4517): DOM focus stays in a search input whose
 * `aria-activedescendant` points at the active option of a `role="listbox"`.
 *
 * Owns the active index (clamped when the list shrinks), ArrowUp/ArrowDown with
 * wrap-around, optional Home/End, Enter to pick, the IME-composition guard
 * (#3767), reset-to-top whenever `resetKey` changes, scrolling the active option
 * into view, and the listbox / option DOM ids. Hovering an option makes it
 * active and clicking it picks it.
 */
export function useComboboxListNav<T>({
  items,
  onSelect,
  resetKey,
  listId: listIdOption,
  getItemKey,
  homeEnd = false,
  onUnhandledKeyDown,
}: UseComboboxListNavOptions<T>): ComboboxListNav<T> {
  const generatedId = useId();
  const listId = listIdOption ?? `${generatedId}-listbox`;
  const [rawIndex, setActiveIndex] = useState(0);

  const count = items.length;
  const activeIndex = count === 0 ? -1 : Math.min(rawIndex, count - 1);
  const activeItem = activeIndex >= 0 ? items[activeIndex] : undefined;

  const optionId = useCallback(
    (index: number) => {
      const item = items[index];
      const key = getItemKey && item !== undefined ? getItemKey(item, index) : String(index);
      return `${listId}-opt-${idPart(key)}`;
    },
    [items, getItemKey, listId]
  );
  const activeId = activeIndex >= 0 ? optionId(activeIndex) : undefined;

  // A new query (or other reset trigger) re-targets the top option.
  useEffect(() => {
    setActiveIndex(0);
  }, [resetKey]);

  // Keep the active option scrolled into view while navigating by keyboard,
  // and when the results under it change.
  useEffect(() => {
    if (!activeId) return;
    // jsdom has no scrollIntoView, hence the optional call.
    document.getElementById(activeId)?.scrollIntoView?.({ block: "nearest" });
  }, [activeId, items]);

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>) => {
      if (isImeComposing(event)) return;
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveIndex((i) => (count === 0 ? 0 : (Math.min(i, count - 1) + 1) % count));
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveIndex((i) => (count === 0 ? 0 : (Math.min(i, count - 1) - 1 + count) % count));
      } else if (homeEnd && event.key === "Home") {
        event.preventDefault();
        setActiveIndex(0);
      } else if (homeEnd && event.key === "End") {
        event.preventDefault();
        setActiveIndex(Math.max(0, count - 1));
      } else if (event.key === "Enter") {
        event.preventDefault();
        if (activeItem !== undefined) onSelect(activeItem);
      } else {
        onUnhandledKeyDown?.(event);
      }
    },
    [count, homeEnd, activeItem, onSelect, onUnhandledKeyDown]
  );

  const getOptionProps = useCallback(
    (index: number): ComboboxOptionProps => ({
      id: optionId(index),
      role: "option",
      "aria-selected": index === activeIndex,
      onMouseMove: () => setActiveIndex(index),
      onClick: () => {
        const item = items[index];
        if (item !== undefined) onSelect(item);
      },
    }),
    [optionId, activeIndex, items, onSelect]
  );

  return {
    activeIndex,
    setActiveIndex,
    activeItem,
    activeId,
    listId,
    optionId,
    handleKeyDown,
    inputProps: {
      role: "combobox",
      "aria-autocomplete": "list",
      "aria-controls": listId,
      "aria-activedescendant": activeId,
      onKeyDown: handleKeyDown,
    },
    listboxProps: { id: listId, role: "listbox" },
    getOptionProps,
  };
}
