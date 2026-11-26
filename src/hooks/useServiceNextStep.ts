import { useCallback } from "react";
import { toast } from "@/components/ui";
import { useConnectAgent } from "@/hooks/useConnectAgent";
import { useConnectSavedConnection } from "@/hooks/useConnectSavedConnection";
import { useProjectedConnections } from "@/store/useProjectedConnections";
import { checkEmbeddedServers, keepEmbeddedServerRunning } from "@/services/embeddedServerApi";
import { useAppStore } from "@/store/appStore";
import { errorMessage } from "@/utils/errorMessage";
import type { ServiceModel, ServiceNextStep } from "@/utils/serviceModel";

/** What a next step needs that only the place showing it knows. */
export interface NextStepTargets {
  /** Open its settings. */
  edit: (id: string) => void;
  /** Listen on another port of this computer, and start. */
  listenOn: (id: string, port: number) => void | Promise<void>;
  /** A tunnel's SSH connection, for "Edit connection". */
  sshConnectionId?: string;
}

/** Tell the user what failed, and keep it failed for the button. */
export async function told(what: string, name: string, work: void | Promise<void>) {
  try {
    await work;
  } catch (err) {
    toast.error(`Failed to ${what} ${name}`, { description: errorMessage(err) });
    throw err;
  }
}

/**
 * What the buttons beside the reason of a service do (#6063), the same on its
 * row and in its Activity (#6028, slice 9).
 */
export function useServiceNextStep(
  model: Pick<ServiceModel, "id" | "kind" | "name" | "where">,
  { edit, listenOn, sshConnectionId }: NextStepTargets
): (step: ServiceNextStep) => void | Promise<void> {
  const connectAgent = useConnectAgent();
  const openConnectionEditorTab = useAppStore((s) => s.openConnectionEditorTab);
  const checkTunnelsAgain = useAppStore((s) => s.checkTunnelsAgain);
  const keepTunnelRunning = useAppStore((s) => s.keepTunnelRunning);
  const retryTunnelNow = useAppStore((s) => s.retryTunnelNow);
  const setUnlockDialogOpen = useAppStore((s) => s.setUnlockDialogOpen);
  const startTunnel = useAppStore((s) => s.startTunnel);
  const { connect } = useConnectSavedConnection();
  const { connections } = useProjectedConnections();
  const { id, kind, name, where } = model;
  const agentId = where.agentId;

  return useCallback(
    (step: ServiceNextStep): void | Promise<void> => {
      const server = kind === "fileServer";
      switch (step.id) {
        case "usePort":
          if (step.port === undefined) return;
          return server ? told("start", name, listenOn(id, step.port)) : listenOn(id, step.port);
        case "connectAgent":
          return agentId === undefined ? undefined : connectAgent(agentId);
        case "unlock":
          return setUnlockDialogOpen(true);
        case "checkAgain":
          return server ? told("check", name, checkEmbeddedServers()) : checkTunnelsAgain();
        case "keepRunning":
          return server
            ? told("keep running", name, keepEmbeddedServerRunning(id))
            : keepTunnelRunning(id);
        case "edit":
        case "chooseMachine":
        case "chooseConnection":
        case "chooseFolder":
          return edit(id);
        // A start asks about the host key again, with the key to compare.
        case "reviewKey":
          return server ? undefined : startTunnel(id);
        case "openTerminal": {
          const connection = connections.find((c) => c.id === sshConnectionId);
          return connection ? connect(connection) : undefined;
        }
        case "letReach":
          // Only a file server for devices is there for others alone.
          return server ? edit(id) : undefined;
        case "editConnection":
          return sshConnectionId === undefined
            ? undefined
            : openConnectionEditorTab(sshConnectionId);
        case "retryNow":
          return server ? undefined : retryTunnelNow(id);
      }
    },
    [
      kind,
      id,
      name,
      agentId,
      sshConnectionId,
      edit,
      listenOn,
      connectAgent,
      setUnlockDialogOpen,
      checkTunnelsAgain,
      keepTunnelRunning,
      retryTunnelNow,
      openConnectionEditorTab,
      startTunnel,
      connect,
      connections,
    ]
  );
}
