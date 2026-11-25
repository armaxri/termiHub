/**
 * The nine states of a service (#6028): one set of words, dots and run buttons
 * for tunnels and file servers, so a state reads the same wherever it is shown.
 * See docs/concepts/backlog/services.html, "States and actions".
 *
 * The row says what the service *is*, not what termiHub hopes: an agent-hosted
 * service whose agent is gone is "Not reachable", never "Running".
 */
import type { StatusTone } from "@/components/ui";
import { t, type MessageId } from "@/i18n/catalog";
import type { ServerStatus } from "@/types/embeddedServer";
import type { TunnelStatus } from "@/types/tunnel";

export type ServiceState =
  | "stopped"
  | "waiting"
  | "starting"
  | "running"
  | "reconnecting"
  | "stopping"
  | "error"
  | "needsConnection"
  | "notReachable";

/** What the row's run button does; `null` when there is nothing to run. */
export type ServiceRunAction = "start" | "stop" | "stopWaiting" | "retry";

interface ServiceStateInfo {
  label: MessageId;
  tone: StatusTone;
  pulse?: boolean;
  hollow?: boolean;
  run: ServiceRunAction | null;
  /** The row says what it waits for, or why it is not running. */
  saysWhy?: boolean;
  /** Something may be open, so it is not simply off. */
  active?: boolean;
}

const STATES: Record<ServiceState, ServiceStateInfo> = {
  stopped: { label: "service.state.stopped", tone: "neutral", run: "start" },
  waiting: { label: "service.state.waiting", tone: "warning", run: "stopWaiting", saysWhy: true },
  starting: {
    label: "service.state.starting",
    tone: "warning",
    pulse: true,
    run: "stop",
    active: true,
  },
  running: { label: "service.state.running", tone: "success", run: "stop", active: true },
  reconnecting: {
    label: "service.state.reconnecting",
    tone: "warning",
    pulse: true,
    run: "stop",
    saysWhy: true,
    active: true,
  },
  stopping: {
    label: "service.state.stopping",
    tone: "warning",
    run: "stop",
    saysWhy: true,
    active: true,
  },
  error: { label: "service.state.error", tone: "error", run: "retry", saysWhy: true },
  needsConnection: { label: "service.state.needsConnection", tone: "warning", run: null },
  notReachable: {
    label: "service.state.notReachable",
    tone: "warning",
    hollow: true,
    run: "stop",
    saysWhy: true,
    active: true,
  },
};

const TUNNEL_STATES: Record<TunnelStatus, ServiceState> = {
  disconnected: "stopped",
  waiting: "waiting",
  connecting: "starting",
  connected: "running",
  reconnecting: "reconnecting",
  stopping: "stopping",
  error: "error",
  missingConnection: "needsConnection",
  notReachable: "notReachable",
};

const SERVER_STATES: Record<ServerStatus, ServiceState> = {
  stopped: "stopped",
  waiting: "waiting",
  starting: "starting",
  running: "running",
  stopping: "stopping",
  error: "error",
  notReachable: "notReachable",
};

/** The state of a tunnel; one that has none yet is stopped. */
export function tunnelServiceState(status: TunnelStatus | undefined): ServiceState {
  return status ? TUNNEL_STATES[status] : "stopped";
}

/** The state of a file server; one that has none yet is stopped. */
export function serverServiceState(status: ServerStatus | undefined): ServiceState {
  return status ? SERVER_STATES[status] : "stopped";
}

/** The word for `state`: the dot's accessible name and tooltip. */
export function serviceStateLabel(state: ServiceState): string {
  return t(STATES[state].label);
}

/** Props of the row's status dot. */
export function serviceStateDot(state: ServiceState): {
  tone: StatusTone;
  pulse: boolean;
  hollow: boolean;
  label: string;
  title: string;
} {
  const { tone, pulse = false, hollow = false } = STATES[state];
  const label = serviceStateLabel(state);
  return { tone, pulse, hollow, label, title: label };
}

/** What the run button of a row in `state` does. */
export function serviceRunAction(state: ServiceState): ServiceRunAction | null {
  return STATES[state].run;
}

/** Whether a service in `state` may hold a port somewhere. */
export function isServiceActive(state: ServiceState): boolean {
  return STATES[state].active ?? false;
}

/** The line under the name that says why `state` is what it is, if any. */
export function serviceReason(state: ServiceState, reason: string | undefined): string | undefined {
  return STATES[state].saysWhy ? reason : undefined;
}
