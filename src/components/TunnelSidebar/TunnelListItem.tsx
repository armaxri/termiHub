import type React from "react";
import {
  Play,
  Square,
  Pencil,
  Copy,
  Trash2,
  RotateCw,
  Info,
  AlertTriangle,
  Monitor,
  Server,
} from "lucide-react";
import { Button, Tooltip, toast } from "@/components/ui";
import { SidebarListItem, SidebarStatusDot } from "@/components/SidebarListItem";
import type { SidebarStatusTone } from "@/components/SidebarListItem";
import { TunnelConfig, TunnelState, TunnelStatus } from "@/types/tunnel";
import { SavedConnection } from "@/types/connection";
import { formatBytes } from "@/utils/formatters";
import { useAppStore } from "@/store/appStore";
import {
  resolveTunnelHost,
  isAgentHost,
  tunnelHostBadge,
  reportedReachability,
} from "@/utils/tunnelHost";

interface TunnelListItemProps {
  tunnel: TunnelConfig;
  state: TunnelState | undefined;
  connections: SavedConnection[];
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
}

/** Get the port mapping display string for a tunnel. */
function getPortMapping(tunnel: TunnelConfig): string {
  switch (tunnel.tunnelType.type) {
    case "local":
      return `${tunnel.tunnelType.config.localHost}:${tunnel.tunnelType.config.localPort} → ${tunnel.tunnelType.config.remoteHost}:${tunnel.tunnelType.config.remotePort}`;
    case "remote":
      return `${tunnel.tunnelType.config.remoteHost}:${tunnel.tunnelType.config.remotePort} → ${tunnel.tunnelType.config.localHost}:${tunnel.tunnelType.config.localPort}`;
    case "dynamic":
      return `${tunnel.tunnelType.config.localHost}:${tunnel.tunnelType.config.localPort}`;
  }
}

/** Map a tunnel status onto the shared status-dot tone. */
function statusTone(status: TunnelStatus): SidebarStatusTone {
  switch (status) {
    case "connected":
      return "success";
    case "connecting":
    case "reconnecting":
      return "warning";
    case "error":
      return "error";
    default:
      return "neutral";
  }
}

/**
 * A single SSH tunnel entry in the Tunnels sidebar. Composes the shared
 * {@link SidebarListItem} shell (status dot / badge / name / actions / details)
 * so tunnel rows share one structure and token'd styling with the other
 * management sidebars; only the stats / error / reconnecting detail lines stay
 * tunnel-specific.
 */
export function TunnelListItem({
  tunnel,
  state,
  connections,
  onStart,
  onStop,
  onReconnect,
  onEdit,
  onDuplicate,
  onDelete,
  rowRef,
  rowProps,
}: TunnelListItemProps) {
  const remoteAgents = useAppStore((s) => s.remoteAgents);
  const status = state?.status ?? "disconnected";
  const isActive = status === "connected" || status === "connecting" || status === "reconnecting";
  const isError = status === "error";
  const lastError = state?.error;
  const sshConn = connections.find((c) => c.id === tunnel.sshConnectionId);
  const sshLabel = sshConn?.name ?? "Unknown";

  // Vantage badge: which machine hosts this tunnel (S3, #2155). Always shown,
  // including "this computer" for desktop tunnels.
  const tunnelHost = resolveTunnelHost(tunnel);
  const hostAgentName = isAgentHost(tunnelHost)
    ? (remoteAgents.find((a) => a.id === tunnelHost.agentId)?.name ?? tunnelHost.agentId)
    : undefined;
  const hostBadge = tunnelHostBadge(tunnelHost, hostAgentName);
  // Runtime vantage from the agent's report (#2199): authoritative reachability
  // for a running agent-hosted tunnel, surfaced only while it is active.
  const reach =
    isActive && state?.reachableFrom
      ? reportedReachability(state.reachableFrom, hostBadge.label)
      : null;
  const typeLabel =
    tunnel.tunnelType.type.charAt(0).toUpperCase() + tunnel.tunnelType.type.slice(1);

  /** Surface the persisted last-error message (View last error affordance). */
  const handleViewError = () => {
    toast.error(`${tunnel.name}: tunnel error`, {
      description: lastError ?? "No error details were recorded.",
    });
  };

  return (
    <SidebarListItem
      ref={rowRef}
      {...rowProps}
      testId={`tunnel-item-${tunnel.id}`}
      nameTestId={`tunnel-name-${tunnel.id}`}
      name={tunnel.name}
      error={isError}
      onDoubleClick={() => onEdit(tunnel.id)}
      status={<SidebarStatusDot tone={statusTone(status)} testId={`tunnel-status-${tunnel.id}`} />}
      badge={typeLabel}
      badgeTestId={`tunnel-type-${tunnel.id}`}
      actions={
        <>
          {status === "connected" && (
            <Tooltip content="Reconnect (force)" side="top">
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                aria-label="Reconnect"
                data-testid={`tunnel-reconnect-${tunnel.id}`}
                icon={<RotateCw size={12} />}
                errorToast={false}
                onClick={(e) => {
                  e.stopPropagation();
                  return onReconnect(tunnel.id);
                }}
              />
            </Tooltip>
          )}
          {isActive && (
            <Tooltip content="Stop" side="top">
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                aria-label="Stop"
                data-testid={`tunnel-stop-${tunnel.id}`}
                icon={<Square size={12} />}
                // The store surfaces its own start/stop toast; suppress the
                // Button's duplicate error toast and keep the pending spinner.
                errorToast={false}
                onClick={(e) => {
                  e.stopPropagation();
                  return onStop(tunnel.id);
                }}
              />
            </Tooltip>
          )}
          {isError && (
            <>
              <Tooltip content="View last error" side="top">
                <Button
                  variant="ghost"
                  size="sm"
                  iconOnly
                  aria-label="View last error"
                  data-testid={`tunnel-view-error-${tunnel.id}`}
                  icon={<Info size={12} />}
                  onClick={(e) => {
                    e.stopPropagation();
                    handleViewError();
                  }}
                />
              </Tooltip>
              <Tooltip content="Retry" side="top">
                <Button
                  variant="ghost"
                  size="sm"
                  iconOnly
                  aria-label="Retry"
                  data-testid={`tunnel-retry-${tunnel.id}`}
                  icon={<RotateCw size={12} />}
                  errorToast={false}
                  onClick={(e) => {
                    e.stopPropagation();
                    return onStart(tunnel.id);
                  }}
                />
              </Tooltip>
            </>
          )}
          {!isActive && !isError && (
            <Tooltip content="Start" side="top">
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                aria-label="Start"
                data-testid={`tunnel-start-${tunnel.id}`}
                icon={<Play size={12} />}
                errorToast={false}
                onClick={(e) => {
                  e.stopPropagation();
                  return onStart(tunnel.id);
                }}
              />
            </Tooltip>
          )}
          <Tooltip content="Edit" side="top">
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              aria-label="Edit"
              data-testid={`tunnel-edit-${tunnel.id}`}
              icon={<Pencil size={12} />}
              onClick={(e) => {
                e.stopPropagation();
                onEdit(tunnel.id);
              }}
            />
          </Tooltip>
          <Tooltip content="Duplicate" side="top">
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              aria-label="Duplicate"
              data-testid={`tunnel-duplicate-${tunnel.id}`}
              icon={<Copy size={12} />}
              onClick={(e) => {
                e.stopPropagation();
                onDuplicate(tunnel.id);
              }}
            />
          </Tooltip>
          <Tooltip content="Delete" side="top">
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              aria-label="Delete"
              data-testid={`tunnel-delete-${tunnel.id}`}
              icon={<Trash2 size={12} />}
              onClick={(e) => {
                e.stopPropagation();
                onDelete(tunnel.id);
              }}
            />
          </Tooltip>
        </>
      }
      details={
        <>
          <span>{getPortMapping(tunnel)}</span>
          <span>via {sshLabel}</span>
          <span
            className="tunnel-item__host"
            data-testid={`tunnel-host-${tunnel.id}`}
            data-on-agent={hostBadge.onAgent}
            title={
              hostBadge.onAgent ? `Hosted on agent ${hostBadge.label}` : "Hosted on this computer"
            }
          >
            {hostBadge.onAgent ? (
              <Server size={11} className="tunnel-item__host-icon" />
            ) : (
              <Monitor size={11} className="tunnel-item__host-icon" />
            )}
            <span className="tunnel-item__host-label">{hostBadge.label}</span>
          </span>
          {isActive && state?.stats && (
            <div className="tunnel-item__stats">
              <span>↑ {formatBytes(state.stats.bytesSent)}</span>
              <span>↓ {formatBytes(state.stats.bytesReceived)}</span>
              <span>{state.stats.activeConnections} conn</span>
            </div>
          )}
          {reach && (
            <span
              className="tunnel-item__reach"
              data-testid={`tunnel-reach-${tunnel.id}`}
              data-warn={reach.warn}
              title={
                state?.boundAddress ? `Bound ${state.boundAddress} — ${reach.label}` : reach.label
              }
            >
              {reach.warn && <AlertTriangle size={11} className="tunnel-item__reach-icon" />}
              <span className="tunnel-item__reach-text">{reach.label}</span>
            </span>
          )}
          {isError && lastError && (
            <span className="tunnel-item__error" title={lastError}>
              <AlertTriangle size={12} className="tunnel-item__error-icon" />
              <span className="tunnel-item__error-text">{lastError}</span>
            </span>
          )}
          {status === "reconnecting" && lastError && (
            <span className="tunnel-item__reconnecting" title={lastError}>
              <RotateCw size={12} className="tunnel-item__reconnecting-icon" />
              <span className="tunnel-item__reconnecting-text">{lastError}</span>
            </span>
          )}
        </>
      }
    />
  );
}
