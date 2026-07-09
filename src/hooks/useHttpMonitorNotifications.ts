import { useEffect } from "react";
import { onHttpMonitorCheck } from "@/services/networkApi";
import { toast } from "@/components/ui";
import type { HttpCheckResult } from "@/types/network";
import { frontendLog } from "@/utils/frontendLog";

/**
 * Global hook that surfaces HTTP monitor up/down transitions as toasts.
 *
 * The `network-http-monitor-check` event is broadcast on every poll, but nothing
 * previously diffed the previous vs. current `ok` state — so an endpoint going
 * down (or recovering) was silent unless the Network Tools sidebar/panel happened
 * to be on-screen. This hook is mounted once at the app root, tracks the last
 * known `ok` per monitor id, and fires a toast only on the *edge*:
 *
 * - up → down: `toast.error`
 * - down → up: `toast.success`
 *
 * The very first result for a monitor establishes a baseline and never toasts
 * (there is no previous state to diff against). Steady-state polls (up→up,
 * down→down) are silent, so a persistently-down endpoint is reported once, not
 * on every interval.
 */
export function useHttpMonitorNotifications(): void {
  useEffect(() => {
    // Previous `ok` per monitor id. Not React state: the value is only read
    // inside the event callback and must never trigger a re-render.
    const previousOk = new Map<string, boolean>();
    let unlisten: (() => void) | null = null;
    let disposed = false;

    onHttpMonitorCheck((result: HttpCheckResult) => {
      const prev = previousOk.get(result.monitorId);
      previousOk.set(result.monitorId, result.ok);

      // No baseline yet — record it and stay silent.
      if (prev === undefined || prev === result.ok) return;

      if (!result.ok) {
        const detail =
          result.error ?? (result.statusCode ? `HTTP ${result.statusCode}` : "no response");
        frontendLog("http_monitor_notify", `monitor ${result.monitorId} went DOWN: ${detail}`);
        toast.error(`Monitor down: ${detail}`);
      } else {
        const detail = result.statusCode ? `HTTP ${result.statusCode}` : "OK";
        frontendLog("http_monitor_notify", `monitor ${result.monitorId} recovered: ${detail}`);
        toast.success(`Monitor recovered: ${detail}`);
      }
    })
      .then((fn) => {
        if (disposed) {
          fn();
        } else {
          unlisten = fn;
        }
      })
      .catch((err) => frontendLog("http_monitor_notify", `Failed to subscribe to checks: ${err}`));

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
}
