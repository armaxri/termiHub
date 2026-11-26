import { t, tf, type MessageId } from "@/i18n/catalog";
import type { HttpMonitorState } from "@/types/network";
import type { HostChoice } from "@/utils/hostChoice";
import { monitorServiceState } from "@/utils/serviceState";
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

/** The kinds of state word a monitor row shows (F-009 round 2). */
export type MonitorStateKind =
  | "up"
  | "checking"
  | "down"
  | "overdue"
  | "paused"
  | "stopped"
  | "agentOffline"
  | "stopping"
  | "starting"
  | "notStarted";

const WORDS: Record<MonitorStateKind, MessageId> = {
  up: "monitor.state.up",
  checking: "monitor.state.checking",
  down: "monitor.marker.down",
  overdue: "monitor.marker.overdue",
  paused: "monitor.marker.paused",
  stopped: "monitor.marker.stopped",
  agentOffline: "monitor.state.agentOffline",
  stopping: "service.state.stopping",
  starting: "service.state.starting",
  notStarted: "monitor.state.notStarted",
};

/**
 * The one word every monitor row shows for its state (F-009 round 2). A
 * monitor is about its site, so the state of its agent being gone is "Agent
 * offline", never "Not reachable", which would read as the site being down.
 */
export function monitorRowMarker(
  monitor: HttpMonitorState,
  now: number
): { kind: MonitorStateKind; label: string } {
  const kind = monitorStateKind(monitor, now);
  return { kind, label: t(WORDS[kind]) };
}

function monitorStateKind(monitor: HttpMonitorState, now: number): MonitorStateKind {
  const { running, paused, lastResult, config } = monitor;
  // On an agent: gone, stopping, starting or failed (#6052).
  switch (monitorServiceState(monitor)) {
    case "notReachable":
      return "agentOffline";
    case "stopping":
      return "stopping";
    case "starting":
      return "starting";
    case "error":
      return "notStarted";
    default:
      break;
  }
  if (!running) return "stopped";
  if (paused) return "paused";
  if (!lastResult) return "checking";
  if (isMonitorStale(lastResult.timestampMs, config.intervalMs, now)) return "overdue";
  return lastResult.ok ? "up" : "down";
}

/**
 * The last check in a few words (F-009 round 2): "HTTP 200, 12s ago", or why
 * it failed; nothing before the first check.
 */
export function monitorLastResult(monitor: HttpMonitorState, now: number): string | undefined {
  const last = monitor.lastResult;
  if (!last) return undefined;
  const age = formatCheckedAgo(last.timestampMs, now);
  if (last.ok || last.statusCode == null) {
    return last.ok || !last.error
      ? tf("monitor.last.status", { status: last.statusCode ?? "?", age })
      : tf("monitor.last.error", { error: last.error, age });
  }
  return tf("monitor.last.unexpected", {
    status: last.statusCode,
    expected: monitor.config.expectedStatus ?? 200,
    age,
  });
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
