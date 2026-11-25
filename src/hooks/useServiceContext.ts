import { useEffect, useMemo, useState } from "react";
import { listNetworkInterfaces } from "@/services/embeddedServerApi";
import { EMPTY_AGENTS_VIEW } from "@/store/agentsBridge";
import { useAppStore } from "@/store/appStore";
import { useProjectedAgents } from "@/store/useProjectedAgents";
import { useProjectedConnections } from "@/store/useProjectedConnections";
import { frontendLog } from "@/utils/frontendLog";
import { errorMessage } from "@/utils/errorMessage";
import type { ServiceContext } from "@/utils/serviceModel";
import { hostChoice } from "@/utils/hostChoice";
import { isWideBind } from "@/utils/serviceAddress";
import { isLoopbackBind } from "@/utils/tunnelHost";

/** Whether a service stored with `host` runs on this computer. */
const isHere = (host: Parameters<typeof hostChoice>[0]) => hostChoice(host).kind === "thisComputer";

/** How often this computer is asked for its address while it has none. */
const NETWORK_RETRY_MS = 10_000;

/**
 * What the service models need besides the services (#6028): the agents, the
 * connections, and this computer's address on the network, read while
 * `needsNetwork` (a service here listens on every interface).
 */
export function useServiceContext(needsNetwork: boolean): ServiceContext {
  const agentsView = useProjectedAgents();
  const { remoteAgents } = agentsView;
  const agentsKnown = agentsView !== EMPTY_AGENTS_VIEW;
  const { connections } = useProjectedConnections();
  const tunnels = useAppStore((s) => s.tunnels);
  const servers = useAppStore((s) => s.embeddedServers);
  const [networkAddress, setNetworkAddress] = useState<string>();

  const waiting = needsNetwork && networkAddress === undefined;

  useEffect(() => {
    if (!needsNetwork) return;
    let current = true;
    const read = () =>
      void listNetworkInterfaces()
        .then((interfaces) => {
          const own = interfaces.find((i) => !isLoopbackBind(i.addr) && !isWideBind(i.addr));
          if (current) setNetworkAddress(own?.addr);
        })
        .catch((err: unknown) =>
          frontendLog("services", `Failed to read the network address: ${errorMessage(err)}`)
        );
    read();
    // The row says that it appears once this computer is connected.
    window.addEventListener("online", read);
    window.addEventListener("focus", read);
    const timer = waiting ? window.setInterval(read, NETWORK_RETRY_MS) : undefined;
    return () => {
      current = false;
      window.removeEventListener("online", read);
      window.removeEventListener("focus", read);
      window.clearInterval(timer);
    };
  }, [needsNetwork, waiting]);

  const tunnelStates = useAppStore((s) => s.tunnelStates);
  const serverStates = useAppStore((s) => s.embeddedServerStates);
  // Who has a port open here now (#6076), so that a taken one can be named.
  const portHolders = useMemo(() => {
    const holders = new Map<number, { id: string; name: string }>();
    for (const { id, name, host, tunnelType } of tunnels) {
      if (tunnelType.type === "remote" || !isHere(host)) continue;
      if (tunnelStates[id]?.status !== "connected") continue;
      holders.set(Number(tunnelType.config.localPort), { id, name });
    }
    for (const { id, name, host, port } of servers) {
      if (isHere(host) && serverStates[id]?.status === "running") holders.set(port, { id, name });
    }
    return holders;
  }, [tunnels, servers, tunnelStates, serverStates]);

  // Who is set to a port of this computer (V-002), whether it runs or not.
  const portUsers = useMemo(() => {
    const users = new Map<number, { id: string; name: string }>();
    const add = (port: number, id: string, name: string) => {
      if (!users.has(port)) users.set(port, { id, name });
    };
    for (const { id, name, host, tunnelType } of tunnels) {
      if (tunnelType.type !== "remote" && isHere(host)) {
        add(Number(tunnelType.config.localPort), id, name);
      }
    }
    for (const { id, name, host, port } of servers) if (isHere(host)) add(port, id, name);
    return users;
  }, [tunnels, servers]);

  const usedPorts = useMemo(() => {
    const ports = new Set<number>();
    for (const { tunnelType, host } of tunnels) {
      if (tunnelType.type !== "remote" && isHere(host)) {
        ports.add(Number(tunnelType.config.localPort));
      }
    }
    for (const server of servers) if (isHere(server.host)) ports.add(server.port);
    return ports;
  }, [tunnels, servers]);

  return useMemo(
    () => ({
      agents: remoteAgents,
      agentsKnown,
      connections,
      networkAddress,
      usedPorts,
      portHolders,
      portUsers,
    }),
    [remoteAgents, agentsKnown, connections, networkAddress, usedPorts, portHolders, portUsers]
  );
}
