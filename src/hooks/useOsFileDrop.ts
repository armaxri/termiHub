import { useEffect, useRef, useState, type RefObject } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isOwnDragOut } from "@/utils/fileDragOut";
import { getPlatform, type Platform } from "@/utils/platform";
import { subscribeGuarded } from "./useTauriListener";

/**
 * Converts a Tauri drag-drop `position` to CSS pixels in the webview (#4997).
 *
 * Tauri types the position as a `PhysicalPosition`, but wry passes on whatever
 * the native layer reports, and only Windows reports device pixels:
 * - Windows (WebView2): `ScreenToClient` on the per-monitor-DPI-aware window
 *   gives device pixels, so divide by `devicePixelRatio`.
 * - Linux (WebKitGTK): GTK's `drag-motion` / `drag-drop` widget coordinates
 *   are already logical (scaled by `GDK_SCALE`), i.e. CSS pixels.
 * - macOS (WKWebView): AppKit's `draggingLocation` is in points, i.e. CSS pixels.
 *
 * Dividing everywhere put a drop on a scaled Linux or macOS display at half its
 * real coordinates, into whatever pane sat nearer the window origin.
 */
export function dropPositionToCss(
  position: { x: number; y: number },
  platform: Platform = getPlatform(),
  devicePixelRatio: number = window.devicePixelRatio
): { x: number; y: number } {
  const scale = platform === "windows" && devicePixelRatio > 0 ? devicePixelRatio : 1;
  return { x: position.x / scale, y: position.y / scale };
}

/**
 * Listens for OS-level file drag-and-drop events (Finder, Explorer, etc.) over a
 * given container element. Returns isDragOver for visual feedback and calls onDrop
 * with the file paths when files are released inside the element's bounding rect.
 *
 * Position-based hit testing is used because Tauri intercepts OS file drops at the
 * native level before they reach the webview, so standard HTML5 drag events are
 * not fired for OS file drops across all platforms.
 *
 * The window's own native drag-out (#3457) is ignored, so a row dragged out and
 * released back over termiHub is not re-uploaded / copied into the browser.
 *
 * `dragPaths` holds the dragged OS paths while a drag is in progress (from the
 * `enter` event), so a drop target can name what it would receive (#4192).
 */
export function useOsFileDrop(
  containerRef: RefObject<HTMLElement | null>,
  onDrop: (paths: string[]) => void
): { isDragOver: boolean; dragPaths: string[] } {
  const [isDragOver, setIsDragOver] = useState(false);
  const [dragPaths, setDragPaths] = useState<string[]>([]);
  const onDropRef = useRef(onDrop);
  onDropRef.current = onDrop;

  useEffect(() => {
    let ownDrag = false;
    let active = true;

    const isOver = (pos: { x: number; y: number } | undefined): boolean => {
      const el = containerRef.current;
      if (!pos || !el) return false;
      const { x, y } = dropPositionToCss(pos);
      const rect = el.getBoundingClientRect();
      return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
    };

    // Disposed guard (FES2-005): an unmount before registration resolves still
    // unregisters the listener once it does.
    const dispose = subscribeGuarded(
      () =>
        getCurrentWindow().onDragDropEvent((event) => {
          if (!active) return;
          const payload = event.payload;
          // A row this window is dragging out to the OS (#3457) passing back over
          // termiHub is not an upload: never highlight it or re-import it here.
          if (payload.type === "enter") {
            ownDrag = isOwnDragOut(payload.paths);
            setDragPaths(ownDrag ? [] : payload.paths);
          }
          if (payload.type === "drop" && isOwnDragOut(payload.paths)) ownDrag = true;
          if (ownDrag) {
            setIsDragOver(false);
            if (payload.type === "drop" || payload.type === "leave") ownDrag = false;
            return;
          }
          if (payload.type === "enter" || payload.type === "over") {
            // Drag "over" fires continuously while the cursor moves; only re-render
            // when this element's hover state actually flips. With one listener per
            // pane this avoids redundant updates across every pane on every event.
            const over = isOver(payload.position);
            setIsDragOver((prev) => (prev === over ? prev : over));
          } else if (payload.type === "drop") {
            setDragPaths([]);
            if (isOver(payload.position)) {
              setIsDragOver(false);
              onDropRef.current(payload.paths);
            } else {
              setIsDragOver(false);
            }
          } else {
            setIsDragOver(false);
            setDragPaths([]);
          }
        }),
      "os_file_drop",
      "drag-drop events"
    );

    return () => {
      active = false;
      dispose();
      setIsDragOver(false);
      setDragPaths([]);
    };
  }, [containerRef]);

  return { isDragOver, dragPaths };
}
