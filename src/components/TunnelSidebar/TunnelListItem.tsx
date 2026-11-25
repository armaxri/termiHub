import type React from "react";
import { AlertTriangle, Link2 } from "lucide-react";
import { ServiceListItem, type ServiceRowAction } from "@/components/ServiceListItem";
import type { TunnelConfig, TunnelState } from "@/types/tunnel";
import { useByteRate } from "@/hooks/useByteRate";
import { tunnelModel, type ServiceContext } from "@/utils/serviceModel";
import {
  resolveTunnelHost,
  isAgentHost,
  tunnelHostBadge,
  reportedReachability,
} from "@/utils/tunnelHost";
import { pairStatusLabel, type PairStatus } from "@/utils/tunnelChain";
import { tunnelRowTooltip } from "./tunnelRowTooltip";

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
  /** Roving-tabindex ref wiring the row into the sidebar's keyboard navigation. */
  rowRef?: (el: HTMLDivElement | null) => void;
  /** Roving-tabindex row props (role, tabIndex, aria-level, onFocus) for keyboard nav. */
  rowProps?: React.HTMLAttributes<HTMLDivElement>;
  /**
   * Render this row as a chained **companion** (#2597) — nested under its parent
   * with a link badge and its own "this computer" host badge.
   */
  nested?: boolean;
  /**
   * The combined pair status when this row belongs to a chained pair — shown as a
   * "Linked · …" chip so the user reasons about whether `localhost:PORT` works. On
   * the nested companion row a `degraded` status also renders the inline fix.
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
  rowRef,
  rowProps,
  nested = false,
  pairStatus,
  companionRedundant = false,
  onRemoveCompanion,
}: TunnelListItemProps) {
  const model = tunnelModel(tunnel, state, context);
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
  const pairLabel =
    !nested && pairStatus && pairStatus !== "none" ? pairStatusLabel(pairStatus) : null;
  const pairWarn = pairStatus === "degraded" || pairStatus === "down";
  const tooltip = tunnelRowTooltip(tunnel, {
    sshLabel: context.connections.find((c) => c.id === tunnel.sshConnectionId)?.name ?? "Unknown",
    host: hostBadge,
    stats: running ? state?.stats : undefined,
    upRate,
    downRate,
    reach: reach?.label,
    boundAddress: state?.boundAddress,
    pair: pairLabel && !pairWarn ? pairLabel : null,
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

  const extras = (
    <>
      {pairLabel && pairWarn && (
        <span
          className="tunnel-item__pair"
          data-testid={`tunnel-pair-status-${tunnel.id}`}
          data-warn={pairWarn}
        >
          <AlertTriangle size={11} className="tunnel-item__pair-icon" />
          <Link2 size={11} className="tunnel-item__pair-icon" aria-hidden="true" />
          <span>{pairLabel}</span>
        </span>
      )}
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
      {nested && pairStatus === "degraded" && (
        <span
          className="tunnel-item__degraded-fix"
          data-testid={`tunnel-degraded-fix-${tunnel.id}`}
        >
          <AlertTriangle size={11} className="tunnel-item__degraded-icon" />
          <span>Hop down — localhost is unreachable.</span>
          <button
            type="button"
            className="tunnel-item__inline-action"
            onClick={(e) => {
              e.stopPropagation();
              return onStart(tunnel.id);
            }}
            data-testid={`tunnel-degraded-retry-${tunnel.id}`}
          >
            Retry
          </button>
          <button
            type="button"
            className="tunnel-item__inline-action"
            onClick={(e) => {
              e.stopPropagation();
              onEdit(tunnel.id);
            }}
            data-testid={`tunnel-degraded-port-${tunnel.id}`}
          >
            Use a different local port
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
      onNextStep={() => onEdit(tunnel.id)}
      extras={extras}
      className={nested ? "tunnel-item--nested" : undefined}
      nameMark={
        nested && (
          <Link2 size={12} className="tunnel-item__link-icon" aria-label="Chained companion" />
        )
      }
      rowRef={rowRef}
      rowProps={rowProps}
    />
  );
}
