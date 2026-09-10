import type { PersistentRunState } from "@/types/connection";
import type { ServerStatus } from "@/types/embeddedServer";

/**
 * Screen-reader-facing labels for the various colour-coded status dots across
 * the app. Centralised so the state→label mapping stays consistent and every
 * status dot can expose a non-colour text alternative for assistive technology
 * (WCAG 1.4.1 Use of Color / 1.1.1 Non-text Content). See A11Y-003 / A11Y-004.
 */

/** Connection-style states shared by remote agents and SSH tunnels. */
export type ConnectionDotState =
  | "connected"
  | "connecting"
  | "reconnecting"
  | "disconnected"
  | "error";

const CONNECTION_STATE_LABELS: Record<ConnectionDotState, string> = {
  connected: "Connected",
  connecting: "Connecting",
  reconnecting: "Reconnecting",
  disconnected: "Disconnected",
  error: "Error",
};

/**
 * Human-readable label for a connection state (remote agents, SSH tunnels).
 * Falls back to the raw value for any unexpected state so nothing is ever blank.
 */
export function connectionStateLabel(state: string): string {
  return CONNECTION_STATE_LABELS[state as ConnectionDotState] ?? state;
}

const RUN_STATE_LABELS: Record<PersistentRunState, string> = {
  stopped: "Stopped",
  starting: "Starting",
  running: "Running",
  attached: "Attached",
  stopping: "Stopping",
  error: "Error",
};

/**
 * Human-readable label for a persistent-session run-state. A `null` run-state
 * (never started) is reported as "Stopped".
 */
export function persistentRunStateLabel(state: PersistentRunState | null): string {
  return state ? RUN_STATE_LABELS[state] : "Stopped";
}

const SERVER_STATUS_LABELS: Record<ServerStatus, string> = {
  stopped: "Stopped",
  starting: "Starting",
  running: "Running",
  stopping: "Stopping",
  error: "Error",
};

/**
 * Human-readable label for an embedded-server status. An `undefined` status
 * (never started) is reported as "Stopped".
 */
export function serverStatusLabel(status: ServerStatus | undefined): string {
  return status ? SERVER_STATUS_LABELS[status] : "Stopped";
}
