import { t, tf } from "@/i18n/catalog";
import type { HttpMonitorState } from "@/types/network";
import type { HostChoice } from "@/utils/hostChoice";
import { monitorServiceState, serviceStateLabel } from "@/utils/serviceState";
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
): { kind: "stopped" | "paused" | "overdue" | "down" | "state"; label: string } | null {
  const { running, paused, lastResult, config } = monitor;
  // On an agent: not reachable, stopping, starting or failed, and why (#6052).
  const state = monitorServiceState(monitor);
  if (state !== "running" && state !== "stopped") {
    // The word; the reason has its own line, with its next step (F-009).
    return { kind: "state", label: serviceStateLabel(state) };
  }
  if (!running) return { kind: "stopped", label: t("monitor.marker.stopped") };
  if (paused) return { kind: "paused", label: t("monitor.marker.paused") };
  if (!lastResult) return null;
  if (isMonitorStale(lastResult.timestampMs, config.intervalMs, now)) {
    return { kind: "overdue", label: t("monitor.marker.overdue") };
  }
  return lastResult.ok ? null : { kind: "down", label: t("monitor.marker.down") };
}

/** What a monitor row offers to run now (F-009), as a Services row does. */
export interface MonitorRunActions {
  pause: boolean;
  /** Start it again: a stopped, paused or failed one. */
  resume: boolean;
  stop: boolean;
}

/**
 * The run actions of `monitor` on `host`. Stopping offers none (it was
 * pressed); not reachable only Stop; one whose machine cannot be read never
 * starts again, it would fail the same way.
 */
export function monitorRunActions(monitor: HttpMonitorState, host: HostChoice): MonitorRunActions {
  const state = monitorServiceState(monitor);
  const runs = state === "running";
  return {
    pause: runs && !monitor.paused,
    resume:
      (runs && monitor.paused) ||
      ((state === "stopped" || state === "error") && host.kind !== "unreadable"),
    stop: runs || state === "starting" || state === "notReachable",
  };
}

/** A next step a monitor's reason comes with. */
export interface MonitorNextStep {
  id: "connectAgent" | "setUpAgain";
  label: string;
}

/**
 * What helps with why `monitor` does not check (F-009): connect its agent when
 * that is offline, or set it up again when termiHub cannot read where it runs.
 */
export function monitorNextSteps(
  monitor: HttpMonitorState,
  host: HostChoice,
  agentConnected: boolean
): MonitorNextStep[] {
  const state = monitorServiceState(monitor);
  if (host.kind === "unreadable" && state !== "running") {
    return [{ id: "setUpAgain", label: t("monitor.next.setUpAgain") }];
  }
  if (host.kind === "agent" && state === "notReachable" && !agentConnected) {
    return [{ id: "connectAgent", label: t("service.next.connectAgent") }];
  }
  return [];
}

/**
 * The monitor row's tooltip lines (#5789): the URL (when the row shows a
 * name instead), how it checks, and the latest reading with its age. The
 * row itself shows only the name, the description and a marker that needs
 * attention. See docs/copy-style.md -> "List rows".
 */
export function monitorRowTooltip(
  monitor: HttpMonitorState,
  now: number,
  runsOn?: string
): string[] {
  const { config, lastResult } = monitor;
  const out: string[] = [];
  if (config.name?.trim()) out.push(config.url);
  // Where it checks from, when that is not this computer (#6039).
  if (runsOn) out.push(tf("monitor.tooltip.runsOn", { machine: runsOn }));
  // Why it does not check now, in full (#6052).
  if (monitor.reason) out.push(monitor.reason);
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
