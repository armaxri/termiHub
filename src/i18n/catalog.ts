/**
 * User-facing message catalog (I18N-009).
 *
 * UI copy that is selected by a structured signal (e.g. the connection-failure
 * hints chosen from a backend error kind) is referenced by a stable message id
 * and resolved here, rather than inlined at the render site. Keeping the copy
 * keyed by id is what lets a locale be added by supplying another table, and
 * it keeps the *selection* of a message (by id) independent of its wording.
 *
 * Only English exists today; {@link t} resolves against it. A new locale adds a
 * `Record<MessageId, string>` table — the type forces it to cover every id.
 */

const en = {
  // ── Connection-failure hints (TerminalConnectionOverlay) ────────────────
  // Timeout guidance is per backend and never mentions the remote agent
  // binary: a timeout means the transport never connected (#2088).
  "connection.hint.timeout.ssh":
    "The connection timed out before the SSH session was established. Check that the host is reachable, the address and port are correct, and that no firewall is blocking the connection.",
  "connection.hint.timeout.telnet":
    "The connection timed out. Check that the host is reachable, the address and port are correct, and that no firewall is blocking the connection.",
  "connection.hint.timeout.serial":
    "The serial port did not respond in time. Check that the device is connected and that the baud rate matches the device.",
  "connection.hint.timeout.docker":
    "The connection timed out. Check that Docker is running and that the container is reachable.",
  "connection.hint.timeout.local":
    "Starting the local shell timed out. Check that the configured shell exists and is executable.",
  "connection.hint.timeout.unknown":
    "The connection timed out. Check that the host is reachable, the address and port are correct, and that no firewall is blocking the connection.",
  "connection.hint.auth.remote":
    "The server rejected the credentials. Check the username, password, or key and try again.",
  "connection.hint.agentAuth.title": "SSH Agent not running",
  "connection.hint.agentAuth.ssh":
    "Open the connection editor and use the Setup SSH Agent button, or run:",
  "connection.hint.notFound.serial":
    "Serial port not found. Check that the device is connected and the port name is correct.",
  "connection.hint.permission.title": "Permission denied",
  "connection.hint.permission.serial.linux":
    "On Linux, add your user to the dialout group and re-login:",
  // Only Linux gates serial ports behind a group; on Windows/macOS a denied
  // port almost always means another program holds it (#1831).
  "connection.hint.permission.serial.windows":
    "Another application may be using the port, or you may not have permission to access it. Close any program using the port and try again.",
  "connection.hint.permission.serial.macos":
    "You may not have permission to access this port, or another application may be using it. Close any program using the port and try again.",
  "connection.hint.busy.serial": "The serial port is already in use by another application.",
} as const;

/** A stable id naming one catalog message. */
export type MessageId = keyof typeof en;

/** Supported UI locales. */
export type Locale = "en";

const CATALOGS: Record<Locale, Record<MessageId, string>> = { en };

/** Resolve a message id to its text in `locale` (English by default). */
export function t(id: MessageId, locale: Locale = "en"): string {
  return CATALOGS[locale][id];
}
