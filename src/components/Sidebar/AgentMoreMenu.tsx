import {
  ArrowUpCircle,
  FolderPlus,
  MoreHorizontal,
  Power,
  RefreshCw,
  Terminal,
  Unplug,
} from "lucide-react";
import {
  Button,
  DropdownMenuContent,
  DropdownMenuRoot,
  DropdownMenuTrigger,
  MenuItem,
  MenuSeparator,
  Tooltip,
} from "@/components/ui";

/** Props for {@link AgentMoreMenu}. */
export interface AgentMoreMenuProps {
  agentId: string;
  agentName: string;
  /** Offer "Update agent…" (the agent can be updated from here). */
  canUpdate: boolean;
  onNewFolder: () => void;
  onRefresh: () => void;
  onRunningSessions: () => void;
  onUpdate: () => void;
  onDisconnect: () => void;
  onShutdown: () => void;
  /** Passed to the menu content, so New folder's input keeps focus (#5322). */
  onCloseAutoFocus: (event: Event) => void;
}

/**
 * A connected agent row's "…" menu (R-013, #5851): the agent's less frequent
 * actions in one labelled menu instead of bare icons that took a row of their
 * own. Detach and Shutdown stay two distinct teardown intents (G9, #1237):
 * Detach keeps the remote sessions running; Shutdown stops them.
 */
export function AgentMoreMenu({
  agentId,
  agentName,
  canUpdate,
  onNewFolder,
  onRefresh,
  onRunningSessions,
  onUpdate,
  onDisconnect,
  onShutdown,
  onCloseAutoFocus,
}: AgentMoreMenuProps) {
  return (
    <DropdownMenuRoot>
      <Tooltip content="More actions" side="top">
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            icon={<MoreHorizontal size={16} />}
            aria-label={`More actions for ${agentName}`}
            data-testid={`agent-more-${agentId}`}
          />
        </DropdownMenuTrigger>
      </Tooltip>
      <DropdownMenuContent
        align="end"
        onCloseAutoFocus={onCloseAutoFocus}
        data-testid={`agent-more-menu-${agentId}`}
      >
        <MenuItem onSelect={onNewFolder} data-testid={`agent-new-folder-${agentId}`}>
          <FolderPlus size={14} />
          New folder
        </MenuItem>
        <MenuItem onSelect={onRefresh} data-testid={`agent-refresh-${agentId}`}>
          <RefreshCw size={14} />
          Refresh sessions
        </MenuItem>
        <MenuItem onSelect={onRunningSessions} data-testid={`agent-running-sessions-${agentId}`}>
          <Terminal size={14} />
          Running sessions…
        </MenuItem>
        {canUpdate && (
          <MenuItem onSelect={onUpdate} data-testid={`agent-update-${agentId}`}>
            <ArrowUpCircle size={14} />
            Update agent…
          </MenuItem>
        )}
        <MenuSeparator />
        <MenuItem onSelect={onDisconnect} data-testid={`agent-disconnect-${agentId}`}>
          <Unplug size={14} />
          Disconnect (detach)
        </MenuItem>
        <MenuItem onSelect={onShutdown} data-testid={`agent-shutdown-${agentId}`}>
          <Power size={14} />
          Shutdown (stop remote)
        </MenuItem>
      </DropdownMenuContent>
    </DropdownMenuRoot>
  );
}
