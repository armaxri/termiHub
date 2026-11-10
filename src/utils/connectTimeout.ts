/**
 * Client-side timeouts for the pre-connect terminal lifecycle states.
 *
 * `Connecting` relies on the backend connect timeout, but a hung IPC call or a
 * backend that never resolves would otherwise leave the overlay spinning
 * forever. `WaitingForAgent` has no backend timeout at all — a tab parks until
 * the parent agent emits "connected", which may never happen. Both states get a
 * bounded client-side timeout that transitions the tab to `Failed` with a
 * contextual hint so the user is never stuck on an indefinite spinner (#1129).
 */

/** The pre-connect states that carry a client-side timeout. */
export type ConnectTimeoutKind = "connecting" | "waiting-for-agent";

/**
 * Max time a `createTerminal` call may stay in-flight before the overlay
 * gives up and shows a Failed state. Generous enough to outlast the backend's
 * own connect timeout so this only fires when the backend never answers.
 */
export const CONNECTING_TIMEOUT_MS = 90_000;

/**
 * Max time a tab may park waiting for its parent agent to come online before
 * transitioning to Failed. The agent transport wakes waiting tabs on
 * "connected"; this bounds the wait when it never does.
 */
export const WAITING_FOR_AGENT_TIMEOUT_MS = 60_000;

/**
 * How long a connect's own SSH prompt (host-key trust, keyboard-interactive /
 * one-time code) may hold the `Connecting` deadline paused (#5243). Matches the
 * backend's prompt bound (`HOST_KEY_PROMPT_TIMEOUT`, 300 s, the same for
 * keyboard-interactive), so a prompt nobody answers still ends the connect.
 */
export const CONNECT_PROMPT_LIMIT_MS = 300_000;

/**
 * Slack on top of {@link CONNECT_PROMPT_LIMIT_MS} so the backend's own typed
 * prompt timeout settles the tab first; the client cap is only a safety net.
 */
export const CONNECT_PROMPT_GRACE_MS = 10_000;

/** The timeout duration in milliseconds for a given pre-connect kind. */
export function connectTimeoutMs(kind: ConnectTimeoutKind): number {
  return kind === "connecting" ? CONNECTING_TIMEOUT_MS : WAITING_FOR_AGENT_TIMEOUT_MS;
}

/** Whole-second duration used in the user-facing message for a given kind. */
function connectTimeoutSeconds(kind: ConnectTimeoutKind): number {
  return Math.round(connectTimeoutMs(kind) / 1000);
}

/**
 * Build the contextual Failed message shown in the overlay when a pre-connect
 * state times out.
 */
export function connectTimeoutMessage(kind: ConnectTimeoutKind): string {
  const seconds = connectTimeoutSeconds(kind);
  if (kind === "waiting-for-agent") {
    return `Agent did not come online within ${seconds} s.`;
  }
  return `Connection did not complete within ${seconds} s.`;
}
