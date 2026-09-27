import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { remoteDesktopSetMonitorLayout } from "@/services/api";
import { useAppStore } from "@/store/appStore";
import type { MonitorRect } from "@/types/remoteDesktop";
import {
  layoutFromLocalDisplays,
  readLocalDisplays,
  sameLayout,
} from "@/components/RemoteDesktop/monitorLayout";
import { backendErrorMessage } from "@/utils/backendErrorCode";
import { frontendLog } from "@/utils/frontendLog";

/**
 * Keep an "all local displays" multi-monitor session (#3696) in step with the
 * local display set: whenever this window regains focus — the natural moment
 * after plugging in or unplugging a display — re-read the local displays and,
 * if the layout changed, send it to the remote (RDP Display Control / VNC
 * SetDesktopSize).
 *
 * @param sessionId the live session, or null.
 * @param enabled whether the session uses the "all local displays" mode.
 * @param connectLayout the layout the session was opened with, if any.
 * @returns a counter bumped after every applied change, so the tab re-reads
 *   the session's monitors even when the combined size stayed the same.
 */
export function useMonitorLayoutRefresh(
  sessionId: string | null,
  enabled: boolean,
  connectLayout: MonitorRect[] | null
): number {
  const [version, setVersion] = useState(0);
  // The layout the remote last received: the connect-time one, then each
  // applied change.
  const lastRef = useRef<MonitorRect[] | null>(connectLayout);
  useEffect(() => {
    lastRef.current = connectLayout;
  }, [connectLayout]);

  useEffect(() => {
    if (!sessionId || !enabled) return;
    let disposed = false;
    const refresh = async () => {
      const { displays, primary } = await readLocalDisplays();
      const layout = layoutFromLocalDisplays(displays, primary);
      const last = lastRef.current;
      if (disposed || layout.length < 2 || (last && sameLayout(last, layout))) return;
      if (useAppStore.getState().isSessionWindowEvicted(sessionId)) return;
      try {
        await remoteDesktopSetMonitorLayout(sessionId, layout);
        lastRef.current = layout;
        if (!disposed) setVersion((v) => v + 1);
        frontendLog("remote_desktop", `monitor layout of ${sessionId} now ${layout.length}`);
      } catch (err) {
        frontendLog("remote_desktop", `set_monitor_layout failed: ${backendErrorMessage(err)}`);
      }
    };
    const unlisten = getCurrentWindow().onFocusChanged(({ payload: focused }) => {
      if (focused) void refresh();
    });
    return () => {
      disposed = true;
      void unlisten.then((fn) => fn());
    };
  }, [sessionId, enabled]);

  return version;
}
