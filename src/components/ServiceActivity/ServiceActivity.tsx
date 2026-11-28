import type { ReactNode } from "react";
import { MiddleEllipsis } from "@/components/ServiceListItem/MiddleEllipsis";
import { writeText as writeClipboard } from "@tauri-apps/plugin-clipboard-manager";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ActionIcon } from "@/components/ServiceListItem";
import { Button, ConfirmDialog, StatusDot } from "@/components/ui";
import { t, tf } from "@/i18n/catalog";
import { useProjectedAgents } from "@/store/useProjectedAgents";
import { useAppStore } from "@/store/appStore";
import type { ServiceEvent } from "@/types/generated/ServiceEvent";
import { fireAndForget } from "@/utils/frontendLog";
import { hostChoice } from "@/utils/hostChoice";
import { isAgentHost } from "@/utils/runLocation";
import { TunnelDiagram } from "@/components/TunnelEditor/TunnelDiagram";
import { useProjectedConnections } from "@/store/useProjectedConnections";
import type {
  ServiceAction,
  ServiceActionId,
  ServiceKind,
  ServiceModel,
  ServiceNextStep,
} from "@/utils/serviceModel";
import { ServerAccessLog, hostAgentFor } from "./ServerAccessLog";
import {
  ACTIVITY_ACTIONS,
  counters,
  eventLines,
  eventsNote,
  howToUse,
  sinceOf,
} from "./activityText";
import { useServiceActivity } from "./useServiceActivity";
import { ICON_SIZE } from "@/components/ui/iconSize";
import "./ServiceActivity.css";

interface ServiceActivityProps {
  model: ServiceModel;
  events: readonly ServiceEvent[];
  onAction: (id: ServiceActionId) => void | Promise<void>;
  onNextStep: (step: ServiceNextStep) => void | Promise<void>;
  /** A tunnel's path with the part that fails (#6028, slice 10). */
  path?: ReactNode;
  /** The access log of a file server. */
  children?: ReactNode;
}

/**
 * The Activity of a service (#6028, slice 9), one view for both kinds: its state
 * and since when, what to do, the address and how to use it, four counters, then
 * what happened and, for a file server, its requests.
 */
function ServiceActivity({
  model,
  events,
  onAction,
  onNextStep,
  path,
  children,
}: ServiceActivityProps) {
  const { address } = model;
  const offered = model.actions.filter((action) => ACTIVITY_ACTIONS.has(action.id));
  const since = sinceOf(model, events);
  const use = howToUse(model);
  const lines = eventLines(model.kind, events);

  const perform = (id: ServiceActionId): void | Promise<void> => {
    if (id === "copyAddress") return address?.copy ? writeClipboard(address.copy) : undefined;
    if (id === "openInBrowser") {
      const url = address?.copy;
      if (url) fireAndForget(openUrl(url), `open ${url} in browser`);
      return;
    }
    return onAction(id);
  };

  const button = (action: ServiceAction) => (
    <Button
      key={action.id}
      variant={action.id === offered[0]?.id ? "secondary" : "ghost"}
      size="sm"
      icon={<ActionIcon id={action.id} size={ICON_SIZE.xs} />}
      // Copy changes nothing else on screen.
      successFlash={action.id === "copyAddress"}
      onClick={() => perform(action.id)}
      data-testid={`service-activity-action-${action.id}`}
    >
      {action.label}
    </Button>
  );

  return (
    <section
      className="service-activity"
      aria-label={tf("service.activity.label", { name: model.name })}
      data-testid="service-activity"
    >
      <div className="service-activity__state">
        <StatusDot {...model.dot} />
        <span className="service-activity__state-word" data-testid="service-activity-state">
          {model.stateLabel}
        </span>
        {since && (
          <span className="service-activity__muted" data-testid="service-activity-since">
            {since}
          </span>
        )}
        <span className="service-activity__actions">
          {offered.filter(({ id }) => id !== "copyAddress" && id !== "openInBrowser").map(button)}
        </span>
      </div>
      {(model.reason || model.nextSteps.length > 0) && (
        <p className="service-activity__reason" role="status" data-testid="service-activity-reason">
          {model.reason}
          {model.nextSteps.map((step) => (
            <button
              key={step.id}
              type="button"
              className="service-activity__next"
              onClick={() =>
                fireAndForget(Promise.resolve(onNextStep(step)), `${step.id} ${model.id}`)
              }
              data-testid={`service-activity-next-${step.id}`}
            >
              {step.label}
            </button>
          ))}
        </p>
      )}
      {model.failing && path}
      {address?.copy && (
        <div className="service-activity__address">
          {/* One line, never broken inside the host (#6117, F-006). */}
          <code
            className="service-activity__url"
            title={address.copy}
            data-testid="service-activity-address"
          >
            <MiddleEllipsis text={address.copy} />
          </code>
          {offered.filter(({ id }) => id === "copyAddress" || id === "openInBrowser").map(button)}
          <p className="service-activity__muted" data-testid="service-activity-reach">
            {address.on
              ? tf("service.activity.reachOn", { machine: address.on, reach: address.reach })
              : tf("service.activity.reach", { reach: address.reach })}
          </p>
          {use && (
            <p className="service-activity__use" data-testid="service-activity-use">
              {use}
            </p>
          )}
        </div>
      )}
      <dl className="service-activity__counters">
        {counters(model).map((counter) => (
          <div key={counter.id} className="service-activity__counter">
            <dt>{counter.label}</dt>
            <dd data-testid={`service-activity-counter-${counter.id}`}>{counter.value}</dd>
          </div>
        ))}
      </dl>
      <h3 className="service-activity__heading">{t("service.activity.events")}</h3>
      <p className="service-activity__muted">{eventsNote(model)}</p>
      {lines.length === 0 ? (
        <p className="service-activity__muted" data-testid="service-activity-no-events">
          {t("service.activity.events.none")}
        </p>
      ) : (
        <ol className="service-activity__events" data-testid="service-activity-events">
          {lines.map((line, index) => (
            <li
              key={line.key}
              className="service-activity__event"
              data-testid={`service-activity-event-${index}`}
            >
              <span className="service-activity__time">{line.time}</span>
              <StatusDot {...line.dot} pulse={false} size="sm" />
              <span className="service-activity__event-word">{line.label}</span>
              {line.reason && <span className="service-activity__muted">{line.reason}</span>}
            </li>
          ))}
        </ol>
      )}
      {children && (
        <>
          <h3 className="service-activity__heading">{t("service.activity.requests")}</h3>
          {children}
        </>
      )}
    </section>
  );
}

/** The Activity sub-tab of the editor of a saved service, with what it does. */
export function ServiceActivityView({
  kind,
  id,
  onEdit,
}: {
  kind: ServiceKind;
  id: string;
  onEdit: () => void;
}) {
  const { model, events, onAction, onNextStep, confirmProps } = useServiceActivity(
    kind,
    id,
    onEdit
  );
  const server = useAppStore((s) =>
    kind === "fileServer" ? s.embeddedServers.find((item) => item.id === id) : undefined
  );
  const tunnel = useAppStore((s) =>
    kind === "tunnel" ? s.tunnels.find((item) => item.id === id) : undefined
  );
  const { remoteAgents } = useProjectedAgents();
  const { connections } = useProjectedConnections();
  const serverName = tunnel
    ? connections.find((c) => c.id === tunnel.sshConnectionId)?.name
    : undefined;
  if (!model) return null;
  const tunnelHost = tunnel ? hostChoice(tunnel.host) : undefined;
  const agentName =
    tunnelHost && isAgentHost(tunnelHost)
      ? (remoteAgents.find((a) => a.id === tunnelHost.agentId)?.name ?? tunnelHost.agentId)
      : undefined;
  return (
    <>
      <ServiceActivity
        model={model}
        events={events}
        onAction={onAction}
        onNextStep={onNextStep}
        path={
          tunnel && (
            <TunnelDiagram
              tunnelType={tunnel.tunnelType}
              agentName={agentName}
              failing={model.failing}
              serverName={serverName}
            />
          )
        }
      >
        {server && (
          <ServerAccessLog
            serverId={id}
            live={model.state === "running"}
            hostAgent={hostAgentFor(hostChoice(server.host), remoteAgents)}
          />
        )}
      </ServiceActivity>
      <ConfirmDialog {...confirmProps} />
    </>
  );
}
