import type { RemoteAgentDefinition } from "@/types/connection";

/**
 * Confirmation message for deleting a saved remote agent (#5158). Deleting a
 * connected (or connecting) agent also disconnects it, so the message says so.
 */
export function remoteAgentDeleteMessage(
  agent: Pick<RemoteAgentDefinition, "name" | "connectionState">
): string {
  const base = `Delete agent “${agent.name}”?`;
  if (agent.connectionState === "disconnected") return `${base} This cannot be undone.`;
  return `${base} It is connected — deleting it also disconnects it. This cannot be undone.`;
}

/**
 * Confirmation message for deleting a folder on a remote agent (#5158). The
 * agent moves the folder's connections to its top level.
 */
export function agentFolderDeleteMessage(name: string, connectionCount: number): string {
  const base = `Delete folder “${name}” on this agent?`;
  if (connectionCount === 0) return base;
  const noun = connectionCount === 1 ? "connection" : "connections";
  return `${base} Its ${connectionCount} ${noun} will move to the agent's top level.`;
}
