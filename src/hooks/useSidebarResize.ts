/**
 * Hook for horizontal drag-to-resize of the sidebar.
 *
 * Returns the current sidebar width, a ref for the resize handle,
 * and whether a drag is in progress.
 */

import { useCallback, useRef, useState, useEffect } from "react";
import { useAppStore } from "@/store/appStore";

const MIN_WIDTH = 170;
const MAX_WIDTH = 600;

interface UseSidebarResizeResult {
  /** Current sidebar width in pixels. */
  sidebarWidth: number;
  /** Props to spread on the resize handle element. */
  handleProps: {
    onMouseDown: React.MouseEventHandler;
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
      const newWidth = Math.min(
        MAX_WIDTH,
        Math.max(MIN_WIDTH, state.startWidth + deltaX * direction)
      );
      setSidebarWidth(newWidth);
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

  // Cleanup listeners on unmount.
  useEffect(() => {
    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [handleMouseMove, handleMouseUp]);

  return {
    sidebarWidth,
    handleProps: { onMouseDown: handleMouseDown },
    isResizing,
  };
}
