import { Play, Pencil, Copy, Trash2 } from "lucide-react";
import { Tooltip } from "@/components/ui";
import { WorkspaceSummary } from "@/types/workspace";

interface WorkspaceListItemProps {
  workspace: WorkspaceSummary;
  onLaunch: (workspaceId: string) => void;
  onEdit: (workspaceId: string) => void;
  onDuplicate: (workspaceId: string) => void;
  onDelete: (workspaceId: string) => void;
}

export function WorkspaceListItem({
  workspace,
  onLaunch,
  onEdit,
  onDuplicate,
  onDelete,
}: WorkspaceListItemProps) {
  return (
    <div
      className="workspace-item"
      data-testid={`workspace-item-${workspace.id}`}
      onDoubleClick={() => onLaunch(workspace.id)}
    >
      <div className="workspace-item__header">
        <span className="workspace-item__name" data-testid={`workspace-name-${workspace.id}`}>
          {workspace.name}
        </span>
        <div className="workspace-item__actions">
          <Tooltip content="Launch" side="top">
            <button
              className="workspace-item__action"
              aria-label="Launch"
              data-testid={`workspace-launch-${workspace.id}`}
              onClick={(e) => {
                e.stopPropagation();
                onLaunch(workspace.id);
              }}
            >
              <Play size={12} />
            </button>
          </Tooltip>
          <Tooltip content="Edit" side="top">
            <button
              className="workspace-item__action"
              aria-label="Edit"
              data-testid={`workspace-edit-${workspace.id}`}
              onClick={(e) => {
                e.stopPropagation();
                onEdit(workspace.id);
              }}
            >
              <Pencil size={12} />
            </button>
          </Tooltip>
          <Tooltip content="Duplicate" side="top">
            <button
              className="workspace-item__action"
              aria-label="Duplicate"
              data-testid={`workspace-duplicate-${workspace.id}`}
              onClick={(e) => {
                e.stopPropagation();
                onDuplicate(workspace.id);
              }}
            >
              <Copy size={12} />
            </button>
          </Tooltip>
          <Tooltip content="Delete" side="top">
            <button
              className="workspace-item__action"
              aria-label="Delete"
              data-testid={`workspace-delete-${workspace.id}`}
              onClick={(e) => {
                e.stopPropagation();
                onDelete(workspace.id);
              }}
            >
              <Trash2 size={12} />
            </button>
          </Tooltip>
        </div>
      </div>
      {workspace.description && (
        <div className="workspace-item__description">{workspace.description}</div>
      )}
    </div>
  );
}
