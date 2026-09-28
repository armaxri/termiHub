/**
 * VNC/RDP connections hosted under an agent (#3241).
 *
 * The agent does not run graphical backends. A VNC/RDP connection saved under
 * an agent is still run by this computer's own VNC/RDP backend, which reaches
 * the server through a port forward over the agent — so the host and port are
 * as seen **from the agent host**. These helpers offer those types in the
 * agent's connection editor and open such a connection as a remote-desktop tab
 * routed through the agent (its config carries `agentId`).
 */
import type { ConnectionConfig } from "@/types/terminal";
import type { ConnectionTypeInfo } from "@/types/connection";

/** Graphical type ids an agent can carry through its port forwarding. */
export const AGENT_TUNNELLED_GRAPHICAL_TYPES: readonly string[] = ["vnc", "rdp"];

/**
 * Schema group dropped from a tunnelled type: VNC's own SSH tunnel cannot be
 * combined with the agent route (the agent already carries the connection).
 */
const UNSUPPORTED_GROUP_KEYS: readonly string[] = ["sshTunnel"];

/** Whether `typeId` is a graphical type an agent carries by tunnelling. */
export function isAgentTunnelledGraphicalType(typeId: string): boolean {
  return AGENT_TUNNELLED_GRAPHICAL_TYPES.includes(typeId);
}

/**
 * The connection types the editor offers under an agent: the agent's own
 * registry plus this computer's VNC/RDP types (when this build has them), which
 * run here and tunnel through the agent. Their schema drops the SSH tunnel
 * group. Types the agent already reports are left as the agent describes them.
 */
export function withAgentTunnelledTypes(
  agentTypes: ConnectionTypeInfo[],
  desktopTypes: ConnectionTypeInfo[]
): ConnectionTypeInfo[] {
  const present = new Set(agentTypes.map((t) => t.typeId));
  const tunnelled = desktopTypes
    .filter(
      (t) =>
        isAgentTunnelledGraphicalType(t.typeId) &&
        t.capabilities?.graphical === true &&
        !present.has(t.typeId)
    )
    .map((t) => ({
      ...t,
      schema: {
        ...t.schema,
        groups: t.schema.groups.filter((g) => !UNSUPPORTED_GROUP_KEYS.includes(g.key)),
      },
    }));
  return [...agentTypes, ...tunnelled];
}

/**
 * The tab config of a VNC/RDP connection hosted under `agentId`: the graphical
 * type itself (so the tab is a remote-desktop canvas driven by this computer's
 * backend) with the agent route in its settings.
 */
export function agentGraphicalTabConfig(
  agentId: string,
  typeId: string,
  settings: Record<string, unknown>
): ConnectionConfig {
  return { type: typeId, config: { ...settings, agentId } };
}
