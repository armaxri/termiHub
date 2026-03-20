import { Pencil, Copy, Trash2 } from "lucide-react";
import { WorkspaceSummary } from "@/types/workspace";

interface WorkspaceListItemProps {
  workspace: WorkspaceSummary;
  onEdit: (workspaceId: string) => void;
  onDuplicate: (workspaceId: string) => void;
  onDelete: (workspaceId: string) => void;
}

export function WorkspaceListItem({
  workspace,
  onEdit,
  onDuplicate,
  onDelete,
}: WorkspaceListItemProps) {
  return (
    <div
      className="workspace-item"
      data-testid={`workspace-item-${workspace.id}`}
      onDoubleClick={() => onEdit(workspace.id)}
    >
      <div className="workspace-item__header">
        <span className="workspace-item__name" data-testid={`workspace-name-${workspace.id}`}>
          {workspace.name}
        </span>
        <span
          className="workspace-item__count-badge"
          data-testid={`workspace-count-${workspace.id}`}
        >
          {workspace.connectionCount} {workspace.connectionCount === 1 ? "tab" : "tabs"}
        </span>
        <div className="workspace-item__actions">
          <button
            className="workspace-item__action"
            title="Edit"
            data-testid={`workspace-edit-${workspace.id}`}
            onClick={(e) => {
              e.stopPropagation();
              onEdit(workspace.id);
            }}
          >
            <Pencil size={12} />
          </button>
          <button
            className="workspace-item__action"
            title="Duplicate"
            data-testid={`workspace-duplicate-${workspace.id}`}
            onClick={(e) => {
              e.stopPropagation();
              onDuplicate(workspace.id);
            }}
          >
            <Copy size={12} />
          </button>
          <button
            className="workspace-item__action"
            title="Delete"
            data-testid={`workspace-delete-${workspace.id}`}
            onClick={(e) => {
              e.stopPropagation();
              onDelete(workspace.id);
            }}
          >
            <Trash2 size={12} />
          </button>
        </div>
      </div>
      {workspace.description && (
        <div className="workspace-item__description">{workspace.description}</div>
      )}
    </div>
  );
}
