import { useCallback, useState } from "react";
import { Play, Square, Pencil, Copy, Trash2, ExternalLink, Clipboard } from "lucide-react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import { writeText as writeClipboard } from "@tauri-apps/plugin-clipboard-manager";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Button, toast, Tooltip } from "@/components/ui";
import { SidebarListItem, SidebarStatusDot } from "@/components/SidebarListItem";
import type { SidebarStatusTone } from "@/components/SidebarListItem";
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
  onStart: (id: string) => void | Promise<void>;
  onStop: (id: string) => void | Promise<void>;
  onEdit: (id: string) => void;
  onDuplicate: (id: string) => void;
  onDelete: (id: string) => void;
}

/** Extract a human-readable message from an unknown rejection value. */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return String(err);
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

function statusTone(status: ServerStatus | undefined): SidebarStatusTone {
  switch (status) {
    case "running":
      return "success";
    case "starting":
    case "stopping":
      return "warning";
    case "error":
      return "error";
    default:
      return "neutral";
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
  const [busy, setBusy] = useState(false);

  const handleStart = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      await onStart(config.id);
    } catch (err) {
      toast.error(`Failed to start ${config.name}`, { description: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }, [busy, onStart, config.id, config.name]);

  const handleStop = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      await onStop(config.id);
    } catch (err) {
      toast.error(`Failed to stop ${config.name}`, { description: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }, [busy, onStop, config.id, config.name]);

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
        <SidebarListItem
          testId={`server-item-${config.id}`}
          nameTestId={`server-name-${config.id}`}
          name={config.name}
          error={status === "error"}
          onDoubleClick={() => onEdit(config.id)}
          status={
            <SidebarStatusDot tone={statusTone(status)} testId={`server-status-${config.id}`} />
          }
          badge={PROTOCOL_LABELS[config.serverType]}
          badgeTestId={`server-type-${config.id}`}
          actions={
            <>
              {active ? (
                <Tooltip content="Stop" side="top">
                  <Button
                    variant="ghost"
                    size="sm"
                    iconOnly
                    aria-label="Stop"
                    data-testid={`server-stop-${config.id}`}
                    disabled={busy}
                    icon={<Square size={12} />}
                    onClick={(e) => {
                      e.stopPropagation();
                      void handleStop();
                    }}
                  />
                </Tooltip>
              ) : (
                <Tooltip content="Start" side="top">
                  <Button
                    variant="ghost"
                    size="sm"
                    iconOnly
                    aria-label="Start"
                    data-testid={`server-start-${config.id}`}
                    disabled={busy}
                    icon={<Play size={12} />}
                    onClick={(e) => {
                      e.stopPropagation();
                      void handleStart();
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
                  data-testid={`server-edit-${config.id}`}
                  icon={<Pencil size={12} />}
                  onClick={(e) => {
                    e.stopPropagation();
                    onEdit(config.id);
                  }}
                />
              </Tooltip>
              <Tooltip content="Duplicate" side="top">
                <Button
                  variant="ghost"
                  size="sm"
                  iconOnly
                  aria-label="Duplicate"
                  data-testid={`server-duplicate-${config.id}`}
                  icon={<Copy size={12} />}
                  onClick={(e) => {
                    e.stopPropagation();
                    onDuplicate(config.id);
                  }}
                />
              </Tooltip>
              <Tooltip content="Delete" side="top">
                <Button
                  variant="ghost"
                  size="sm"
                  iconOnly
                  aria-label="Delete"
                  data-testid={`server-delete-${config.id}`}
                  icon={<Trash2 size={12} />}
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(config.id);
                  }}
                />
              </Tooltip>
            </>
          }
          details={
            <>
              <span>
                :{config.port} → {config.rootDirectory}
              </span>
              {active && state?.stats && <span>{statsLine(state.stats)}</span>}
              {status === "error" && state?.error && (
                <span className="sidebar-list-item__error">{state.error}</span>
              )}
            </>
          }
        />
      </ContextMenu.Trigger>

      <ContextMenu.Portal>
        <ContextMenu.Content className="context-menu__content">
          {active ? (
            <ContextMenu.Item
              className="context-menu__item"
              onSelect={() => void handleStop()}
              data-testid={`ctx-stop-${config.id}`}
            >
              <Square size={14} /> Stop
            </ContextMenu.Item>
          ) : (
            <ContextMenu.Item
              className="context-menu__item"
              onSelect={() => void handleStart()}
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
