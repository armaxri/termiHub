import { useMemo } from "react";
import { useServiceContext } from "@/hooks/useServiceContext";
import { t } from "@/i18n/catalog";
import { useAppStore } from "@/store/appStore";
import type { TunnelConfig, TunnelState, TunnelStatus } from "@/types/tunnel";
import { isWideBind } from "@/utils/serviceAddress";
import {
  fileServerModel,
  tunnelModel,
  type ServiceContext,
  type ServiceModel,
} from "@/utils/serviceModel";
import type { ServiceEntry } from "@/utils/serviceRows";
import {
  combinedPairStatus,
  findCompanion,
  orderTunnelRows,
  type PairStatus,
} from "@/utils/tunnelChain";
import { newServiceGroups } from "./newServiceEntries";

const DISCONNECTED: TunnelStatus = "disconnected";

export const GROUP_LABEL = {
  tunnel: "service.group.tunnels",
  fileServer: "service.group.fileServers",
} as const;

/** Whether a pair works here, as both of its rows tell it; none when unchained. */
export function pairStatusOf(
  tunnel: TunnelConfig,
  parent: TunnelConfig | undefined,
  tunnels: TunnelConfig[],
  states: Record<string, TunnelState>
): PairStatus | undefined {
  const companion = parent ? tunnel : findCompanion(tunnels, tunnel.id);
  if (!companion) return undefined;
  return combinedPairStatus(
    states[(parent ?? tunnel).id]?.status ?? DISCONNECTED,
    states[companion.id]?.status ?? DISCONNECTED,
    true
  );
}

/** The ports and hosts of a tunnel, for the search. */
const portsOf = ({ tunnelType }: TunnelConfig) => Object.values(tunnelType.config).map(String);

/** What the group and the New menu call such a service (#6076). */
function kindWords({ kind, type }: ServiceModel): string[] {
  const id = kind === "tunnel" ? `tunnel-${type}` : `server-${type}`;
  const entry = newServiceGroups()
    .flatMap((group) => group.entries)
    .find((item) => item.id === id);
  return [t(GROUP_LABEL[kind]), ...(entry ? [entry.label, entry.technical, ...entry.words] : [])];
}

/**
 * Every service as the sidebar lists it and the status bar counts it (#6028).
 * This computer's network address is only read where rows show it.
 */
export function useServiceEntries(showsAddresses: boolean): {
  entries: ServiceEntry[];
  context: ServiceContext;
} {
  const tunnels = useAppStore((s) => s.tunnels);
  const tunnelStates = useAppStore((s) => s.tunnelStates);
  const servers = useAppStore((s) => s.embeddedServers);
  const serverStates = useAppStore((s) => s.embeddedServerStates);
  const context = useServiceContext(
    showsAddresses &&
      (servers.some((server) => isWideBind(server.bindHost)) ||
        tunnels.some(
          ({ tunnelType }) =>
            tunnelType.type !== "remote" && isWideBind(tunnelType.config.localHost)
        ))
  );

  const entries = useMemo<ServiceEntry[]>(() => {
    const via = (id: string) => context.connections.find((c) => c.id === id)?.name;
    return [
      ...orderTunnelRows(tunnels).map(({ tunnel, parent }): ServiceEntry => {
        const status = pairStatusOf(tunnel, parent, tunnels, tunnelStates);
        const model = tunnelModel(
          tunnel,
          tunnelStates[tunnel.id],
          context,
          status && { role: parent ? "hop" : "parent", status }
        );
        const own = [tunnel.name, via(tunnel.sshConnectionId), ...portsOf(tunnel)];
        return { model, parentId: parent?.id, texts: [...own, ...kindWords(model)] };
      }),
      ...servers.map((server): ServiceEntry => {
        const model = fileServerModel(server, serverStates[server.id], context);
        const own = [server.rootDirectory, String(server.port)];
        return { model, texts: [...own, ...kindWords(model)] };
      }),
    ];
  }, [tunnels, tunnelStates, servers, serverStates, context]);

  return { entries, context };
}
