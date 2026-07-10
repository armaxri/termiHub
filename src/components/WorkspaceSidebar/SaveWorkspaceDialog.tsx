import { useState, useCallback, type FormEvent } from "react";
import { Modal, Button, Input } from "@/components/ui";

/** id linking the footer submit Button to the body <form> (they render in separate Modal regions). */
const FORM_ID = "save-workspace-form";

export type SaveWorkspaceScope = "all" | "active";

interface SaveWorkspaceDialogProps {
  /** Number of live tab groups — shows scope selector when > 1. */
  tabGroupCount: number;
  /** Name of the currently active tab group (shown in "active only" label). */
  activeGroupName: string;
  onSave: (name: string, scope: SaveWorkspaceScope, description?: string) => void;
  onCancel: () => void;
}

export function SaveWorkspaceDialog({
  tabGroupCount,
  activeGroupName,
  onSave,
  onCancel,
}: SaveWorkspaceDialogProps) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [scope, setScope] = useState<SaveWorkspaceScope>("all");

  const showScopeSelector = tabGroupCount > 1;

  const handleSave = useCallback(() => {
    if (!name.trim()) return;
    onSave(name.trim(), showScopeSelector ? scope : "all", description.trim() || undefined);
  }, [name, description, scope, showScopeSelector, onSave]);

  // Enter from any field submits the form (the footer Save button is associated
  // via the form= attribute); the empty-name guard lives in handleSave.
  const handleSubmit = useCallback(
    (e: FormEvent) => {
      e.preventDefault();
      handleSave();
    },
    [handleSave]
  );

  return (
    <Modal
      open
      onOpenChange={(isOpen) => !isOpen && onCancel()}
      title="Save Current Layout as Workspace"
      data-testid="save-workspace-dialog"
      footer={
        <>
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            type="submit"
            form={FORM_ID}
            variant="primary"
            disabled={!name.trim()}
            data-testid="save-workspace-confirm"
          >
            Save
          </Button>
        </>
      }
    >
      <form
        id={FORM_ID}
        className="save-workspace-dialog__form"
        onSubmit={handleSubmit}
        data-testid="save-workspace-form"
      >
        <div className="save-workspace-dialog__field">
          <label htmlFor="ws-save-name">Name</label>
          <Input
            id="ws-save-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Workspace name"
            autoFocus
            data-testid="save-workspace-name"
          />
        </div>

        <div className="save-workspace-dialog__field">
          <label htmlFor="ws-save-desc">Description</label>
          <Input
            id="ws-save-desc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Optional description"
            data-testid="save-workspace-description"
          />
        </div>

        {showScopeSelector && (
          <div className="save-workspace-dialog__field" data-testid="save-workspace-scope">
            <label>Capture</label>
            <div className="save-workspace-dialog__radio-group">
              <label className="save-workspace-dialog__radio-label">
                <input
                  type="radio"
                  value="all"
                  checked={scope === "all"}
                  onChange={() => setScope("all")}
                  data-testid="save-workspace-scope-all"
                />
                All tab groups ({tabGroupCount})
              </label>
              <label className="save-workspace-dialog__radio-label">
                <input
                  type="radio"
                  value="active"
                  checked={scope === "active"}
                  onChange={() => setScope("active")}
                  data-testid="save-workspace-scope-active"
                />
                Active group only ({activeGroupName})
              </label>
            </div>
          </div>
        )}
      </form>
    </Modal>
  );
}
