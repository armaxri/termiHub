import { Play, Square, Pencil, Copy, Trash2, RotateCw, Info, AlertTriangle } from "lucide-react";
import { Button, Tooltip, toast } from "@/components/ui";
import { TunnelConfig, TunnelState } from "@/types/tunnel";
import { SavedConnection } from "@/types/connection";
import { formatBytes } from "@/utils/formatters";

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
}: TunnelListItemProps) {
  const status = state?.status ?? "disconnected";
  const isActive = status === "connected" || status === "connecting" || status === "reconnecting";
  const isError = status === "error";
  const lastError = state?.error;
  const sshConn = connections.find((c) => c.id === tunnel.sshConnectionId);
  const sshLabel = sshConn?.name ?? "Unknown";
  const typeLabel =
    tunnel.tunnelType.type.charAt(0).toUpperCase() + tunnel.tunnelType.type.slice(1);

  /** Surface the persisted last-error message (View last error affordance). */
  const handleViewError = () => {
    toast.error(`${tunnel.name}: tunnel error`, {
      description: lastError ?? "No error details were recorded.",
    });
  };

  return (
    <div
      className={`tunnel-item${isError ? " tunnel-item--error" : ""}`}
      data-testid={`tunnel-item-${tunnel.id}`}
      onDoubleClick={() => onEdit(tunnel.id)}
    >
      <div className="tunnel-item__header">
        <span
          className={`tunnel-item__status tunnel-item__status--${status}`}
          data-testid={`tunnel-status-${tunnel.id}`}
        />
        <span className="tunnel-item__name" data-testid={`tunnel-name-${tunnel.id}`}>
          {tunnel.name}
        </span>
        <span className="tunnel-item__type-badge" data-testid={`tunnel-type-${tunnel.id}`}>
          {typeLabel}
        </span>
        <div className="tunnel-item__actions">
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
        </div>
      </div>
      <div className="tunnel-item__details">
        <span>{getPortMapping(tunnel)}</span>
        <span>via {sshLabel}</span>
        {isActive && state?.stats && (
          <div className="tunnel-item__stats">
            <span>↑ {formatBytes(state.stats.bytesSent)}</span>
            <span>↓ {formatBytes(state.stats.bytesReceived)}</span>
            <span>{state.stats.activeConnections} conn</span>
          </div>
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
      </div>
    </div>
  );
}
