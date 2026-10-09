/**
 * Hook for resizable sidebar sections.
 *
 * Manages flex ratios between expandable sections and provides the
 * pointer-drag and keyboard handlers for the resize handles between them.
 */

import { useState, useCallback, useRef, useEffect, useMemo } from "react";

interface ResizeState {
  /** Index of the handle being dragged (between section i and i+1). */
  handleIndex: number;
  /** Mouse Y at drag start. */
  startY: number;
  /** Pixel heights of the two adjacent sections at drag start. */
  startHeightAbove: number;
  startHeightBelow: number;
  /** Flex values at drag start. */
  startFlexAbove: number;
  startFlexBelow: number;
}

/** Props for one section resize handle: pointer drag plus a keyboard separator (#4329). */
export interface SectionHandleProps {
  onMouseDown: React.MouseEventHandler;
  onKeyDown: React.KeyboardEventHandler;
  role: "separator";
  tabIndex: 0;
  "aria-orientation": "horizontal";
  "aria-label": string;
  /** The upper section's share of the pair, in percent. */
  "aria-valuenow": number;
  "aria-valuemin": number;
  "aria-valuemax": number;
}

interface UseSectionResizeResult {
  /** Flex-grow value for each expanded section. */
  flexValues: number[];
  /** Props to spread on the resize handle div at the given index. */
  handleProps: (index: number) => SectionHandleProps;
  /** Whether a resize drag is currently active. */
  isResizing: boolean;
  /** Refs to attach to each expanded section's DOM element. */
  sectionRefs: React.MutableRefObject<(HTMLDivElement | null)[]>;
}

const MIN_FLEX = 0.1;
/** Percent of the pair's height one arrow-key press moves the separator (#4329). */
export const SECTION_KEYBOARD_STEP_PERCENT = 5;

/**
 * Move `flexDelta` from the section below a handle to the one above it (a
 * negative delta moves it the other way), keeping both at least `MIN_FLEX`.
 */
function shiftFlex(above: number, below: number, flexDelta: number): [number, number] {
  const totalFlex = above + below;
  const newFlexAbove = Math.max(MIN_FLEX, above + flexDelta);
  const newFlexBelow = Math.max(MIN_FLEX, below - flexDelta);
  // Re-clamp: if one hit the minimum, the other absorbs the remainder.
  const clampedAbove = newFlexBelow <= MIN_FLEX ? totalFlex - MIN_FLEX : newFlexAbove;
  const clampedBelow = newFlexAbove <= MIN_FLEX ? totalFlex - MIN_FLEX : newFlexBelow;
  return [clampedAbove, clampedBelow];
}

/**
 * Manages drag-to-resize between sidebar sections.
 *
 * @param expandedCount Number of currently expanded sections.
 */
export function useSectionResize(expandedCount: number): UseSectionResizeResult {
  const [flexValues, setFlexValues] = useState<number[]>(() => Array(expandedCount).fill(1));
  const sectionRefs = useRef<(HTMLDivElement | null)[]>([]);
  const resizeRef = useRef<ResizeState | null>(null);
  const [isResizing, setIsResizing] = useState(false);

  // Reset flex values when the number of expanded sections changes.
  useEffect(() => {
    setFlexValues(Array(expandedCount).fill(1));
  }, [expandedCount]);

  const handleMouseMove = useCallback((e: MouseEvent) => {
    const state = resizeRef.current;
    if (!state) return;

    const deltaY = e.clientY - state.startY;
    const totalHeight = state.startHeightAbove + state.startHeightBelow;
    if (totalHeight === 0) return;

    const totalFlex = state.startFlexAbove + state.startFlexBelow;

    // Convert pixel delta to flex delta.
    const flexDelta = (deltaY / totalHeight) * totalFlex;

    const [clampedAbove, clampedBelow] = shiftFlex(
      state.startFlexAbove,
      state.startFlexBelow,
      flexDelta
    );

    setFlexValues((prev) => {
      const next = [...prev];
      next[state.handleIndex] = clampedAbove;
      next[state.handleIndex + 1] = clampedBelow;
      return next;
    });
  }, []);

  const handleMouseUp = useCallback(() => {
    resizeRef.current = null;
    setIsResizing(false);
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
    document.removeEventListener("mousemove", handleMouseMove);
    document.removeEventListener("mouseup", handleMouseUp);
  }, [handleMouseMove]);

  const startResize = useCallback(
    (e: React.MouseEvent, handleIndex: number) => {
      e.preventDefault();

      const above = sectionRefs.current[handleIndex];
      const below = sectionRefs.current[handleIndex + 1];
      if (!above || !below) return;

      resizeRef.current = {
        handleIndex,
        startY: e.clientY,
        startHeightAbove: above.getBoundingClientRect().height,
        startHeightBelow: below.getBoundingClientRect().height,
        startFlexAbove: flexValues[handleIndex] ?? 1,
        startFlexBelow: flexValues[handleIndex + 1] ?? 1,
      };

      setIsResizing(true);
      document.body.style.userSelect = "none";
      document.body.style.cursor = "ns-resize";
      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
    },
    [flexValues, handleMouseMove, handleMouseUp]
  );

  // Keyboard resizing (A11Y2-003, #4329): ArrowDown grows the section above
  // the handle, ArrowUp shrinks it, one step at a time.
  const resizeByKey = useCallback((e: React.KeyboardEvent, handleIndex: number) => {
    let sign: number;
    if (e.key === "ArrowDown") sign = 1;
    else if (e.key === "ArrowUp") sign = -1;
    else return;
    e.preventDefault();
    setFlexValues((prev) => {
      const above = prev[handleIndex] ?? 1;
      const below = prev[handleIndex + 1] ?? 1;
      const flexDelta = sign * (SECTION_KEYBOARD_STEP_PERCENT / 100) * (above + below);
      const next = [...prev];
      [next[handleIndex], next[handleIndex + 1]] = shiftFlex(above, below, flexDelta);
      return next;
    });
  }, []);

  const handleProps = useCallback(
    (index: number): SectionHandleProps => {
      const above = flexValues[index] ?? 1;
      const below = flexValues[index + 1] ?? 1;
      return {
        onMouseDown: (e: React.MouseEvent) => startResize(e, index),
        onKeyDown: (e: React.KeyboardEvent) => resizeByKey(e, index),
        role: "separator",
        tabIndex: 0,
        "aria-orientation": "horizontal",
        "aria-label": "Resize sidebar sections",
        "aria-valuenow": Math.round((above / (above + below)) * 100),
        "aria-valuemin": 0,
        "aria-valuemax": 100,
      };
    },
    [flexValues, startResize, resizeByKey]
  );

  // Cleanup on unmount: if the component unmounts mid-drag (before `mouseup`
  // fires — e.g. the sidebar is hidden or its section list rebuilt via a
  // keyboard shortcut), the document-level listeners would otherwise leak and
  // keep calling `setFlexValues` on an unmounted hook, and `document.body`
  // would stay stuck with `user-select: none` and a `ns-resize` cursor
  // app-wide. Mirror `useSidebarResize`'s cleanup here, and additionally clear
  // the stuck body styles when a drag was active.
  useEffect(() => {
    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      if (resizeRef.current) {
        resizeRef.current = null;
        document.body.style.userSelect = "";
        document.body.style.cursor = "";
      }
    };
  }, [handleMouseMove, handleMouseUp]);

  // Normalise the returned array to always be exactly `expandedCount` long,
  // defaulting any missing slot to an even `1`. `flexValues` state lags
  // `expandedCount` for one render whenever the section count grows (the reset
  // effect above runs only after that render): the desktop sidebar's Remote
  // Agents sections appear after settings + agents load asynchronously, so
  // without this guard a section reads `flexValues[i] === undefined` on that
  // transient render and lays out as `flex: 0 1 auto` (size-to-content) instead
  // of flex-filling its slot. On WebKit that mis-sized first paint sticks until
  // a manual resize forces a reflow — the #1828 glitch. Deriving the value at
  // render time keeps every paint correctly sized.
  const normalizedFlexValues = useMemo(
    () => Array.from({ length: expandedCount }, (_, i) => flexValues[i] ?? 1),
    [flexValues, expandedCount]
  );

  return { flexValues: normalizedFlexValues, handleProps, isResizing, sectionRefs };
}
