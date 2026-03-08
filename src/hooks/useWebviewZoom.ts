import { useEffect } from "react";
import { useAppStore } from "@/store/appStore";
import { frontendLog } from "@/utils/frontendLog";

/**
 * Applies the store's zoomLevel to the Tauri webview.
 * Falls back gracefully when not running inside Tauri.
 */
export function useWebviewZoom() {
  const zoomLevel = useAppStore((s) => s.zoomLevel);

  useEffect(() => {
    let canceled = false;

    (async () => {
      try {
        const { getCurrentWebview } = await import("@tauri-apps/api/webview");
        if (canceled) return;
        await getCurrentWebview().setZoom(zoomLevel);
      } catch (err) {
        frontendLog("zoom", `Failed to set webview zoom: ${err}`);
      }
    })();

    return () => {
      canceled = true;
    };
  }, [zoomLevel]);
}
