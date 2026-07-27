/**
 * Structured, per-backend mapping from a connection-failure *situation* to the
 * user-facing hint shown on the terminal connection overlay.
 *
 * ## Why this exists (#2088)
 *
 * User-facing hints used to be ad-hoc strings inlined at the render site, which
 * let a hint written for one backend surface on an unrelated one. The reported
 * case: an **SSH** connect timeout showed *"Check that the host is reachable and
 * the agent binary is installed."* — an **agent**-connection hint that is wrong
 * on the SSH path (and, in fact, wrong on *every* path: a timeout means the
 * connection was never established, so the remote agent binary — which only
 * matters *after* the transport connects — cannot be the cause).
 *
 * Routing hints through this table gives a single reviewable place where each
 * hint is visibly tied to the backend family and situation that raises it, so a
 * hint can no longer be silently attached to the wrong backend. New backends or
 * situations extend the table rather than adding another inline string.
 */

/**
 * Backend families we tailor connection-failure guidance for. Derived from a
 * tab's effective `sessionType` (the inner session type for remote/agent-hosted
 * tabs, the connection type for direct ones). `unknown` is the safe default —
 * its guidance is correct for any backend and never names a backend-specific
 * component.
 */
export type BackendFamily = "ssh" | "telnet" | "serial" | "docker" | "local" | "unknown";

/** The connection-failure situations that carry a curated, backend-aware hint. */
export type ConnectionErrorKind = "timeout";

/**
 * Map a tab's effective `sessionType` string to a {@link BackendFamily}.
 * Anything unrecognised (including the empty string used for agent-transport
 * tabs with no inner session type) maps to `unknown`, which yields a generic,
 * always-correct reachability hint.
 */
export function backendFamilyFromSessionType(sessionType: string): BackendFamily {
  switch (sessionType) {
    case "ssh":
      return "ssh";
    case "telnet":
      return "telnet";
    case "serial":
      return "serial";
    case "docker":
      return "docker";
    case "local":
      return "local";
    default:
      return "unknown";
  }
}

/**
 * Per-backend timeout guidance. Every entry describes reachability/handshake
 * causes appropriate to that backend and deliberately never mentions the remote
 * agent binary — a timeout means the transport never connected, so the agent
 * binary cannot be the cause (#2088).
 */
const TIMEOUT_HINTS: Record<BackendFamily, string> = {
  ssh: "The connection timed out before the SSH session was established. Check that the host is reachable, the address and port are correct, and that no firewall is blocking the connection.",
  telnet:
    "The connection timed out. Check that the host is reachable, the address and port are correct, and that no firewall is blocking the connection.",
  serial:
    "The serial port did not respond in time. Check that the device is connected and that the baud rate matches the device.",
  docker:
    "The connection timed out. Check that Docker is running and that the container is reachable.",
  local:
    "Starting the local shell timed out. Check that the configured shell exists and is executable.",
  unknown:
    "The connection timed out. Check that the host is reachable, the address and port are correct, and that no firewall is blocking the connection.",
};

const HINTS: Record<ConnectionErrorKind, Record<BackendFamily, string>> = {
  timeout: TIMEOUT_HINTS,
};

/**
 * Resolve the user-facing hint for a connection-failure situation on a given
 * backend family. Returns `null` when no curated hint applies.
 */
export function connectionErrorHint(
  family: BackendFamily,
  kind: ConnectionErrorKind
): string | null {
  return HINTS[kind]?.[family] ?? null;
}
