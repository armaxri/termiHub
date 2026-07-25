import { useEffect, useMemo, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { listWindows } from "@/services/api";
import { windowDisplayName } from "@/utils/windowPicker";
import { MAIN_WINDOW_LABEL } from "@/types/window";
import { frontendLog } from "@/utils/frontendLog";

/** The current window's identity and the live count of open windows (#1902). */
export interface WindowInfoState {
  /** This window's runtime label (`main`, `win-1`, …). */
  label: string;
  /** Human-readable name, e.g. "Main Window" / "Window 2". */
  name: string;
  /** Number of native windows currently open (>= 1). */
  count: number;
}

/**
 * Track this window's identity and how many windows are open, sourced from the
 * backend window registry (#1900) — stores are not shared across native windows,
 * so the count cannot come from the frontend store.
 *
 * Refreshes on the backend `windows-changed` event (emitted when a window opens
 * or is destroyed) and once on mount. Failures leave the count at its last known
 * value; the status-bar affordance simply stays hidden until a successful read.
 */
export function useWindowInfo(): WindowInfoState {
  const label = useMemo(() => {
    try {
      return getCurrentWindow().label;
    } catch {
      return MAIN_WINDOW_LABEL;
    }
  }, []);

  const [count, setCount] = useState(1);

  useEffect(() => {
    let active = true;

    const refresh = async () => {
      try {
        const windows = await listWindows();
        if (active && Array.isArray(windows) && windows.length > 0) {
          setCount(windows.length);
        }
      } catch (err) {
        frontendLog("multi_window", `useWindowInfo listWindows failed: ${String(err)}`);
      }
    };

    void refresh();

    const unlistenPromise = listen<void>("windows-changed", () => {
      void refresh();
    });

    return () => {
      active = false;
      void unlistenPromise.then((fn) => fn());
    };
  }, []);

  return { label, name: windowDisplayName(label), count };
}
