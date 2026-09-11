/**
 * Structured, locale-independent decoding of backend (Tauri command) error
 * messages.
 *
 * Connect/auth errors cross the IPC boundary as plain strings. To let the
 * frontend classify an **authentication rejection** without parsing
 * human-readable (English, and one localization away from breaking) message
 * text, the backend prefixes a genuine auth failure with a stable machine
 * marker: `[thub-code:<code>] <human message>`. See the Rust
 * `TerminalError::AuthFailed` variant in `src-tauri/src/utils/errors.rs`.
 *
 * This module extracts that code and strips the marker so the human message can
 * still be displayed cleanly. It is deliberately the ONLY place that knows the
 * wire format, so the destructive stored-credential discard (I18N-001) gates on
 * a typed signal rather than on `raw.includes("auth failed")`.
 */

/**
 * Stable code emitted when SSH/agent authentication is genuinely rejected
 * (wrong password/passphrase or a refused key). Mirrors the Rust
 * `AUTH_FAILED_CODE` / `TerminalError::AuthFailed` marker.
 */
export const AUTH_FAILED_CODE = "auth_failed";

/**
 * Matches the backend error-code marker `[thub-code:<code>] ` anywhere in the
 * message. The code alphabet is restricted to lowercase/digits/underscore so
 * the token is unambiguous and never collides with prose. The trailing space is
 * optional and consumed when present so the stripped message reads naturally.
 */
const CODE_MARKER_RE = /\[thub-code:([a-z0-9_]+)\]\s?/;

/** A backend error split into its machine code (if any) and human message. */
export interface ParsedBackendError {
  /** The machine-stable code, when the marker was present (e.g. `auth_failed`). */
  code?: string;
  /** The human-readable message with any code marker stripped. */
  message: string;
}

/**
 * Parse an unknown caught value into its {@link ParsedBackendError}.
 *
 * Accepts a string, an `Error`, or any value; falls back to `String(err)` for
 * the message. When the backend code marker is present the `code` is extracted
 * and the marker removed from `message`.
 */
export function parseBackendError(error: unknown): ParsedBackendError {
  const raw = error instanceof Error ? error.message : String(error);
  const match = raw.match(CODE_MARKER_RE);
  if (!match) return { message: raw };
  const message = (raw.slice(0, match.index) + raw.slice(match.index! + match[0].length)).trim();
  return { code: match[1], message };
}

/**
 * True when the error is a genuine authentication rejection, per the typed
 * backend signal. Never depends on the human message text, so it is correct
 * under any locale or wording (I18N-001).
 */
export function isAuthFailure(error: unknown): boolean {
  return parseBackendError(error).code === AUTH_FAILED_CODE;
}

/**
 * The human-readable message for display, with any backend code marker stripped
 * so a machine token never leaks into the UI.
 */
export function backendErrorMessage(error: unknown): string {
  return parseBackendError(error).message;
}
