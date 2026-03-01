/**
 * Hook for resizable sidebar sections.
 *
 * Manages flex ratios between expandable sections and provides
 * mouse-event handlers for drag-to-resize handles between them.
 */

import { useState, useCallback, useRef, useEffect } from "react";

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

interface UseSectionResizeResult {
  /** Flex-grow value for each expanded section. */
  flexValues: number[];
  /** Props to spread on the resize handle div at the given index. */
  handleProps: (index: number) => { onMouseDown: React.MouseEventHandler };
  /** Whether a resize drag is currently active. */
  isResizing: boolean;
  /** Refs to attach to each expanded section's DOM element. */
  sectionRefs: React.MutableRefObject<(HTMLDivElement | null)[]>;
}

const MIN_FLEX = 0.1;

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

    const newFlexAbove = Math.max(MIN_FLEX, state.startFlexAbove + flexDelta);
    const newFlexBelow = Math.max(MIN_FLEX, state.startFlexBelow - flexDelta);

    // Re-clamp: if one hit the minimum, the other absorbs the remainder.
    const clampedAbove = newFlexBelow <= MIN_FLEX ? totalFlex - MIN_FLEX : newFlexAbove;
    const clampedBelow = newFlexAbove <= MIN_FLEX ? totalFlex - MIN_FLEX : newFlexBelow;

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

  const handleProps = useCallback(
    (index: number) => ({
      onMouseDown: (e: React.MouseEvent) => startResize(e, index),
    }),
    [startResize]
  );

  return { flexValues, handleProps, isResizing, sectionRefs };
}
