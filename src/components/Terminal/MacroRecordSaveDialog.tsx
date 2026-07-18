import { useEffect, useState } from "react";
import { Modal, Button, Input, Field } from "@/components/ui";
import "./MacroRecordSaveDialog.css";

/** Metadata the user supplies when saving a recorded macro. */
export interface RecordedMacroMeta {
  name: string;
  description?: string;
  tags: string[];
}

export interface MacroRecordSaveDialogProps {
  /** Whether the dialog is open. */
  open: boolean;
  /** Number of steps captured, shown so the user knows what they are saving. */
  stepCount: number;
  /** Called with the entered metadata when the user confirms the save. */
  onSave: (meta: RecordedMacroMeta) => void;
  /** Called when the user cancels — the recording is discarded. */
  onCancel: () => void;
}

/** Split a comma-separated tag string into a trimmed, de-duplicated list. */
function parseTags(raw: string): string[] {
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const part of raw.split(",")) {
    const tag = part.trim();
    if (tag && !seen.has(tag)) {
      seen.add(tag);
      tags.push(tag);
    }
  }
  return tags;
}

/**
 * Prompt shown after a macro recording stops: name the macro (required) plus an
 * optional description and tags, then persist it. Composed from the shared UI
 * primitives. Cancelling discards the recording without saving.
 */
export function MacroRecordSaveDialog({
  open,
  stepCount,
  onSave,
  onCancel,
}: MacroRecordSaveDialogProps) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [tags, setTags] = useState("");

  // Reset the fields each time the dialog opens so a prior entry never leaks in.
  useEffect(() => {
    if (open) {
      setName("");
      setDescription("");
      setTags("");
    }
  }, [open]);

  const trimmedName = name.trim();
  const canSave = trimmedName.length > 0;

  const handleSave = () => {
    if (!canSave) return;
    const trimmedDescription = description.trim();
    onSave({
      name: trimmedName,
      description: trimmedDescription || undefined,
      tags: parseTags(tags),
    });
  };

  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
      title="Save Recorded Macro"
      description={`${stepCount} step${stepCount === 1 ? "" : "s"} captured`}
      onKeyDown={(e) => {
        if (e.key === "Enter" && canSave) handleSave();
      }}
      footer={
        <>
          <Button variant="secondary" onClick={onCancel} data-testid="macro-save-cancel">
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={handleSave}
            disabled={!canSave}
            data-testid="macro-save-confirm"
          >
            Save Macro
          </Button>
        </>
      }
    >
      <p className="macro-save-dialog__summary">
        {stepCount} input step{stepCount === 1 ? "" : "s"} captured.
      </p>
      <Field label="Name" htmlFor="macro-save-name">
        <Input
          id="macro-save-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Deploy sequence"
          autoFocus
          data-testid="macro-save-name"
        />
      </Field>
      <Field label="Description (optional)" htmlFor="macro-save-description">
        <Input
          id="macro-save-description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What this macro does"
          data-testid="macro-save-description"
        />
      </Field>
      <Field label="Tags (optional, comma-separated)" htmlFor="macro-save-tags">
        <Input
          id="macro-save-tags"
          value={tags}
          onChange={(e) => setTags(e.target.value)}
          placeholder="ops, release"
          data-testid="macro-save-tags"
        />
      </Field>
    </Modal>
  );
}
