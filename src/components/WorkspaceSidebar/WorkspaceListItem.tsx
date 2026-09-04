import type React from "react";
import { Play, Loader2, Pencil, Copy, Trash2 } from "lucide-react";
import { Button, Tooltip } from "@/components/ui";
import { SidebarListItem } from "@/components/SidebarListItem";
import { WorkspaceSummary } from "@/types/workspace";

interface WorkspaceListItemProps {
  workspace: WorkspaceSummary;
  onLaunch: (workspaceId: string) => void;
  onEdit: (workspaceId: string) => void;
  onDuplicate: (workspaceId: string) => void;
  onDelete: (workspaceId: string) => void;
  /**
   * True while any workspace launch is in flight. The Launch control is disabled
   * and double-click is suppressed so a second press cannot start a concurrent
   * launch (GAP G6, #1146).
   */
  launchDisabled?: boolean;
  /** Roving-tabindex ref wiring the row into the sidebar's keyboard navigation. */
  rowRef?: (el: HTMLDivElement | null) => void;
  /** Roving-tabindex row props (role, tabIndex, aria-level, onFocus) for keyboard nav. */
  rowProps?: React.HTMLAttributes<HTMLDivElement>;
}

export function WorkspaceListItem({
  workspace,
  onLaunch,
  onEdit,
  onDuplicate,
  onDelete,
  launchDisabled = false,
  rowRef,
  rowProps,
}: WorkspaceListItemProps) {
  return (
    <SidebarListItem
      ref={rowRef}
      {...rowProps}
      testId={`workspace-item-${workspace.id}`}
      nameTestId={`workspace-name-${workspace.id}`}
      name={workspace.name}
      onDoubleClick={() => {
        if (!launchDisabled) onLaunch(workspace.id);
      }}
      actions={
        <>
          <Tooltip content={launchDisabled ? "Launching…" : "Launch"} side="top">
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              aria-label="Launch"
              data-testid={`workspace-launch-${workspace.id}`}
              disabled={launchDisabled}
              icon={
                launchDisabled ? (
                  <Loader2 size={12} className="workspace-item__spinner motion-essential-spinner" />
                ) : (
                  <Play size={12} />
                )
              }
              onClick={(e) => {
                e.stopPropagation();
                onLaunch(workspace.id);
              }}
            />
          </Tooltip>
          <Tooltip content="Edit" side="top">
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              aria-label="Edit"
              data-testid={`workspace-edit-${workspace.id}`}
              icon={<Pencil size={12} />}
              onClick={(e) => {
                e.stopPropagation();
                onEdit(workspace.id);
              }}
            />
          </Tooltip>
          <Tooltip content="Duplicate" side="top">
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              aria-label="Duplicate"
              data-testid={`workspace-duplicate-${workspace.id}`}
              icon={<Copy size={12} />}
              onClick={(e) => {
                e.stopPropagation();
                onDuplicate(workspace.id);
              }}
            />
          </Tooltip>
          <Tooltip content="Delete" side="top">
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              aria-label="Delete"
              data-testid={`workspace-delete-${workspace.id}`}
              icon={<Trash2 size={12} />}
              onClick={(e) => {
                e.stopPropagation();
                onDelete(workspace.id);
              }}
            />
          </Tooltip>
        </>
      }
      details={
        workspace.description ? (
          <span className="workspace-item__description">{workspace.description}</span>
        ) : undefined
      }
    />
  );
}
