/**
 * "Show this agent" requests from the connection editor to the sidebar (#5851).
 *
 * After the editor creates or saves a remote agent, the Remote agents section
 * may be collapsed at the bottom of the sidebar (R-081). The editor asks the
 * sidebar to reveal the agent; the sidebar expands the section and scrolls the
 * agent's row into view once it renders. UI-only, nothing is persisted.
 */

type RevealListener = (agentId: string) => void;

const listeners = new Set<RevealListener>();

/** Ask the sidebar to expand Remote agents and scroll to `agentId`. */
export function requestRemoteAgentReveal(agentId: string): void {
  for (const listener of listeners) listener(agentId);
}

/** Listen for reveal requests; returns the unsubscribe function. */
export function subscribeRemoteAgentReveal(listener: RevealListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
