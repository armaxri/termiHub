import { useEffect, useState } from "react";
import { Modal, ModalClose, Button, Input, Field } from "@/components/ui";
import { parseTags } from "@/utils/parseTags";
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
  /**
   * Called when the user explicitly discards the recording. A passive dismiss
   * (Escape, a scrim click, the X) never calls it on its own: while any step is
   * captured it first asks "Discard changes?", and only that confirmation
   * discards (#5201).
   */
  onDiscard: () => void;
}

/**
 * Prompt shown after a macro recording stops: name the macro (required) plus an
 * optional description and tags, then persist it. Composed from the shared UI
 * primitives.
 *
 * Every non-save exit goes through the Modal's dismiss path, which is guarded by
 * `dirty` while steps are captured: Escape, a scrim click, the X and the
 * "Discard recording" button all raise the shared unsaved-changes prompt, whose
 * Cancel returns to this dialog with the recording intact (#5201). Only its
 * "Discard changes" reaches {@link MacroRecordSaveDialogProps.onDiscard}. With no
 * steps captured there is nothing to lose, so a dismiss discards directly.
 */
export function MacroRecordSaveDialog({
  open,
  stepCount,
  onSave,
  onDiscard,
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
        if (!next) onDiscard();
      }}
      dirty={stepCount > 0}
      data-testid="macro-save-dialog"
      title="Save Recorded Macro"
      description={`${stepCount} step${stepCount === 1 ? "" : "s"} captured`}
      onKeyDown={(e) => {
        // The discard prompt is a React child of this dialog, so its keys bubble
        // here too; only act on Enter pressed inside this dialog's own content.
        if (!e.currentTarget.contains(e.target as Node)) return;
        // Enter on a focused footer button activates that button, not Save.
        if ((e.target as HTMLElement).closest("button")) return;
        if (e.key === "Enter" && canSave) handleSave();
      }}
      footer={
        <>
          <ModalClose>
            <Button variant="secondary" data-testid="macro-save-discard">
              Discard recording
            </Button>
          </ModalClose>
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
