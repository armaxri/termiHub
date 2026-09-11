import { useState, useCallback } from "react";
import { Modal, Button, Input, RadioGroup } from "@/components/ui";

/** id linking the footer submit Button to the body <form> (they render in separate Modal regions). */
const FORM_ID = "save-workspace-form";

export type SaveWorkspaceScope = "all" | "active";

interface SaveWorkspaceDialogProps {
  /** Number of live tab groups — shows scope selector when > 1. */
  tabGroupCount: number;
  /** Name of the currently active tab group (shown in "active only" label). */
  activeGroupName: string;
  onSave: (name: string, scope: SaveWorkspaceScope, description?: string) => void | Promise<void>;
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

  // The single action for both entry points. Returning onSave's promise lets the
  // submit Button drive its async pending affordance on BOTH Enter and click
  // (the Button's native-submit bridge); the empty-name gate is the disabled
  // prop, so this never runs while invalid.
  const handleSave = useCallback((): void | Promise<void> => {
    return onSave(name.trim(), showScopeSelector ? scope : "all", description.trim() || undefined);
  }, [name, description, scope, showScopeSelector, onSave]);

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
            onClick={handleSave}
            errorToast={false}
            data-testid="save-workspace-confirm"
          >
            Save
          </Button>
        </>
      }
    >
      <form id={FORM_ID} className="save-workspace-dialog__form" data-testid="save-workspace-form">
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
            <label id="ws-save-scope-label">Capture</label>
            <RadioGroup
              className="save-workspace-dialog__radio-group"
              value={scope}
              onValueChange={(v) => setScope(v as SaveWorkspaceScope)}
              aria-labelledby="ws-save-scope-label"
              options={[
                {
                  value: "all",
                  label: `All tab groups (${tabGroupCount})`,
                  "data-testid": "save-workspace-scope-all",
                },
                {
                  value: "active",
                  label: `Active group only (${activeGroupName})`,
                  "data-testid": "save-workspace-scope-active",
                },
              ]}
            />
          </div>
        )}
      </form>
    </Modal>
  );
}
