import { Play, Square, Pencil, Copy, Trash2 } from "lucide-react";
import { TunnelConfig, TunnelState } from "@/types/tunnel";
import { SavedConnection } from "@/types/connection";
import { formatBytes } from "./formatBytes";

interface TunnelListItemProps {
  tunnel: TunnelConfig;
  state: TunnelState | undefined;
  connections: SavedConnection[];
  onStart: (tunnelId: string) => void;
  onStop: (tunnelId: string) => void;
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
  onEdit,
  onDuplicate,
  onDelete,
}: TunnelListItemProps) {
  const status = state?.status ?? "disconnected";
  const isActive = status === "connected" || status === "connecting" || status === "reconnecting";
  const sshConn = connections.find((c) => c.id === tunnel.sshConnectionId);
  const sshLabel = sshConn?.name ?? "Unknown";
  const typeLabel =
    tunnel.tunnelType.type.charAt(0).toUpperCase() + tunnel.tunnelType.type.slice(1);

  return (
    <div className="tunnel-item" onDoubleClick={() => onEdit(tunnel.id)}>
      <div className="tunnel-item__header">
        <span className={`tunnel-item__status tunnel-item__status--${status}`} />
        <span className="tunnel-item__name">{tunnel.name}</span>
        <span className="tunnel-item__type-badge">{typeLabel}</span>
        <div className="tunnel-item__actions">
          {isActive ? (
            <button
              className="tunnel-item__action"
              title="Stop"
              onClick={(e) => {
                e.stopPropagation();
                onStop(tunnel.id);
              }}
            >
              <Square size={12} />
            </button>
          ) : (
            <button
              className="tunnel-item__action"
              title="Start"
              onClick={(e) => {
                e.stopPropagation();
                onStart(tunnel.id);
              }}
            >
              <Play size={12} />
            </button>
          )}
          <button
            className="tunnel-item__action"
            title="Edit"
            onClick={(e) => {
              e.stopPropagation();
              onEdit(tunnel.id);
            }}
          >
            <Pencil size={12} />
          </button>
          <button
            className="tunnel-item__action"
            title="Duplicate"
            onClick={(e) => {
              e.stopPropagation();
              onDuplicate(tunnel.id);
            }}
          >
            <Copy size={12} />
          </button>
          <button
            className="tunnel-item__action"
            title="Delete"
            onClick={(e) => {
              e.stopPropagation();
              onDelete(tunnel.id);
            }}
          >
            <Trash2 size={12} />
          </button>
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
        {status === "error" && state?.error && (
          <span style={{ color: "var(--color-error)" }}>{state.error}</span>
        )}
      </div>
    </div>
  );
}
