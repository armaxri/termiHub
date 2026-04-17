import { useEffect, useRef, useState, type RefObject } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

/**
 * Listens for OS-level file drag-and-drop events (Finder, Explorer, etc.) over a
 * given container element. Returns isDragOver for visual feedback and calls onDrop
 * with the file paths when files are released inside the element's bounding rect.
 *
 * Position-based hit testing is used because Tauri intercepts OS file drops at the
 * native level before they reach the webview, so standard HTML5 drag events are
 * not fired for OS file drops across all platforms.
 */
export function useOsFileDrop(
  containerRef: RefObject<HTMLElement | null>,
  onDrop: (paths: string[]) => void
): { isDragOver: boolean } {
  const [isDragOver, setIsDragOver] = useState(false);
  const onDropRef = useRef(onDrop);
  onDropRef.current = onDrop;

  useEffect(() => {
    let unlisten: (() => void) | null = null;

    const isOver = (pos: { x: number; y: number } | undefined): boolean => {
      const el = containerRef.current;
      if (!pos || !el) return false;
      // DragDropEvent position is PhysicalPosition (device pixels); convert to logical CSS pixels.
      const logX = pos.x / window.devicePixelRatio;
      const logY = pos.y / window.devicePixelRatio;
      const rect = el.getBoundingClientRect();
      return logX >= rect.left && logX <= rect.right && logY >= rect.top && logY <= rect.bottom;
    };

    getCurrentWindow()
      .onDragDropEvent((event) => {
        const payload = event.payload;
        if (payload.type === "enter" || payload.type === "over") {
          setIsDragOver(isOver(payload.position));
        } else if (payload.type === "drop") {
          if (isOver(payload.position)) {
            setIsDragOver(false);
            onDropRef.current(payload.paths);
          } else {
            setIsDragOver(false);
          }
        } else {
          setIsDragOver(false);
        }
      })
      .then((fn) => {
        unlisten = fn;
      });

    return () => {
      if (unlisten) unlisten();
      setIsDragOver(false);
    };
  }, [containerRef]);

  return { isDragOver };
}
