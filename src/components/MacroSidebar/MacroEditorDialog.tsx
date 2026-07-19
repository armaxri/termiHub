import { useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Trash2 } from "lucide-react";
import { Modal, Button, Input, Field, NumberInput } from "@/components/ui";
import type { Macro, MacroStep } from "@/types/macro";
import { formatMacroStepData } from "./macroStepFormat";
import "./MacroEditorDialog.css";

/** The editable fields the dialog collects before saving a macro. */
export interface MacroEditorResult {
  name: string;
  description?: string;
  tags: string[];
  steps: MacroStep[];
}

export interface MacroEditorDialogProps {
  /** Whether the dialog is open. */
  open: boolean;
  /** The macro being edited, or `null` when the dialog is closed. */
  macro: Macro | null;
  /** Called when the dialog should open/close. */
  onOpenChange: (open: boolean) => void;
  /**
   * Called with the edited fields when the user saves. May be async — the Save
   * button shows a pending state and the dialog stays open on rejection so the
   * user can retry without losing edits.
   */
  onSave: (result: MacroEditorResult) => void | Promise<void>;
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
 * Detail/edit view for a stored macro: edit the name, description and tags, and
 * review the recorded step list — each step shows a readable preview of its
 * input plus its inter-step delay, which can be adjusted. Steps can be reordered
 * or deleted individually. Composed entirely from the shared UI primitives.
 *
 * Edits are held locally and only persisted when the user saves, so cancelling
 * discards them. Removing every step is disallowed at the Save gate (a macro
 * with no steps has nothing to play), and the name is required.
 */
export function MacroEditorDialog({ open, macro, onOpenChange, onSave }: MacroEditorDialogProps) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [tags, setTags] = useState("");
  const [steps, setSteps] = useState<MacroStep[]>([]);

  // Reload the working copy each time a macro is opened so a prior edit never
  // leaks in and cancel truly discards.
  useEffect(() => {
    if (open && macro) {
      setName(macro.name);
      setDescription(macro.description ?? "");
      setTags(macro.tags.join(", "));
      setSteps(macro.steps.map((s) => ({ ...s })));
    }
  }, [open, macro]);

  const trimmedName = name.trim();
  const canSave = trimmedName.length > 0 && steps.length > 0;

  const moveStep = (index: number, direction: -1 | 1) => {
    setSteps((prev) => {
      const target = index + direction;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };

  const deleteStep = (index: number) => {
    setSteps((prev) => prev.filter((_, i) => i !== index));
  };

  const setStepDelay = (index: number, delayMs: number) => {
    setSteps((prev) =>
      prev.map((s, i) => (i === index ? { ...s, delayMs: Math.max(0, Math.round(delayMs)) } : s))
    );
  };

  // Returns the parent's (possibly async) save promise so the Button drives its
  // own pending spinner. The parent closes the dialog on success and surfaces
  // its own error toast, so `errorToast` is disabled on the Button to avoid a
  // duplicate; a rejection just returns the button to idle with the dialog open.
  const handleSave = () => {
    if (!canSave) return;
    return onSave({
      name: trimmedName,
      description: description.trim() || undefined,
      tags: parseTags(tags),
      steps,
    });
  };

  const stepRows = useMemo(
    () =>
      steps.map((step, index) => (
        <div className="macro-editor__step" key={index} data-testid={`macro-editor-step-${index}`}>
          <span className="macro-editor__step-index">{index + 1}</span>
          <code className="macro-editor__step-data" data-testid={`macro-editor-step-data-${index}`}>
            {formatMacroStepData(step.data) || "(empty)"}
          </code>
          <div className="macro-editor__step-delay">
            <NumberInput
              value={step.delayMs}
              min={0}
              step={10}
              onValueChange={(v) => setStepDelay(index, v === "" ? 0 : v)}
              aria-label={`Delay before step ${index + 1} in milliseconds`}
              data-testid={`macro-editor-step-delay-${index}`}
            />
            <span className="macro-editor__step-unit">ms</span>
          </div>
          <div className="macro-editor__step-actions">
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              aria-label={`Move step ${index + 1} up`}
              disabled={index === 0}
              icon={<ArrowUp size={12} />}
              onClick={() => moveStep(index, -1)}
              data-testid={`macro-editor-step-up-${index}`}
            />
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              aria-label={`Move step ${index + 1} down`}
              disabled={index === steps.length - 1}
              icon={<ArrowDown size={12} />}
              onClick={() => moveStep(index, 1)}
              data-testid={`macro-editor-step-down-${index}`}
            />
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              aria-label={`Delete step ${index + 1}`}
              icon={<Trash2 size={12} />}
              onClick={() => deleteStep(index)}
              data-testid={`macro-editor-step-delete-${index}`}
            />
          </div>
        </div>
      )),
    [steps]
  );

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Edit Macro"
      description="Edit a stored macro's details and recorded steps"
      size="lg"
      data-testid="macro-editor-dialog"
      footer={
        <>
          <Button
            variant="secondary"
            onClick={() => onOpenChange(false)}
            data-testid="macro-editor-cancel"
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={handleSave}
            disabled={!canSave}
            errorToast={false}
            data-testid="macro-editor-save"
          >
            Save
          </Button>
        </>
      }
    >
      <Field label="Name" htmlFor="macro-editor-name">
        <Input
          id="macro-editor-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Macro name"
          data-testid="macro-editor-name"
        />
      </Field>
      <Field label="Description (optional)" htmlFor="macro-editor-description">
        <Input
          id="macro-editor-description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What this macro does"
          data-testid="macro-editor-description"
        />
      </Field>
      <Field label="Tags (optional, comma-separated)" htmlFor="macro-editor-tags">
        <Input
          id="macro-editor-tags"
          value={tags}
          onChange={(e) => setTags(e.target.value)}
          placeholder="ops, release"
          data-testid="macro-editor-tags"
        />
      </Field>
      <div className="macro-editor__steps-header">
        <span className="macro-editor__steps-title">Steps ({steps.length})</span>
      </div>
      {steps.length === 0 ? (
        <p className="macro-editor__empty" role="status" data-testid="macro-editor-no-steps">
          This macro has no steps. Add one by recording, or it cannot be saved.
        </p>
      ) : (
        <div className="macro-editor__steps" data-testid="macro-editor-steps">
          {stepRows}
        </div>
      )}
    </Modal>
  );
}
