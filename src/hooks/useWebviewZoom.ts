import { useEffect } from "react";
import { useAppStore } from "@/store/appStore";

/**
 * Applies the store's zoomLevel as CSS zoom on the root element.
 *
 * CSS zoom keeps all DOM coordinate APIs (event.clientX/Y, getBoundingClientRect)
 * in a consistent space, which is required for Radix UI context menus and
 * dnd-kit drag detection to work correctly at all zoom levels.
 */
export function useWebviewZoom() {
  const zoomLevel = useAppStore((s) => s.zoomLevel);

  useEffect(() => {
    document.documentElement.style.zoom = zoomLevel === 1 ? "" : String(zoomLevel);
    return () => {
      document.documentElement.style.zoom = "";
    };
  }, [zoomLevel]);
}
