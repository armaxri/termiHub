import { Play, Square, Pencil, Copy, Trash2, ExternalLink, Clipboard } from "lucide-react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import { writeText as writeClipboard } from "@tauri-apps/plugin-clipboard-manager";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  EmbeddedServerConfig,
  ServerState,
  ServerStats,
  ServerStatus,
  PROTOCOL_LABELS,
} from "@/types/embeddedServer";

interface Props {
  config: EmbeddedServerConfig;
  state: ServerState | undefined;
  onStart: (id: string) => void;
  onStop: (id: string) => void;
  onEdit: (id: string) => void;
  onDuplicate: (id: string) => void;
  onDelete: (id: string) => void;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function serverUrl(config: EmbeddedServerConfig): string {
  const scheme = config.serverType === "ftp" ? "ftp" : config.serverType;
  return `${scheme}://${config.bindHost}:${config.port}`;
}

function statusClass(status: ServerStatus | undefined): string {
  switch (status) {
    case "running":
      return "server-item__status--running";
    case "starting":
    case "stopping":
      return "server-item__status--pending";
    case "error":
      return "server-item__status--error";
    default:
      return "server-item__status--stopped";
  }
}

function isActive(status: ServerStatus | undefined): boolean {
  return status === "running" || status === "starting" || status === "stopping";
}

/**
 * A single embedded server entry in the Services sidebar.
 */
export function EmbeddedServerItem({
  config,
  state,
  onStart,
  onStop,
  onEdit,
  onDuplicate,
  onDelete,
}: Props) {
  const status = state?.status;
  const active = isActive(status);
  const url = serverUrl(config);

  const handleCopyUrl = () => {
    writeClipboard(url).catch(() => {});
  };

  const handleOpenBrowser = () => {
    if (config.serverType === "http") {
      openUrl(url).catch(() => {});
    }
  };

  const statsLine = (stats: ServerStats) =>
    `${stats.activeConnections} conn · ↑ ${formatBytes(stats.bytesSent)} ↓ ${formatBytes(stats.bytesReceived)}`;

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <div
          className="server-item"
          data-testid={`server-item-${config.id}`}
          onDoubleClick={() => onEdit(config.id)}
        >
          <div className="server-item__header">
            <span
              className={`server-item__status ${statusClass(status)}`}
              data-testid={`server-status-${config.id}`}
            />
            <span className="server-item__badge" data-testid={`server-type-${config.id}`}>
              {PROTOCOL_LABELS[config.serverType]}
            </span>
            <span className="server-item__name" data-testid={`server-name-${config.id}`}>
              {config.name}
            </span>
            <div className="server-item__actions">
              {active ? (
                <button
                  className="server-item__action"
                  title="Stop"
                  data-testid={`server-stop-${config.id}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onStop(config.id);
                  }}
                >
                  <Square size={12} />
                </button>
              ) : (
                <button
                  className="server-item__action"
                  title="Start"
                  data-testid={`server-start-${config.id}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onStart(config.id);
                  }}
                >
                  <Play size={12} />
                </button>
              )}
              <button
                className="server-item__action"
                title="Edit"
                data-testid={`server-edit-${config.id}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onEdit(config.id);
                }}
              >
                <Pencil size={12} />
              </button>
              <button
                className="server-item__action"
                title="Duplicate"
                data-testid={`server-duplicate-${config.id}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onDuplicate(config.id);
                }}
              >
                <Copy size={12} />
              </button>
              <button
                className="server-item__action server-item__action--danger"
                title="Delete"
                data-testid={`server-delete-${config.id}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(config.id);
                }}
              >
                <Trash2 size={12} />
              </button>
            </div>
          </div>
          <div className="server-item__details">
            <span>
              :{config.port} → {config.rootDirectory}
            </span>
            {active && state?.stats && <span>{statsLine(state.stats)}</span>}
            {status === "error" && state?.error && (
              <span className="server-item__error">{state.error}</span>
            )}
          </div>
        </div>
      </ContextMenu.Trigger>

      <ContextMenu.Portal>
        <ContextMenu.Content className="context-menu__content">
          {active ? (
            <ContextMenu.Item
              className="context-menu__item"
              onSelect={() => onStop(config.id)}
              data-testid={`ctx-stop-${config.id}`}
            >
              <Square size={14} /> Stop
            </ContextMenu.Item>
          ) : (
            <ContextMenu.Item
              className="context-menu__item"
              onSelect={() => onStart(config.id)}
              data-testid={`ctx-start-${config.id}`}
            >
              <Play size={14} /> Start
            </ContextMenu.Item>
          )}
          <ContextMenu.Separator className="context-menu__separator" />
          <ContextMenu.Item
            className="context-menu__item"
            onSelect={() => onEdit(config.id)}
            data-testid={`ctx-edit-${config.id}`}
          >
            <Pencil size={14} /> Edit...
          </ContextMenu.Item>
          <ContextMenu.Item
            className="context-menu__item"
            onSelect={() => onDuplicate(config.id)}
            data-testid={`ctx-duplicate-${config.id}`}
          >
            <Copy size={14} /> Duplicate
          </ContextMenu.Item>
          <ContextMenu.Separator className="context-menu__separator" />
          <ContextMenu.Item
            className="context-menu__item"
            onSelect={handleCopyUrl}
            data-testid={`ctx-copy-url-${config.id}`}
          >
            <Clipboard size={14} /> Copy URL
          </ContextMenu.Item>
          {config.serverType === "http" && (
            <ContextMenu.Item
              className="context-menu__item"
              onSelect={handleOpenBrowser}
              data-testid={`ctx-open-browser-${config.id}`}
            >
              <ExternalLink size={14} /> Open in Browser
            </ContextMenu.Item>
          )}
          <ContextMenu.Separator className="context-menu__separator" />
          <ContextMenu.Item
            className="context-menu__item context-menu__item--danger"
            onSelect={() => onDelete(config.id)}
            data-testid={`ctx-delete-${config.id}`}
          >
            <Trash2 size={14} /> Delete
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
