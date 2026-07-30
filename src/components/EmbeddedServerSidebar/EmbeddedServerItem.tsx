import { useCallback } from "react";
import { Play, Square, Pencil, Copy, Trash2, ExternalLink, Clipboard } from "lucide-react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import { writeText as writeClipboard } from "@tauri-apps/plugin-clipboard-manager";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Button, toast, Tooltip } from "@/components/ui";
import { SidebarListItem, SidebarStatusDot } from "@/components/SidebarListItem";
import type { SidebarStatusTone } from "@/components/SidebarListItem";
import { RunLocationSelect } from "@/components/RunLocationSelect";
import type { RemoteAgentDefinition } from "@/types/connection";
import { THIS_COMPUTER, type RunLocation } from "@/utils/runLocation";
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
  /** Agents offered as run targets for this server's "Run on" selector. */
  agents?: RemoteAgentDefinition[];
  /** The server's current run-location (This computer or an agent). */
  runLocation?: RunLocation;
  /** Called when the user picks a new run-location for this server. */
  onRunLocationChange?: (location: RunLocation) => void;
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
  agents = [],
  runLocation = THIS_COMPUTER,
  onRunLocationChange,
  onStart,
  onStop,
  onEdit,
  onDuplicate,
  onDelete,
}: Props) {
  const status = state?.status;
  const active = isActive(status);
  const url = serverUrl(config);

  // Start/Stop drive the shared Button's async lifecycle: returning the promise
  // makes the pressed control show the spinner + disable itself while in flight
  // (no hand-rolled `busy` flag). We keep the server-scoped error toast and set
  // `errorToast={false}` on the Button, then re-throw so the Button lands in its
  // error path (idle, no false success flash) — see #1344.
  const handleStart = useCallback(async () => {
    try {
      await onStart(config.id);
    } catch (err) {
      toast.error(`Failed to start ${config.name}`, { description: errorMessage(err) });
      throw err;
    }
  }, [onStart, config.id, config.name]);

  const handleStop = useCallback(async () => {
    try {
      await onStop(config.id);
    } catch (err) {
      toast.error(`Failed to stop ${config.name}`, { description: errorMessage(err) });
      throw err;
    }
  }, [onStop, config.id, config.name]);

  const handleCopyUrl = () => {
    writeClipboard(url)
      .then(() => toast.success("Copied URL to clipboard"))
      .catch((err: unknown) =>
        toast.error("Failed to copy URL", { description: errorMessage(err) })
      );
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
                    errorToast={false}
                    icon={<Square size={12} />}
                    onClick={(e) => {
                      e.stopPropagation();
                      return handleStop();
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
                    errorToast={false}
                    icon={<Play size={12} />}
                    onClick={(e) => {
                      e.stopPropagation();
                      return handleStart();
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
              {/* Run-location selector (#2191). Stop click/double-click from
                  bubbling to the row's edit/context handlers. */}
              <span
                className="server-item__runon"
                onClick={(e) => e.stopPropagation()}
                onDoubleClick={(e) => e.stopPropagation()}
              >
                <span className="server-item__runon-label">Run on</span>
                <RunLocationSelect
                  value={runLocation}
                  agents={agents}
                  onChange={onRunLocationChange ?? (() => {})}
                  aria-label={`Run ${config.name} on`}
                  data-testid={`server-runloc-${config.id}`}
                />
              </span>
            </>
          }
        />
      </ContextMenu.Trigger>

      <ContextMenu.Portal>
        <ContextMenu.Content className="context-menu__content">
          {active ? (
            <ContextMenu.Item
              className="context-menu__item"
              onSelect={() => void handleStop().catch(() => {})}
              data-testid={`ctx-stop-${config.id}`}
            >
              <Square size={14} /> Stop
            </ContextMenu.Item>
          ) : (
            <ContextMenu.Item
              className="context-menu__item"
              onSelect={() => void handleStart().catch(() => {})}
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
