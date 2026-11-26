import type React from "react";
import { ServiceListItem, type ServiceRowAction } from "@/components/ServiceListItem";
import { told, useServiceNextStep } from "@/hooks/useServiceNextStep";
import type { RemoteAgentDefinition } from "@/types/connection";
import { isAgentHost } from "@/utils/runLocation";
import { hostChoice, type HostChoice } from "@/utils/hostChoice";
import { fileServerModel, withoutAgent, type ServiceContext } from "@/utils/serviceModel";
import { t, tf } from "@/i18n/catalog";
import type { EmbeddedServerConfig, ServerState } from "@/types/embeddedServer";
import { serverRowTooltip } from "./serverRowTooltip";

interface Props {
  config: EmbeddedServerConfig;
  state: ServerState | undefined;
  /** Configured agents, to say what the one it runs on supports. */
  agents?: RemoteAgentDefinition[];
  /** The agents, connections and network around it. */
  context: ServiceContext;
  onStart: (id: string) => void | Promise<void>;
  onStop: (id: string) => void | Promise<void>;
  onRestart: (id: string) => void | Promise<void>;
  onEdit: (id: string) => void;
  /** Open its editor on Activity (#6028, slice 9). */
  onActivity?: (id: string) => void;
  onDuplicate: (id: string) => void;
  onDelete: (id: string) => void;
  /** Listen on another port, and start. */
  onUsePort: (id: string, port: number) => void | Promise<void>;
  /** Whether the row stands under its agent's line, which says what it shares. */
  underAgent?: boolean;
  /** Roving-tabindex ref wiring the row into the sidebar's keyboard navigation. */
  rowRef?: (el: HTMLDivElement | null) => void;
  /** Roving-tabindex row props (role, tabIndex, aria-level, onFocus) for keyboard nav. */
  rowProps?: React.HTMLAttributes<HTMLDivElement>;
}

/** "Runs on …" for the row's tooltip. */
function runsOnText(runLocation: HostChoice, agents: RemoteAgentDefinition[]): string {
  if (runLocation.kind === "unreadable") return t("service.host.unreadable");
  if (!isAgentHost(runLocation)) return t("server.tooltip.here");
  const agent = agents.find((a) => a.id === runLocation.agentId);
  return agent
    ? tf("server.tooltip.agent", { agent: agent.name })
    : t("server.tooltip.agentRemoved");
}

/**
 * The row of a file server: the shared {@link ServiceListItem} (#6028). Its
 * Activity opens in its editor (slice 9).
 */
export function EmbeddedServerItem({
  config,
  state,
  agents = [],
  context,
  onStart,
  onStop,
  onRestart,
  onEdit,
  onActivity,
  onDuplicate,
  onDelete,
  onUsePort,
  underAgent = false,
  rowRef,
  rowProps,
}: Props) {
  const own = fileServerModel(config, state, context);
  const model = underAgent ? withoutAgent(own) : own;
  const host = hostChoice(config.host);
  const tooltip = serverRowTooltip(config, {
    stats: model.state === "running" ? state?.stats : undefined,
    runsOn: runsOnText(host, agents),
    onAgent: host.kind === "agent",
  });

  const onNextStep = useServiceNextStep(model, { edit: onEdit, listenOn: onUsePort });
  const tell = (what: string, work: void | Promise<void>) => told(what, config.name, work);

  const onAction = (action: ServiceRowAction): void | Promise<void> => {
    switch (action) {
      case "start":
      case "retry":
        return tell("start", onStart(config.id));
      case "stop":
      case "stopWaiting":
        return tell("stop", onStop(config.id));
      case "restart":
        return tell("restart", onRestart(config.id));
      case "activity":
        return onActivity?.(config.id);
      case "edit":
        return onEdit(config.id);
      case "duplicate":
        return onDuplicate(config.id);
      case "delete":
        return onDelete(config.id);
    }
  };

  return (
    <ServiceListItem
      model={model}
      tooltip={tooltip}
      onAction={onAction}
      onNextStep={onNextStep}
      rowRef={rowRef}
      rowProps={rowProps}
    />
  );
}
