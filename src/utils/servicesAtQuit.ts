/**
 * What quitting does to the services (#6028, slice 11, question 2): they stop, on
 * this computer and on agents. termiHub asks only when one of them has
 * connections open right now.
 */
import type { RemoteAgentDefinition } from "@/types/connection";
import type { EmbeddedServerConfig, ServerState } from "@/types/embeddedServer";
import type { TunnelConfig, TunnelState } from "@/types/tunnel";
import type { WindowCloseService } from "@/types/window";
import { hostChoice } from "@/utils/hostChoice";
import { isServiceActive, serverServiceState, tunnelServiceState } from "@/utils/serviceState";

export interface ServicesAtQuitInput {
  tunnels: readonly TunnelConfig[];
  tunnelStates: Readonly<Record<string, TunnelState>>;
  servers: readonly EmbeddedServerConfig[];
  serverStates: Readonly<Record<string, ServerState>>;
  agents: readonly RemoteAgentDefinition[];
}

/** The services that run, with what is open on each; none when nothing is open. */
export function servicesAtQuit(input: ServicesAtQuitInput): WindowCloseService[] {
  const agentOf = (host: TunnelConfig["host"]) => {
    const choice = hostChoice(host);
    if (choice.kind !== "agent") return {};
    const name = input.agents.find((agent) => agent.id === choice.agentId)?.name;
    return { agent: name ?? choice.agentId };
  };
  const rows: WindowCloseService[] = [
    ...input.tunnels.flatMap((tunnel): WindowCloseService[] => {
      const state = input.tunnelStates[tunnel.id];
      if (!isServiceActive(tunnelServiceState(state?.status))) return [];
      const open = state?.stats.activeConnections ?? 0;
      return [{ key: tunnel.id, name: tunnel.name, open, ...agentOf(tunnel.host) }];
    }),
    ...input.servers.flatMap((server): WindowCloseService[] => {
      const state = input.serverStates[server.id];
      if (!isServiceActive(serverServiceState(state?.status))) return [];
      const open = state?.stats.activeConnections ?? 0;
      return [{ key: server.id, name: server.name, open, ...agentOf(server.host) }];
    }),
  ];
  return rows.some((row) => row.open > 0) ? rows : [];
}

/** "3 services stop, 2 connections are open." */
export function servicesAtQuitSentence(services: readonly WindowCloseService[]): string {
  const open = services.reduce((sum, row) => sum + row.open, 0);
  const stop = services.length === 1 ? "1 service stops" : `${services.length} services stop`;
  return `${stop}, ${open === 1 ? "1 connection is open" : `${open} connections are open`}.`;
}
