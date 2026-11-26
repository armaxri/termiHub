import { useCallback, useEffect, useState } from "react";
import { useServiceLifecycleConfirm } from "@/hooks/useServiceLifecycleConfirm";
import { told, useServiceNextStep } from "@/hooks/useServiceNextStep";
import { t } from "@/i18n/catalog";
import { getServiceEvents } from "@/services/serviceEventsApi";
import { useAppStore } from "@/store/appStore";
import type { ServiceEvent } from "@/types/generated/ServiceEvent";
import { errorMessage } from "@/utils/errorMessage";
import { frontendLog } from "@/utils/frontendLog";
import type { ServiceActionId, ServiceKind, ServiceModel } from "@/utils/serviceModel";
import { useFileServerActions } from "@/components/ServicesSidebar/useFileServerActions";
import { useServiceEntries } from "@/components/ServicesSidebar/useServiceEntries";
import { useTunnelActions } from "@/components/ServicesSidebar/useTunnelActions";

/** The events of `id`, read again whenever `change` does. */
export function useServiceEvents(id: string, change: string): ServiceEvent[] {
  const [events, setEvents] = useState<ServiceEvent[]>([]);
  useEffect(() => {
    let current = true;
    getServiceEvents(id).then(
      (read) => {
        // Nothing to read from a build without them.
        if (current) setEvents(Array.isArray(read) ? read : []);
      },
      (err: unknown) => frontendLog("service-activity", `events of ${id}: ${errorMessage(err)}`)
    );
    return () => {
      current = false;
    };
  }, [id, change]);
  return events;
}

const NOBODY: Pick<ServiceModel, "id" | "kind" | "name" | "where"> = {
  id: "",
  kind: "tunnel",
  name: "",
  where: { label: "" },
};

/**
 * The model, events and actions of one service for its Activity (#6028,
 * slice 9): what its row does, so both show the same.
 */
export function useServiceActivity(kind: ServiceKind, id: string, onEdit: () => void) {
  const { entries } = useServiceEntries(true);
  const model = entries.find((entry) => entry.model.kind === kind && entry.model.id === id)?.model;
  const events = useServiceEvents(id, model ? `${model.state}|${model.reason ?? ""}` : "");
  const lifecycle = useServiceLifecycleConfirm();
  const modelOf = useCallback(() => model ?? { name: t("service.unnamed") }, [model]);
  const tunnelActions = useTunnelActions(modelOf, lifecycle.request);
  const serverActions = useFileServerActions(modelOf, lifecycle.request);
  const sshConnectionId = useAppStore(
    (s) => s.tunnels.find((tunnel) => tunnel.id === id)?.sshConnectionId
  );
  const onNextStep = useServiceNextStep(model ?? NOBODY, {
    edit: onEdit,
    listenOn: kind === "tunnel" ? tunnelActions.usePort : serverActions.usePort,
    sshConnectionId,
  });

  const onAction = (action: ServiceActionId): void | Promise<void> => {
    const name = model?.name ?? "";
    const server = kind === "fileServer";
    switch (action) {
      case "start":
      case "retry":
        return server ? told("start", name, serverActions.start(id)) : tunnelActions.start(id);
      case "stop":
      case "stopWaiting":
        return server ? told("stop", name, serverActions.stop(id)) : tunnelActions.stop(id);
      case "restart":
        return server
          ? told("restart", name, serverActions.restart(id))
          : tunnelActions.restart(id);
      case "edit":
        return onEdit();
      default:
        return;
    }
  };

  return { model, events, onAction, onNextStep, confirmProps: lifecycle.dialogProps };
}
