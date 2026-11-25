import type React from "react";
import { useState } from "react";
import { ServiceListItem, type ServiceRowAction } from "@/components/ServiceListItem";
import { toast } from "@/components/ui";
import { EmbeddedServerActivityPanel, type ActivityHostAgent } from "./EmbeddedServerActivityPanel";
import { useConnectAgent } from "@/hooks/useConnectAgent";
import { useAppStore } from "@/store/appStore";
import { errorMessage } from "@/utils/errorMessage";
import type { RemoteAgentDefinition } from "@/types/connection";
import { isAgentHost } from "@/utils/runLocation";
import { hostChoice, type HostChoice } from "@/utils/hostChoice";
import { fileServerModel, type ServiceContext, type ServiceNextStep } from "@/utils/serviceModel";
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
  onDuplicate: (id: string) => void;
  onDelete: (id: string) => void;
  /** Listen on another port, and start. */
  onUsePort: (id: string, port: number) => void | Promise<void>;
  /** Roving-tabindex ref wiring the row into the sidebar's keyboard navigation. */
  rowRef?: (el: HTMLDivElement | null) => void;
  /** Roving-tabindex row props (role, tabIndex, aria-level, onFocus) for keyboard nav. */
  rowProps?: React.HTMLAttributes<HTMLDivElement>;
}

/**
 * The agent `runLocation` points at, for the activity panel (#3453). An agent
 * whose capabilities are unknown (not connected) is not flagged unsupported.
 */
export function hostAgentFor(
  runLocation: HostChoice,
  agents: RemoteAgentDefinition[]
): ActivityHostAgent | undefined {
  if (!isAgentHost(runLocation)) return undefined;
  const agent = agents.find((a) => a.id === runLocation.agentId);
  return {
    name: agent?.name ?? "the agent",
    supportsActivity: agent?.capabilities
      ? agent.capabilities.embeddedServerActivity === true
      : true,
  };
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
 * The row of a file server: the shared {@link ServiceListItem} (#6028), plus its
 * expandable Activity (PROD-034/036).
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
  onDuplicate,
  onDelete,
  onUsePort,
  rowRef,
  rowProps,
}: Props) {
  const [showActivity, setShowActivity] = useState(false);
  const model = fileServerModel(config, state, context);
  const host = hostChoice(config.host);
  const connectAgent = useConnectAgent();
  const setUnlockDialogOpen = useAppStore((s) => s.setUnlockDialogOpen);
  const tooltip = serverRowTooltip(config, {
    stats: model.state === "running" ? state?.stats : undefined,
    runsOn: runsOnText(host, agents),
  });

  /** Tell the user what failed, and keep it failed for the button. */
  const told = async (what: string, work: void | Promise<void>): Promise<void> => {
    try {
      await work;
    } catch (err) {
      toast.error(`Failed to ${what} ${config.name}`, { description: errorMessage(err) });
      throw err;
    }
  };

  const onAction = (action: ServiceRowAction): void | Promise<void> => {
    switch (action) {
      case "start":
      case "retry":
        return told("start", onStart(config.id));
      case "stop":
      case "stopWaiting":
        return told("stop", onStop(config.id));
      case "restart":
        return told("restart", onRestart(config.id));
      case "activity":
        return setShowActivity((shown) => !shown);
      case "edit":
        return onEdit(config.id);
      case "duplicate":
        return onDuplicate(config.id);
      case "delete":
        return onDelete(config.id);
    }
  };

  const onNextStep = (step: ServiceNextStep): void | Promise<void> => {
    switch (step.id) {
      case "usePort":
        return step.port === undefined ? undefined : told("start", onUsePort(config.id, step.port));
      case "connectAgent":
        return model.where.agentId === undefined ? undefined : connectAgent(model.where.agentId);
      case "unlock":
        return setUnlockDialogOpen(true);
      case "edit":
        return onEdit(config.id);
      case "chooseConnection":
      case "editConnection":
      case "retryNow":
        // A file server has no SSH connection.
        return;
    }
  };

  return (
    <ServiceListItem
      model={model}
      tooltip={tooltip}
      onAction={onAction}
      onNextStep={onNextStep}
      activity={
        showActivity ? (
          <EmbeddedServerActivityPanel
            serverId={config.id}
            live={model.state === "running"}
            hostAgent={hostAgentFor(host, agents)}
            onClose={() => setShowActivity(false)}
          />
        ) : undefined
      }
      rowRef={rowRef}
      rowProps={rowProps}
    />
  );
}
