import { t, tf } from "@/i18n/catalog";
import type { HttpMonitorState } from "@/types/network";
import { formatCheckedAgo, isMonitorStale } from "./monitorStaleness";

/** The URL as a row shows it when the monitor has no name: without its scheme. */
function shortMonitorUrl(url: string): string {
  return url.replace(/^https?:\/\//, "");
}

/**
 * The monitor row's name (#5789): the name the user gave it, or else its URL
 * without the scheme.
 */
export function monitorRowName(monitor: HttpMonitorState): string {
  return monitor.config.name?.trim() || shortMonitorUrl(monitor.config.url);
}

/**
 * The state marker a monitor row shows (#5789), only when the state needs
 * attention: stopped, paused, overdue or down. An up or still-checking
 * monitor has none; its dot says so.
 */
export function monitorRowMarker(
  monitor: HttpMonitorState,
  now: number
): { kind: "stopped" | "paused" | "overdue" | "down"; label: string } | null {
  const { running, paused, lastResult, config } = monitor;
  if (!running) return { kind: "stopped", label: t("monitor.marker.stopped") };
  if (paused) return { kind: "paused", label: t("monitor.marker.paused") };
  if (!lastResult) return null;
  if (isMonitorStale(lastResult.timestampMs, config.intervalMs, now)) {
    return { kind: "overdue", label: t("monitor.marker.overdue") };
  }
  return lastResult.ok ? null : { kind: "down", label: t("monitor.marker.down") };
}

/**
 * The monitor row's tooltip lines (#5789): the URL (when the row shows a
 * name instead), how it checks, and the latest reading with its age. The
 * row itself shows only the name, the description and a marker that needs
 * attention. See docs/copy-style.md -> "List rows".
 */
export function monitorRowTooltip(monitor: HttpMonitorState, now: number): string[] {
  const { config, lastResult } = monitor;
  const out: string[] = [];
  if (config.name?.trim()) out.push(config.url);
  out.push(
    tf("monitor.tooltip.check", {
      method: config.method,
      interval: `${Math.round(config.intervalMs / 1000)}s`,
      status: config.expectedStatus,
    })
  );
  if (lastResult) {
    const age = formatCheckedAgo(lastResult.timestampMs, now);
    if (lastResult.ok) {
      out.push(
        tf("monitor.tooltip.lastOk", {
          status: lastResult.statusCode ?? "?",
          latency: lastResult.latencyMs ?? "?",
          age,
        })
      );
    } else {
      out.push(
        lastResult.error
          ? tf("monitor.tooltip.lastDownError", { age, error: lastResult.error })
          : tf("monitor.tooltip.lastDown", { age })
      );
    }
  }
  return out;
}
