import { currentAgentsView, onAgentsView } from "@/store/agentsBridge";
import { isAgentTransportClosed } from "@/utils/backendErrorCode";

/**
 * How long, after an immediate agent-update apply request fails, we wait for the
 * agent's transport to actually drop before concluding the failure was *not* the
 * expected binary-swap disconnect. Kept short: a successful immediate apply
 * re-execs the agent right away, so the drop lands within a second or two; a
 * genuine update failure leaves the connection up, so we only pay this delay on
 * the (rare) real-failure path — and paying it is the safe direction (we report a
 * real failure a little late rather than silently reporting success).
 */
export const APPLY_DISCONNECT_WINDOW_MS = 4000;

/**
 * Decide whether an error thrown by an immediate agent-update apply request is the
 * *expected* transport drop that happens as the agent swaps its own binary and
 * re-execs (#1352), rather than a genuine update/restart failure.
 *
 * The decision is based on the flow's structured state — "I just requested an
 * immediate apply, and did the agent's transport then drop?" — read from the
 * authoritative, single-writer `connectionState` of the `agents` projection region
 * (fed by the backend `agent-state-change` event). It deliberately does **not**
 * parse the human-readable error message, which was both locale-fragile (a
 * non-English SSH/OS transport error carries none of the English tokens) and too
 * broad (a real failure whose message merely mentioned "connection"/"closed" was
 * misreported as success). See finding I18N-008.
 *
 * Resolves `true` (treat as the expected disconnect) only when there is positive
 * evidence the transport dropped: the agent is already in a non-`connected` state,
 * or it transitions out of `connected` within {@link APPLY_DISCONNECT_WINDOW_MS}.
 * If the agent stays `connected` for the whole window — or is not tracked at all —
 * it resolves `false`, so a real failure is surfaced rather than swallowed.
 *
 * @param agentId Id of the agent whose apply request failed.
 * @param windowMs Override the wait window (tests). Defaults to
 *   {@link APPLY_DISCONNECT_WINDOW_MS}.
 */
export function awaitExpectedApplyDisconnect(
  agentId: string,
  windowMs: number = APPLY_DISCONNECT_WINDOW_MS
): Promise<boolean> {
  // Positive evidence already visible: the drop event was folded before we got
  // here (the common race — the transport was already dying when the RPC failed).
  if (hasDropped(agentId, currentAgentsView().remoteAgents)) {
    return Promise.resolve(true);
  }

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (dropped: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      resolve(dropped);
    };

    const unsubscribe = onAgentsView((view) => {
      if (hasDropped(agentId, view.remoteAgents)) finish(true);
    });
    const timer = setTimeout(() => finish(false), windowMs);
  });
}

/**
 * Classify an error thrown by an immediate agent-update apply request as the
 * *expected* binary-swap disconnect (`true`) or a genuine failure (`false`).
 *
 * Primary discriminator (#2840): the structured error envelope's `code`. When
 * the backend reports `agent_transport_closed` — the request failed because the
 * agent transport closed under it, not because the agent answered with an error
 * — that is the swap's re-exec tearing the link down, so it resolves `true` at
 * once. The message text is never consulted.
 *
 * Fallback: any other error (an agent-reported application error, a timeout,
 * or a legacy/uncoded error) is confirmed against the agent's authoritative
 * connection state via {@link awaitExpectedApplyDisconnect} — so it only counts
 * as expected if the transport demonstrably drops within the window, and a real
 * failure on a connection that stays up is surfaced.
 *
 * @param agentId Id of the agent whose apply request failed.
 * @param error The value the apply request rejected with.
 * @param windowMs Override the fallback wait window (tests).
 */
export function isExpectedApplyDisconnect(
  agentId: string,
  error: unknown,
  windowMs: number = APPLY_DISCONNECT_WINDOW_MS
): Promise<boolean> {
  if (isAgentTransportClosed(error)) {
    return Promise.resolve(true);
  }
  return awaitExpectedApplyDisconnect(agentId, windowMs);
}

/**
 * `true` when `agentId` is present in the projected list and its `connectionState`
 * is anything other than `"connected"` — i.e. its live transport has dropped. An
 * untracked agent yields `false`: absence is not positive evidence of a swap, so we
 * bias toward reporting a real failure rather than a false success.
 */
function hasDropped(
  agentId: string,
  agents: ReadonlyArray<{ id: string; connectionState: string }>
): boolean {
  const agent = agents.find((a) => a.id === agentId);
  return agent !== undefined && agent.connectionState !== "connected";
}
