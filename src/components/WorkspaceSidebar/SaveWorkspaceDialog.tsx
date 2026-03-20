import { useState, useCallback } from "react";
import { X } from "lucide-react";

interface SaveWorkspaceDialogProps {
  onSave: (name: string, description?: string) => void;
  onCancel: () => void;
}

export function SaveWorkspaceDialog({ onSave, onCancel }: SaveWorkspaceDialogProps) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");

  const handleSave = useCallback(() => {
    if (!name.trim()) return;
    onSave(name.trim(), description.trim() || undefined);
  }, [name, description, onSave]);

  return (
    <div className="save-workspace-dialog__overlay" data-testid="save-workspace-dialog">
      <div className="save-workspace-dialog">
        <div className="save-workspace-dialog__header">
          <h3 className="save-workspace-dialog__title">Save Current Layout as Workspace</h3>
          <button
            className="save-workspace-dialog__close"
            onClick={onCancel}
            data-testid="save-workspace-cancel"
          >
            <X size={16} />
          </button>
        </div>

        <div className="save-workspace-dialog__form">
          <div className="save-workspace-dialog__field">
            <label htmlFor="ws-save-name">Name</label>
            <input
              id="ws-save-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Workspace name"
              autoFocus
              data-testid="save-workspace-name"
            />
          </div>

          <div className="save-workspace-dialog__field">
            <label htmlFor="ws-save-desc">Description</label>
            <input
              id="ws-save-desc"
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional description"
              data-testid="save-workspace-description"
            />
          </div>
        </div>

        <div className="save-workspace-dialog__actions">
          <button
            className="save-workspace-dialog__btn save-workspace-dialog__btn--primary"
            onClick={handleSave}
            disabled={!name.trim()}
            data-testid="save-workspace-confirm"
          >
            Save
          </button>
          <button className="save-workspace-dialog__btn" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
