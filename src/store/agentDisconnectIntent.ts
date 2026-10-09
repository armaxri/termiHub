/**
 * Tracks agents the user is deliberately disconnecting or shutting down (#4309).
 *
 * The backend emits the same `agent-state-change` = "disconnected" (no error)
 * for a user Disconnect/Shutdown as for a transport that dropped on its own, so
 * the frontend cannot tell them apart from the event alone. The agents slice
 * records the intent here *before* it asks the backend to disconnect, and the
 * `agent-state-change` handler consumes it when the "disconnected" event lands:
 * a consumed intent ends the hosted tabs cleanly instead of arming a reconnect
 * loop that can never succeed (the disconnect deletes the agent's retained
 * transport config, so every redrive attempt fails).
 *
 * Module-level and per-window on purpose: the intent belongs to the window whose
 * user clicked Disconnect, and it is consumed by that same window's handler.
 */

const pending = new Set<string>();

/** Record that the user is about to disconnect or shut down `agentId`. */
export function markAgentDisconnectIntent(agentId: string): void {
  pending.add(agentId);
}

/**
 * Drop a recorded intent without acting on it — the disconnect request failed,
 * or the agent is connecting again so any leftover intent is stale.
 */
export function clearAgentDisconnectIntent(agentId: string): void {
  pending.delete(agentId);
}

/**
 * Whether the user asked to disconnect `agentId`, clearing the record so it
 * applies to exactly one "disconnected" event.
 */
export function consumeAgentDisconnectIntent(agentId: string): boolean {
  return pending.delete(agentId);
}

/** Forget every recorded intent (test isolation). */
export function resetAgentDisconnectIntentsForTest(): void {
  pending.clear();
}
