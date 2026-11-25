import { useCallback } from "react";
import { toast } from "@/components/ui";
import type { ServiceLifecycleConfirm } from "@/hooks/useServiceLifecycleConfirm";
import { useTunnelDeleteConfirm } from "@/hooks/useTunnelDeleteConfirm";
import { useAppStore } from "@/store/appStore";
import { newId } from "@/services/transport/ids";
import type { TunnelConfig } from "@/types/tunnel";
import { errorMessage } from "@/utils/errorMessage";
import type { ServiceModel } from "@/utils/serviceModel";

/** `tunnel`, listening on another port. */
function withLocalPort(tunnel: TunnelConfig, localPort: number): TunnelConfig {
  const { tunnelType } = tunnel;
  switch (tunnelType.type) {
    case "local":
      return {
        ...tunnel,
        tunnelType: { type: "local", config: { ...tunnelType.config, localPort } },
      };
    case "dynamic":
      return {
        ...tunnel,
        tunnelType: { type: "dynamic", config: { ...tunnelType.config, localPort } },
      };
    case "remote":
      return tunnel;
  }
}

type ModelOf = (id: string) => Pick<ServiceModel, "name" | "counters">;

/** What the rows of the tunnels do. */
export function useTunnelActions(
  modelOf: ModelOf,
  requestLifecycle: ServiceLifecycleConfirm["request"]
) {
  const tunnels = useAppStore((s) => s.tunnels);
  const start = useAppStore((s) => s.startTunnel);
  const stopTunnel = useAppStore((s) => s.stopTunnel);
  const reconnectTunnel = useAppStore((s) => s.reconnectTunnel);
  const saveTunnel = useAppStore((s) => s.saveTunnel);
  const openTunnelEditorTab = useAppStore((s) => s.openTunnelEditorTab);
  // Confirm + Undo, shared with the connection editor's Port Forwarding section
  // (#5158, #5216).
  const { requestDelete, dialogProps: deleteDialogProps } = useTunnelDeleteConfirm();

  const edit = useCallback((id: string) => openTunnelEditorTab(id), [openTunnelEditorTab]);

  const stop = useCallback(
    (id: string) => requestLifecycle("stop", modelOf(id), () => stopTunnel(id)),
    [requestLifecycle, modelOf, stopTunnel]
  );
  const restart = useCallback(
    (id: string) => requestLifecycle("restart", modelOf(id), () => reconnectTunnel(id)),
    [requestLifecycle, modelOf, reconnectTunnel]
  );

  const duplicate = useCallback(
    (id: string) => {
      const original = tunnels.find((tunnel) => tunnel.id === id);
      if (!original) return;
      // A copy keeps where it runs, and is its own tunnel: it starts by hand and
      // is not a second hop of the original's parent (#6028, F-4).
      const { companionOf: _chain, ...rest } = original;
      const copy = {
        ...rest,
        id: newId("tun"),
        name: `Copy of ${original.name}`,
        autoStart: false,
        startWithConnection: false,
      };
      // The copy's row is the confirmation (#5859).
      saveTunnel(copy).catch((err: unknown) =>
        toast.error(`Failed to duplicate "${original.name}"`, { description: errorMessage(err) })
      );
    },
    [tunnels, saveTunnel]
  );

  // "Use 8081" beside "Port 8080 is already in use" (#6063).
  const usePort = useCallback(
    async (id: string, port: number) => {
      const tunnel = tunnels.find((item) => item.id === id);
      if (!tunnel) return;
      try {
        await saveTunnel(withLocalPort(tunnel, port));
      } catch (err) {
        toast.error(`Failed to change the port of "${tunnel.name}"`, {
          description: errorMessage(err),
        });
        return;
      }
      await start(id);
    },
    [tunnels, saveTunnel, start]
  );

  return {
    start,
    stop,
    restart,
    edit,
    duplicate,
    usePort,
    remove: requestDelete,
    deleteDialogProps,
  };
}
