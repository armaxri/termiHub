/**
 * Types for the shared X server that termiHub manages (or adopts) for X11
 * forwarding. The backend tracks exactly one server at a time, so the UI shows
 * either zero or one server.
 */

// The X server status/progress/consent DTOs are generated from their Rust source
// of truth (`src-tauri/src/terminal/xserver/types.rs`) via ts-rs (audit DUP-030,
// ts-rs rollout #3088).
export type { XServerStatusReport } from "./generated/XServerStatusReport";
export type { XServerProgress } from "./generated/XServerProgress";
export type { XServerConsentRequest } from "./generated/XServerConsentRequest";

/**
 * The user's reply to a connect-time consent prompt: `enable` downloads and
 * provisions (and is remembered), `notNow` skips X forwarding for this connect.
 */
export type XServerConsentDecision = "enable" | "notNow";

/**
 * Machine-readable classification of an X server provisioning failure. Drives
 * how the setup dialog recovers: `dependencyMissing` offers an install action;
 * the rest offer a plain retry with the human-readable `message`.
 */
export type XServerErrorKind =
  | "noLocalServer"
  | "dependencyMissing"
  | "serverUnreachable"
  | "launchFailed"
  | "unsupported";

/**
 * How the setup dialog should carry out the install action a `dependencyMissing`
 * error offers (#1309). The typed signal that replaced the earlier
 * `dependency === "Homebrew"` magic string; mirrors the Rust `InstallMode`.
 *
 * - `backend` — termiHub installs the dependency itself (`x_server_install_dependency`);
 *   any `installCommand` is shown for information only.
 * - `guidedTerminal` — the user runs `installCommand` in a terminal termiHub opens
 *   for them (the install has interactive prompts termiHub can't drive).
 * - `guidedExternal` — a prerequisite package manager is missing and isn't a
 *   terminal command either, so the user installs it from an external page/store
 *   termiHub opens, then retries (Windows winget-absent: App Installer, #1318).
 */
export type XServerInstallMode = "backend" | "guidedTerminal" | "guidedExternal";

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
  /**
   * Name of the missing dependency (only for `dependencyMissing`). Presentational
   * only — shown in the message and install-button label, never branched on.
   */
  dependency?: string;
  /**
   * How to run the install action (only for `dependencyMissing`, #1309): drives
   * whether the dialog executes {@link installCommand} in a terminal or triggers
   * the backend installer.
   */
  installMode?: XServerInstallMode;
  /** Human-readable hint on how to install the dependency. */
  installHint?: string;
  /** A concrete shell command that installs the dependency, if available. */
  installCommand?: string;
  /**
   * A manual-download page to use instead of the offered install action (#1312),
   * e.g. xquartz.org when a guided Homebrew install is declined. The dialog turns
   * it into an "Open <host>" button, rendered only when the backend provides one.
   */
  installFallbackUrl?: string;
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
