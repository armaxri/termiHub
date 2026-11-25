import type React from "react";
import { AlertTriangle, Link2 } from "lucide-react";
import { useConnectAgent } from "@/hooks/useConnectAgent";
import { useAppStore } from "@/store/appStore";
import { ServiceListItem, type ServiceRowAction } from "@/components/ServiceListItem";
import type { TunnelConfig, TunnelState } from "@/types/tunnel";
import { useByteRate } from "@/hooks/useByteRate";
import {
  tunnelModel,
  withoutAgent,
  type ServiceContext,
  type ServiceNextStep,
} from "@/utils/serviceModel";
import {
  resolveTunnelHost,
  isAgentHost,
  tunnelHostBadge,
  reportedReachability,
} from "@/utils/tunnelHost";
import type { PairStatus } from "@/utils/tunnelChain";
import { tunnelRowTooltip } from "./tunnelRowTooltip";
import "./TunnelListItem.css";

interface TunnelListItemProps {
  tunnel: TunnelConfig;
  state: TunnelState | undefined;
  /** The agents, connections and network around it. */
  context: ServiceContext;
  /** Start (also Retry) the tunnel. May be async so the button shows a pending state. */
  onStart: (tunnelId: string) => void | Promise<void>;
  /** Stop the tunnel. May be async so the button shows a pending state. */
  onStop: (tunnelId: string) => void | Promise<void>;
  /**
   * Force-reconnect a connected tunnel (tear down + restart) even if liveness
   * has not fired yet — covers a stale-but-green tunnel the supervisor is slow
   * to notice (#1243). May be async so the button shows a pending state.
   */
  onReconnect: (tunnelId: string) => void | Promise<void>;
  onEdit: (tunnelId: string) => void;
  onDuplicate: (tunnelId: string) => void;
  onDelete: (tunnelId: string) => void;
  /** Listen on another port of this computer, and start. */
  onUsePort: (tunnelId: string, port: number) => void | Promise<void>;
  /** Roving-tabindex ref wiring the row into the sidebar's keyboard navigation. */
  rowRef?: (el: HTMLDivElement | null) => void;
  /** Roving-tabindex row props (role, tabIndex, aria-level, onFocus) for keyboard nav. */
  rowProps?: React.HTMLAttributes<HTMLDivElement>;
  /**
   * Render this row as a chained **companion** (#2597) — nested under its parent
   * with a link badge and its own "this computer" host badge.
   */
  nested?: boolean;
  /** Whether the row stands under its agent's line, which says what it shares. */
  underAgent?: boolean;
  /**
   * The combined pair status when this row belongs to a chained pair: whether
   * `localhost:PORT` works here, which the parent's row says when it does not.
   */
  pairStatus?: PairStatus;
  /**
   * True when this parent's companion has become redundant (the parent was
   * widened or re-hosted to this computer) — offers to remove the stale hop.
   */
  companionRedundant?: boolean;
  /** Remove the linked companion (redundant-hop cleanup, or the degraded fix). */
  onRemoveCompanion?: () => void;
}

/**
 * The row of an SSH tunnel: the shared {@link ServiceListItem} (#6028), plus what
 * only a tunnel has, the state of a chained hop (#2597). The forwarding, the host
 * and the traffic are in its tooltip (#5770).
 */
export function TunnelListItem({
  tunnel,
  state,
  context,
  onStart,
  onStop,
  onReconnect,
  onEdit,
  onDuplicate,
  onDelete,
  onUsePort,
  rowRef,
  rowProps,
  nested = false,
  underAgent = false,
  pairStatus,
  companionRedundant = false,
  onRemoveCompanion,
}: TunnelListItemProps) {
  const own = tunnelModel(
    tunnel,
    state,
    context,
    pairStatus && { role: nested ? "hop" : "parent", status: pairStatus }
  );
  const model = underAgent ? withoutAgent(own) : own;
  const connectAgent = useConnectAgent();
  const openConnectionEditorTab = useAppStore((s) => s.openConnectionEditorTab);
  const checkTunnelsAgain = useAppStore((s) => s.checkTunnelsAgain);
  const keepTunnelRunning = useAppStore((s) => s.keepTunnelRunning);
  const retryTunnelNow = useAppStore((s) => s.retryTunnelNow);
  const setUnlockDialogOpen = useAppStore((s) => s.setUnlockDialogOpen);
  const running = model.state === "running";
  // Live up/down throughput (PROD-038), smoothed from the cumulative counters.
  const sampling = running && !!state?.stats;
  const upRate = useByteRate(state?.stats?.bytesSent, sampling);
  const downRate = useByteRate(state?.stats?.bytesReceived, sampling);

  const tunnelHost = resolveTunnelHost(tunnel);
  const hostAgentName = isAgentHost(tunnelHost)
    ? (context.agents.find((a) => a.id === tunnelHost.agentId)?.name ?? tunnelHost.agentId)
    : undefined;
  const hostBadge = tunnelHostBadge(tunnelHost, hostAgentName);
  const reach =
    running && state?.reachableFrom
      ? reportedReachability(state.reachableFrom, hostBadge.label)
      : null;
  const tooltip = tunnelRowTooltip(tunnel, {
    sshLabel: context.connections.find((c) => c.id === tunnel.sshConnectionId)?.name ?? "Unknown",
    host: hostBadge,
    stats: running ? state?.stats : undefined,
    upRate,
    downRate,
    reach: reach?.label,
    boundAddress: state?.boundAddress,
  });

  const onAction = (action: ServiceRowAction): void | Promise<void> => {
    switch (action) {
      case "start":
      case "retry":
        return onStart(tunnel.id);
      case "stop":
      case "stopWaiting":
        return onStop(tunnel.id);
      case "restart":
        return onReconnect(tunnel.id);
      case "edit":
        return onEdit(tunnel.id);
      case "duplicate":
        return onDuplicate(tunnel.id);
      case "delete":
        return onDelete(tunnel.id);
      case "activity":
        return;
    }
  };

  const onNextStep = (step: ServiceNextStep): void | Promise<void> => {
    switch (step.id) {
      case "chooseConnection":
      case "chooseMachine":
      case "edit":
        return onEdit(tunnel.id);
      case "usePort":
        return step.port === undefined ? undefined : onUsePort(tunnel.id, step.port);
      case "connectAgent":
        return model.where.agentId === undefined ? undefined : connectAgent(model.where.agentId);
      case "checkAgain":
        return checkTunnelsAgain();
      case "keepRunning":
        return keepTunnelRunning(tunnel.id);
      case "letReach":
        // A tunnel has no kind that only others can use.
        return;
      case "unlock":
        return setUnlockDialogOpen(true);
      case "editConnection":
        return openConnectionEditorTab(tunnel.sshConnectionId);
      case "retryNow":
        return retryTunnelNow(tunnel.id);
    }
  };

  const extras = (
    <>
      {companionRedundant && onRemoveCompanion && (
        <span className="tunnel-item__redundant" data-testid={`tunnel-redundant-${tunnel.id}`}>
          <AlertTriangle size={11} className="tunnel-item__redundant-icon" />
          <span>Linked hop is now redundant.</span>
          <button
            type="button"
            className="tunnel-item__inline-action"
            onClick={(e) => {
              e.stopPropagation();
              onRemoveCompanion();
            }}
            data-testid={`tunnel-remove-redundant-${tunnel.id}`}
          >
            Remove hop
          </button>
        </span>
      )}
    </>
  );

  return (
    <ServiceListItem
      model={model}
      tooltip={tooltip}
      onAction={onAction}
      onNextStep={onNextStep}
      extras={extras}
      className={nested ? "tunnel-item--nested" : undefined}
      nameMark={nested && <Link2 size={12} className="tunnel-item__link-icon" aria-hidden="true" />}
      rowRef={rowRef}
      rowProps={rowProps}
    />
  );
}
