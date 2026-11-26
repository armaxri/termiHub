import { useCallback, useState } from "react";
import { t, tf, type MessageId } from "@/i18n/catalog";
import type { ServiceModel } from "@/utils/serviceModel";

/** What a stop and a restart have in common: what is open now is dropped. */
export type ServiceLifecycle = "stop" | "restart" | "stopAll";

interface Pending {
  kind: ServiceLifecycle;
  name: string;
  open: number;
  /** For Stop all: each service in use and how many are connected to it. */
  inUse: InUse[];
  run: () => void | Promise<void>;
}

/** A service someone is connected to now, and how many are. */
export interface InUse {
  name: string;
  count: number;
}

/** Who a stop or a restart cuts off, by service (#6117, F-002). */
export function cutOffText(kind: ServiceLifecycle, open: number, inUse: readonly InUse[]): string {
  if (kind === "stopAll" && inUse.length > 0) {
    const list = inUse
      .map((item) =>
        tf("service.confirm.inUse.item", { name: item.name, count: String(item.count) })
      )
      .join(", ");
    return tf(
      inUse.length === 1 ? "service.confirm.inUse.stopAll.one" : "service.confirm.inUse.stopAll",
      {
        list,
      }
    );
  }
  const verb = kind === "restart" ? "restart" : "stop";
  return open === 1
    ? t(`service.confirm.inUse.${verb}.one`)
    : tf(`service.confirm.inUse.${verb}`, { count: String(open) });
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
    run: () => void | Promise<void>,
    inUse?: readonly InUse[]
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

  const request = useCallback<ServiceLifecycleConfirm["request"]>(
    (kind, model, run, inUse = []) => {
      const open = model.counters?.active ?? 0;
      if (open === 0) return run();
      setPending({ kind, name: model.name, open, inUse: [...inUse], run });
    },
    []
  );

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
      message: pending === null ? "" : cutOffText(pending.kind, pending.open, pending.inUse),
      confirmLabel: pending ? t(LABEL[pending.kind]) : "",
      onConfirm,
      onCancel,
    },
  };
}
