/**
 * Hook for horizontal resizing of the sidebar, by pointer drag or keyboard.
 *
 * Returns the current sidebar width, the props for the resize handle,
 * and whether a drag is in progress.
 */

import { useCallback, useRef, useState, useEffect } from "react";
import { useAppStore } from "@/store/appStore";

const MIN_WIDTH = 170;
const MAX_WIDTH = 600;
/** Pixels one arrow-key press moves the sidebar edge (A11Y2-003, #4329). */
export const SIDEBAR_KEYBOARD_STEP = 16;

const clampWidth = (width: number) => Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, width));

interface UseSidebarResizeResult {
  /** Current sidebar width in pixels. */
  sidebarWidth: number;
  /**
   * Props to spread on the resize handle element: pointer drag plus a focusable
   * `role="separator"` that ArrowLeft/ArrowRight/Home/End resize (#4329).
   */
  handleProps: {
    onMouseDown: React.MouseEventHandler;
    onKeyDown: React.KeyboardEventHandler;
    role: "separator";
    tabIndex: 0;
    "aria-orientation": "vertical";
    "aria-label": string;
    "aria-valuenow": number;
    "aria-valuemin": number;
    "aria-valuemax": number;
  };
  /** Whether a resize drag is currently active. */
  isResizing: boolean;
}

/**
 * Manages horizontal drag-to-resize for the sidebar.
 *
 * @param sidebarPosition Whether the sidebar is on the "left" or "right".
 */
export function useSidebarResize(sidebarPosition: "left" | "right"): UseSidebarResizeResult {
  const sidebarWidth = useAppStore((s) => s.sidebarWidth);
  const setSidebarWidth = useAppStore((s) => s.setSidebarWidth);
  const [isResizing, setIsResizing] = useState(false);

  const dragRef = useRef<{
    startX: number;
    startWidth: number;
  } | null>(null);

  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      const state = dragRef.current;
      if (!state) return;

      const deltaX = e.clientX - state.startX;
      // When sidebar is on the right, dragging left (negative delta) should widen it.
      const direction = sidebarPosition === "left" ? 1 : -1;
      setSidebarWidth(clampWidth(state.startWidth + deltaX * direction));
    },
    [sidebarPosition, setSidebarWidth]
  );

  const handleMouseUp = useCallback(() => {
    dragRef.current = null;
    setIsResizing(false);
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
    document.removeEventListener("mousemove", handleMouseMove);
    document.removeEventListener("mouseup", handleMouseUp);
  }, [handleMouseMove]);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      dragRef.current = {
        startX: e.clientX,
        startWidth: sidebarWidth,
      };
      setIsResizing(true);
      document.body.style.userSelect = "none";
      document.body.style.cursor = "col-resize";
      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
    },
    [sidebarWidth, handleMouseMove, handleMouseUp]
  );

  // Keyboard resizing (A11Y2-003, #4329). Arrows move the handle the way they
  // point, so with the sidebar on the right ArrowLeft widens it.
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const direction = sidebarPosition === "left" ? 1 : -1;
      let next: number;
      if (e.key === "ArrowRight") next = sidebarWidth + SIDEBAR_KEYBOARD_STEP * direction;
      else if (e.key === "ArrowLeft") next = sidebarWidth - SIDEBAR_KEYBOARD_STEP * direction;
      else if (e.key === "Home") next = MIN_WIDTH;
      else if (e.key === "End") next = MAX_WIDTH;
      else return;
      e.preventDefault();
      setSidebarWidth(clampWidth(next));
    },
    [sidebarPosition, sidebarWidth, setSidebarWidth]
  );

  // Cleanup listeners on unmount.
  useEffect(() => {
    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [handleMouseMove, handleMouseUp]);

  return {
    sidebarWidth,
    handleProps: {
      onMouseDown: handleMouseDown,
      onKeyDown: handleKeyDown,
      role: "separator",
      tabIndex: 0,
      "aria-orientation": "vertical",
      "aria-label": "Resize sidebar",
      "aria-valuenow": clampWidth(sidebarWidth),
      "aria-valuemin": MIN_WIDTH,
      "aria-valuemax": MAX_WIDTH,
    },
    isResizing,
  };
}
