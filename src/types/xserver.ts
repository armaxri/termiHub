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
  /**
   * Number of live X11-forwarding sessions currently depending on this server.
   * Drives the Open Connections "· N sessions" detail; `0` when idle or absent.
   */
  sessionCount: number;
  /** Human-readable status detail, if any. */
  message?: string;
}

/**
 * Progress update emitted while the managed X server is being provisioned or
 * started (the `x-server-progress` event, fired during `x_server_ensure`).
 */
export interface XServerProgress {
  /** Machine-readable identifier for the current step. */
  step: string;
  /** Human-readable description of the current step. */
  message: string;
  /**
   * Completion fraction in the range `0`–`1`, or `-1` for an indeterminate
   * step (render a looping/indeterminate progress bar).
   */
  progress: number;
}

/**
 * Machine-readable classification of an X server provisioning failure. Drives
 * how the setup dialog recovers: `dependencyMissing` offers an install action;
 * the rest offer a plain retry with the human-readable `message`.
 */
export type XServerErrorKind =
  | "provisioningUnavailable"
  | "noLocalServer"
  | "dependencyMissing"
  | "serverUnreachable"
  | "launchFailed"
  | "unsupported";

/**
 * Typed error rejected by `x_server_ensure` / `x_server_install_dependency`.
 * Serialized from the tagged Rust `XServerError`; optional fields are omitted
 * when the backend has no value. `dependencyMissing` carries the missing
 * `dependency` plus optional install guidance.
 */
export interface XServerError {
  /** Failure classification. */
  kind: XServerErrorKind;
  /** Human-readable failure detail. */
  message: string;
  /** Name of the missing dependency (only for `dependencyMissing`). */
  dependency?: string;
  /** Human-readable hint on how to install the dependency. */
  installHint?: string;
  /** A concrete shell command that installs the dependency, if available. */
  installCommand?: string;
}

/**
 * Type guard for {@link XServerError}: an object carrying a string `kind` and a
 * string `message`. Use to narrow the `unknown` a rejected Tauri command
 * surfaces before reading typed guidance.
 */
export function isXServerError(e: unknown): e is XServerError {
  return (
    typeof e === "object" &&
    e !== null &&
    typeof (e as { kind?: unknown }).kind === "string" &&
    typeof (e as { message?: unknown }).message === "string"
  );
}
