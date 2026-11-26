import { useCallback, useState } from "react";
import { t, tf, type MessageId } from "@/i18n/catalog";
import type { ServiceModel } from "@/utils/serviceModel";

/** What a stop and a restart have in common: what is open now is dropped. */
export type ServiceLifecycle = "stop" | "restart" | "stopAll";

interface Pending {
  kind: ServiceLifecycle;
  name: string;
  open: number;
  run: () => void | Promise<void>;
}

const TITLE: Record<ServiceLifecycle, MessageId> = {
  stop: "service.confirm.stop.title",
  restart: "service.confirm.restart.title",
  stopAll: "service.confirm.stopAll.title",
};
const LABEL: Record<ServiceLifecycle, MessageId> = {
  stop: "service.action.stop",
  restart: "service.action.restart",
  stopAll: "service.stopAll",
};

export interface ServiceLifecycleConfirm {
  /** Stop or restart a service: at once, or after asking. */
  request: (
    kind: ServiceLifecycle,
    model: Pick<ServiceModel, "name" | "counters">,
    run: () => void | Promise<void>
  ) => void | Promise<void>;
  /** Spread onto the `ConfirmDialog`. */
  dialogProps: {
    open: boolean;
    title: string;
    message: string;
    confirmLabel: string;
    onConfirm: () => void | Promise<void>;
    onCancel: () => void;
  };
}

/**
 * Ask before a stop or a restart only when someone is connected right now
 * (#6068), as for quitting: one rule for tunnels and file servers.
 */
export function useServiceLifecycleConfirm(): ServiceLifecycleConfirm {
  const [pending, setPending] = useState<Pending | null>(null);

  const request = useCallback<ServiceLifecycleConfirm["request"]>((kind, model, run) => {
    const open = model.counters?.active ?? 0;
    if (open === 0) return run();
    setPending({ kind, name: model.name, open, run });
  }, []);

  const onConfirm = useCallback(() => {
    setPending(null);
    return pending?.run();
  }, [pending]);
  const onCancel = useCallback(() => setPending(null), []);

  return {
    request,
    dialogProps: {
      open: pending !== null,
      title: pending ? tf(TITLE[pending.kind], { name: pending.name }) : "",
      message:
        pending === null
          ? ""
          : pending.open === 1
            ? t("service.confirm.drops.one")
            : tf("service.confirm.drops", { count: String(pending.open) }),
      confirmLabel: pending ? t(LABEL[pending.kind]) : "",
      onConfirm,
      onCancel,
    },
  };
}
