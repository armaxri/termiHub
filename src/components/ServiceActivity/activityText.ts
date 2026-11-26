/**
 * What the Activity of a service says (#6028, slice 9), for both kinds. Pure, so
 * every line is a table test.
 */
import { t, tf, type MessageId } from "@/i18n/catalog";
import type { ServiceEvent } from "@/types/generated/ServiceEvent";
import type { ServerStatus } from "@/types/embeddedServer";
import type { TunnelStatus } from "@/types/tunnel";
import { formatBytes, formatClockTime } from "@/utils/formatters";
import type { ServiceActionId, ServiceKind, ServiceModel } from "@/utils/serviceModel";
import {
  serverServiceState,
  serviceStateDot,
  serviceStateLabel,
  tunnelServiceState,
  type ServiceState,
} from "@/utils/serviceState";

/** The actions Activity offers; Edit is the other sub-tab, the rest stay on the row. */
export const ACTIVITY_ACTIONS: ReadonlySet<ServiceActionId> = new Set([
  "start",
  "stop",
  "stopWaiting",
  "retry",
  "restart",
  "copyAddress",
  "openInBrowser",
]);

/** The state an event names, in the words of the row. */
export function eventState(kind: ServiceKind, status: string): ServiceState {
  const state =
    kind === "tunnel"
      ? tunnelServiceState(status as TunnelStatus)
      : serverServiceState(status as ServerStatus);
  // A status this build does not know yet reads as stopped, never as a crash.
  return state ?? "stopped";
}

/** One line of what happened. */
export interface EventLine {
  key: string;
  time: string;
  label: string;
  reason?: string;
  dot: ReturnType<typeof serviceStateDot>;
}

/** The events of a service, the newest first. */
export function eventLines(kind: ServiceKind, events: readonly ServiceEvent[]): EventLine[] {
  return events
    .map((event, index) => {
      const state = eventState(kind, event.status);
      return {
        key: `${event.atMs}-${index}`,
        time: formatClockTime(event.atMs),
        label: serviceStateLabel(state),
        reason: event.reason,
        dot: serviceStateDot(state),
      };
    })
    .reverse();
}

/** "Since 14:20:03", when the last event is the state it is in now. */
export function sinceOf(
  model: Pick<ServiceModel, "kind" | "state">,
  events: readonly ServiceEvent[]
): string | undefined {
  const last = events[events.length - 1];
  if (!last || eventState(model.kind, last.status) !== model.state) return undefined;
  return tf("service.activity.since", { time: formatClockTime(last.atMs) });
}

const HOW_TO_USE: Record<ServiceModel["type"], MessageId> = {
  local: "service.activity.use.local",
  remote: "service.activity.use.remote",
  dynamic: "service.activity.use.dynamic",
  http: "service.activity.use.http",
  ftp: "service.activity.use.ftp",
  tftp: "service.activity.use.tftp",
};

/** How to use the address, in one line per type; none while there is none. */
export function howToUse(model: Pick<ServiceModel, "type" | "address">): string | undefined {
  return model.address?.copy ? t(HOW_TO_USE[model.type]) : undefined;
}

/** One of the four counters. */
export interface Counter {
  id: "now" | "total" | "sent" | "received";
  label: string;
  value: string;
}

/** The four counters; zero while it does not run, so they do not jump around. */
export function counters(model: Pick<ServiceModel, "counters">): Counter[] {
  const c = model.counters ?? { active: 0, total: 0, sent: 0, received: 0 };
  return [
    { id: "now", label: t("service.activity.now"), value: String(c.active) },
    { id: "total", label: t("service.activity.total"), value: String(c.total) },
    { id: "sent", label: t("service.activity.sent"), value: formatBytes(c.sent) },
    { id: "received", label: t("service.activity.received"), value: formatBytes(c.received) },
  ];
}

/** What the list of events says about where they come from. */
export function eventsNote(model: Pick<ServiceModel, "where">): string {
  return t(
    model.where.agentId === undefined
      ? "service.activity.events.note"
      : "service.activity.events.agent"
  );
}
