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

  const usedPorts = useMemo(() => {
    const ports = new Set<number>();
    const isHere = (host: Parameters<typeof hostChoice>[0]) =>
      hostChoice(host).kind === "thisComputer";
    for (const { tunnelType, host } of tunnels) {
      if (tunnelType.type !== "remote" && isHere(host)) {
        ports.add(Number(tunnelType.config.localPort));
      }
    }
    for (const server of servers) if (isHere(server.host)) ports.add(server.port);
    return ports;
  }, [tunnels, servers]);

  return useMemo(
    () => ({ agents: remoteAgents, agentsKnown, connections, networkAddress, usedPorts }),
    [remoteAgents, agentsKnown, connections, networkAddress, usedPorts]
  );
}
