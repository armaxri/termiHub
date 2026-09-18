import { useEffect, useMemo, useState } from "react";
import { Controller, useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { ArrowDown, ArrowUp, Trash2 } from "lucide-react";
import { Modal, Button, Input, Field, NumberInput } from "@/components/ui";
import type { Macro, MacroStep } from "@/types/macro";
import { parseTags } from "@/utils/parseTags";
import { formatMacroStepData } from "./macroStepFormat";
import "./MacroEditorDialog.css";

/** The editable fields the dialog collects before saving a macro. */
export interface MacroEditorResult {
  name: string;
  description?: string;
  tags: string[];
  steps: MacroStep[];
}

/**
 * Client-side validation schema for a macro's scalar form fields (UX feedback
 * only; the same check the dialog previously ran by hand, translated 1:1 into
 * zod): `name` must be non-empty once trimmed. `description` and `tags` ride
 * along as free text and are never rejected — they are trimmed/parsed on save.
 *
 * The steps array is validated separately (a macro with no steps cannot be
 * saved) and combined with this schema's validity at the Save gate, so today's
 * exact enable/disable behavior is preserved.
 */
const macroFormSchema = z
  .object({
    name: z.string(),
    description: z.string(),
    tags: z.string(),
  })
  .superRefine((form, ctx) => {
    if (form.name.trim() === "") {
      ctx.addIssue({ code: "custom", path: ["name"], message: "Name is required." });
    }
  });

/** The raw form values the dialog edits (tags stays comma-separated text). */
type MacroFormValues = z.infer<typeof macroFormSchema>;

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

/**
 * Detail/edit view for a stored macro: edit the name, description and tags, and
 * review the recorded step list — each step shows a readable preview of its
 * input plus its inter-step delay, which can be adjusted. Steps can be reordered
 * or deleted individually. Composed entirely from the shared UI primitives.
 *
 * The scalar fields are backed by react-hook-form + zod (see
 * {@link macroFormSchema}); the imperative steps list stays in local state, and
 * the Save gate combines the form validity with the "at least one step" rule.
 *
 * Edits are held locally and only persisted when the user saves, so cancelling
 * discards them. Removing every step is disallowed at the Save gate (a macro
 * with no steps has nothing to play), and the name is required.
 */
export function MacroEditorDialog({ open, macro, onOpenChange, onSave }: MacroEditorDialogProps) {
  const { control, getValues, reset } = useForm<MacroFormValues>({
    defaultValues: { name: "", description: "", tags: "" },
    resolver: zodResolver(macroFormSchema),
    mode: "onChange",
  });

  const [steps, setSteps] = useState<MacroStep[]>([]);

  // Reload the working copy each time a macro is opened so a prior edit never
  // leaks in and cancel truly discards.
  useEffect(() => {
    if (open && macro) {
      reset({
        name: macro.name,
        description: macro.description ?? "",
        tags: macro.tags.join(", "),
      });
      setSteps(macro.steps.map((s) => ({ ...s })));
    }
  }, [open, macro, reset]);

  // Live form values. `useWatch` only surfaces registered fields and can lag the
  // seeded defaults by a render, so merge it over blank defaults to keep a
  // complete draft for the synchronous validity check.
  const watched = useWatch({ control });
  const draft: MacroFormValues = {
    name: watched?.name ?? "",
    description: watched?.description ?? "",
    tags: watched?.tags ?? "",
  };

  // Deterministic, synchronous validity derived straight from the schema — the
  // same approach CustomRuleEditor uses — rather than react-hook-form's async
  // error proxy, so the Save gate updates on the same render as the edit.
  const validity = useMemo(() => {
    return macroFormSchema.safeParse(draft).success;
    // `draft` is rebuilt every render from the watched values; keying on its
    // serialization avoids recomputing when nothing actually changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(draft)]);

  // Save requires both a valid form and at least one step, exactly as before.
  const canSave = validity && steps.length > 0;

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
    const current = getValues();
    return onSave({
      name: current.name.trim(),
      description: current.description.trim() || undefined,
      tags: parseTags(current.tags),
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
      <Controller
        name="name"
        control={control}
        render={({ field }) => (
          <Field label="Name" htmlFor="macro-editor-name">
            <Input
              id="macro-editor-name"
              value={field.value ?? ""}
              onChange={(e) => field.onChange(e.target.value)}
              onBlur={field.onBlur}
              placeholder="Macro name"
              data-testid="macro-editor-name"
            />
          </Field>
        )}
      />
      <Controller
        name="description"
        control={control}
        render={({ field }) => (
          <Field label="Description (optional)" htmlFor="macro-editor-description">
            <Input
              id="macro-editor-description"
              value={field.value ?? ""}
              onChange={(e) => field.onChange(e.target.value)}
              onBlur={field.onBlur}
              placeholder="What this macro does"
              data-testid="macro-editor-description"
            />
          </Field>
        )}
      />
      <Controller
        name="tags"
        control={control}
        render={({ field }) => (
          <Field label="Tags (optional, comma-separated)" htmlFor="macro-editor-tags">
            <Input
              id="macro-editor-tags"
              value={field.value ?? ""}
              onChange={(e) => field.onChange(e.target.value)}
              onBlur={field.onBlur}
              placeholder="ops, release"
              data-testid="macro-editor-tags"
            />
          </Field>
        )}
      />
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
