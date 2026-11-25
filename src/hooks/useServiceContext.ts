import { useEffect, useMemo, useState } from "react";
import { listNetworkInterfaces } from "@/services/embeddedServerApi";
import { useAppStore } from "@/store/appStore";
import { useProjectedAgents } from "@/store/useProjectedAgents";
import { useProjectedConnections } from "@/store/useProjectedConnections";
import { frontendLog } from "@/utils/frontendLog";
import { errorMessage } from "@/utils/errorMessage";
import type { ServiceContext } from "@/utils/serviceModel";
import { isWideBind } from "@/utils/serviceAddress";
import { isLoopbackBind } from "@/utils/tunnelHost";

/**
 * What the service models need besides the services (#6028): the agents, the
 * connections, and this computer's address on the network, read when
 * `needsNetwork` (a service here listens on every interface).
 */
export function useServiceContext(needsNetwork: boolean): ServiceContext {
  const { remoteAgents } = useProjectedAgents();
  const { connections } = useProjectedConnections();
  const tunnels = useAppStore((s) => s.tunnels);
  const servers = useAppStore((s) => s.embeddedServers);
  const [networkAddress, setNetworkAddress] = useState<string>();

  useEffect(() => {
    if (!needsNetwork) return;
    let current = true;
    listNetworkInterfaces()
      .then((interfaces) => {
        const own = interfaces.find((i) => !isLoopbackBind(i.addr) && !isWideBind(i.addr));
        if (current) setNetworkAddress(own?.addr);
      })
      .catch((err: unknown) =>
        frontendLog("services", `Failed to read the network address: ${errorMessage(err)}`)
      );
    return () => {
      current = false;
    };
  }, [needsNetwork]);

  const usedPorts = useMemo(() => {
    const ports = new Set<number>();
    for (const { tunnelType } of tunnels) {
      if (tunnelType.type !== "remote") ports.add(Number(tunnelType.config.localPort));
    }
    for (const server of servers) ports.add(server.port);
    return ports;
  }, [tunnels, servers]);

  return useMemo(
    () => ({ agents: remoteAgents, connections, networkAddress, usedPorts }),
    [remoteAgents, connections, networkAddress, usedPorts]
  );
}
