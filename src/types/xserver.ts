/**
 * Types for the shared X server that termiHub manages (or adopts) for X11
 * forwarding. The backend tracks exactly one server at a time, so the UI shows
 * either zero or one server.
 */

/**
 * Lifecycle state of the shared X server.
 *
 * - `absent` — no X server is running or known.
 * - `adopted` — an external X server (not started by termiHub) is in use.
 * - `running` — a termiHub-managed X server is running.
 * - `failed` — the managed X server failed to start or crashed.
 */
export type XServerState = "absent" | "adopted" | "running" | "failed";

/** Platform the X server report was produced on. */
export type XServerPlatform = "windows" | "macOs" | "linux";

/**
 * Snapshot of the shared X server status as reported by the backend
 * (`x_server_status`). Optional fields are omitted when the backend has no
 * value (serialized from `Option::None`).
 */
export interface XServerStatusReport {
  /** Current lifecycle state of the server. */
  state: XServerState;
  /** Platform the report was produced on. */
  platform: XServerPlatform;
  /** X display number the server listens on (e.g. `0` for `:0`). */
  displayNumber?: number;
  /** Whether termiHub started and manages this server. */
  managed: boolean;
  /** Whether the platform dependency (e.g. VcXsrv) is installed. */
  dependencyAvailable?: boolean;
  /** Human-readable status detail, if any. */
  message?: string;
}

/**
 * Progress update emitted while the managed X server is being provisioned or
 * started. Reserved for later PRs (deploy/start flows).
 */
export interface XServerProgress {
  /** Machine-readable identifier for the current step. */
  step: string;
  /** Human-readable description of the current step. */
  message: string;
  /** Completion fraction in the range `0`–`1`. */
  progress: number;
}
