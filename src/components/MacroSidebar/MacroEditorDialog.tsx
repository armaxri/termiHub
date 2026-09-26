import { useEffect, useMemo } from "react";
import { Controller, useFieldArray, useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { ArrowDown, ArrowUp, CornerDownLeft, Plus, Trash2 } from "lucide-react";
import { Modal, Button, Input, Field, NumberInput } from "@/components/ui";
import type { Macro, MacroStep } from "@/types/macro";
import { parseTags } from "@/utils/parseTags";
import { escapeMacroStepData, parseMacroStepText } from "./macroStepFormat";
import "./MacroEditorDialog.css";

/** The editable fields the dialog collects before saving a macro. */
export interface MacroEditorResult {
  name: string;
  description?: string;
  tags: string[];
  steps: MacroStep[];
}

/**
 * Delay pre-filled on a hand-added step that follows another step, so an
 * authored macro plays back with a short, human-like pause between commands in
 * real-time mode. The first step always starts at 0.
 */
export const AUTHORED_STEP_DELAY_MS = 100;

/**
 * Client-side validation schema for the whole macro form (UX feedback only):
 *
 * - `name` must be non-empty once trimmed. `description` and `tags` ride along
 *   as free text and are never rejected — they are trimmed/parsed on save.
 * - `steps` must contain at least one step (a macro with no steps has nothing
 *   to play). Each step's `text` is the editable escape notation (see
 *   {@link escapeMacroStepData}); it must parse ({@link parseMacroStepText})
 *   and must not be empty, and `delayMs` must be a non-negative number.
 */
const macroFormSchema = z
  .object({
    name: z.string(),
    description: z.string(),
    tags: z.string(),
    steps: z.array(
      z.object({
        text: z.string(),
        delayMs: z.union([z.number(), z.literal("")]),
      })
    ),
  })
  .superRefine((form, ctx) => {
    if (form.name.trim() === "") {
      ctx.addIssue({ code: "custom", path: ["name"], message: "Name is required." });
    }
    if (form.steps.length === 0) {
      ctx.addIssue({ code: "custom", path: ["steps"], message: "Add at least one step." });
    }
    form.steps.forEach((step, index) => {
      if (step.text === "") {
        ctx.addIssue({
          code: "custom",
          path: ["steps", index, "text"],
          message: "Step input cannot be empty.",
        });
      } else {
        const parsed = parseMacroStepText(step.text);
        if (!parsed.ok) {
          ctx.addIssue({ code: "custom", path: ["steps", index, "text"], message: parsed.error });
        }
      }
      if (step.delayMs !== "" && (!Number.isFinite(step.delayMs) || step.delayMs < 0)) {
        ctx.addIssue({
          code: "custom",
          path: ["steps", index, "delayMs"],
          message: "Delay must be 0 or more.",
        });
      }
    });
  });

/** The raw form values the dialog edits (tags stays comma-separated text). */
type MacroFormValues = z.infer<typeof macroFormSchema>;

/** One editable step row: escaped input text plus its preceding delay. */
type MacroStepFormValue = MacroFormValues["steps"][number];

const EMPTY_FORM: MacroFormValues = { name: "", description: "", tags: "", steps: [] };

export interface MacroEditorDialogProps {
  /** Whether the dialog is open. */
  open: boolean;
  /**
   * The macro being edited. `null` while open means "author a new macro from
   * scratch": the dialog starts blank with one empty step.
   */
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

/** Convert a stored step into its editable form value. */
function toFormStep(step: MacroStep): MacroStepFormValue {
  return { text: escapeMacroStepData(step.data), delayMs: step.delayMs };
}

/**
 * Detail/edit view for a macro — used both to edit a stored (recorded or
 * authored) macro and to author a new one by hand (PROD-039). Edit the name,
 * description and tags, and the step list: each step's input is an editable
 * text field in a lossless escape notation (`\r` Enter, `\t` Tab, `\e` Esc,
 * `\xHH`, `\\`) so control keys are visible and typeable, plus its
 * inter-step delay. Steps can be added, reordered or deleted individually.
 *
 * The whole form — scalar fields and the steps array — is backed by
 * react-hook-form + zod (see {@link macroFormSchema}). Edits are held locally
 * and only persisted when the user saves, so cancelling discards them.
 */
export function MacroEditorDialog({ open, macro, onOpenChange, onSave }: MacroEditorDialogProps) {
  const { control, getValues, reset, setValue } = useForm<MacroFormValues>({
    defaultValues: EMPTY_FORM,
    resolver: zodResolver(macroFormSchema),
    mode: "onChange",
  });
  const { fields, append, remove, move } = useFieldArray({ control, name: "steps" });

  const isNew = macro === null;

  // Reload the working copy each time the dialog opens so a prior edit never
  // leaks in and cancel truly discards. A new macro starts with one empty step.
  useEffect(() => {
    if (!open) return;
    if (macro) {
      reset({
        name: macro.name,
        description: macro.description ?? "",
        tags: macro.tags.join(", "),
        steps: macro.steps.map(toFormStep),
      });
    } else {
      reset({ ...EMPTY_FORM, steps: [{ text: "", delayMs: 0 }] });
    }
  }, [open, macro, reset]);

  // Live form values. `useWatch` can lag the seeded defaults by a render, so
  // merge it over blank defaults to keep a complete draft for the synchronous
  // validity check.
  const watched = useWatch({ control });
  const draft: MacroFormValues = {
    name: watched?.name ?? "",
    description: watched?.description ?? "",
    tags: watched?.tags ?? "",
    steps: (watched?.steps ?? []).map((s) => ({ text: s?.text ?? "", delayMs: s?.delayMs ?? 0 })),
  };

  // Deterministic, synchronous validation derived straight from the schema —
  // the same approach CustomRuleEditor uses — rather than react-hook-form's
  // async error proxy, so the Save gate and the per-step messages update on the
  // same render as the edit.
  const draftKey = JSON.stringify(draft);
  const validation = useMemo(() => {
    const result = macroFormSchema.safeParse(draft);
    const stepErrors = new Map<number, string>();
    if (!result.success) {
      for (const issue of result.error.issues) {
        if (issue.path[0] === "steps" && typeof issue.path[1] === "number") {
          if (!stepErrors.has(issue.path[1])) stepErrors.set(issue.path[1], issue.message);
        }
      }
    }
    return { valid: result.success, stepErrors };
    // `draft` is rebuilt every render from the watched values; keying on its
    // serialization avoids recomputing when nothing actually changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftKey]);

  const canSave = validation.valid;

  const addStep = () => {
    append(
      { text: "", delayMs: fields.length === 0 ? 0 : AUTHORED_STEP_DELAY_MS },
      { shouldFocus: true }
    );
  };

  /** Append an Enter (`\r`) to a step — the common "type command + Enter" case. */
  const appendEnter = (index: number) => {
    const current = getValues(`steps.${index}.text`) ?? "";
    setValue(`steps.${index}.text`, `${current}\\r`, { shouldDirty: true });
  };

  // Returns the parent's (possibly async) save promise so the Button drives its
  // own pending spinner. The parent closes the dialog on success and surfaces
  // its own error toast, so `errorToast` is disabled on the Button to avoid a
  // duplicate; a rejection just returns the button to idle with the dialog open.
  const handleSave = () => {
    if (!canSave) return;
    const current = getValues();
    const steps: MacroStep[] = [];
    for (const step of current.steps) {
      const parsed = parseMacroStepText(step.text);
      // Unreachable while `canSave` holds, but never persist a bad step.
      if (!parsed.ok) return;
      const delay = step.delayMs === "" ? 0 : step.delayMs;
      steps.push({ data: parsed.data, delayMs: Math.max(0, Math.round(delay)) });
    }
    return onSave({
      name: current.name.trim(),
      description: current.description.trim() || undefined,
      tags: parseTags(current.tags),
      steps,
    });
  };

  const stepRows = fields.map((field, index) => {
    const error = validation.stepErrors.get(index);
    const errorId = `macro-editor-step-error-${index}`;
    return (
      <div className="macro-editor__step-row" key={field.id}>
        <div className="macro-editor__step" data-testid={`macro-editor-step-${index}`}>
          <span className="macro-editor__step-index">{index + 1}</span>
          <Controller
            name={`steps.${index}.text`}
            control={control}
            render={({ field: textField }) => (
              <Input
                className="macro-editor__step-data"
                value={textField.value ?? ""}
                onChange={(e) => textField.onChange(e.target.value)}
                onBlur={textField.onBlur}
                ref={textField.ref}
                placeholder={"e.g. ls -la\\r"}
                spellCheck={false}
                autoComplete="off"
                aria-label={`Input for step ${index + 1}`}
                error={Boolean(error)}
                size="sm"
                aria-describedby={error ? errorId : undefined}
                data-testid={`macro-editor-step-data-${index}`}
              />
            )}
          />
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            aria-label={`Append Enter to step ${index + 1}`}
            title="Append Enter (\r)"
            icon={<CornerDownLeft size={12} />}
            onClick={() => appendEnter(index)}
            data-testid={`macro-editor-step-enter-${index}`}
          />
          <div className="macro-editor__step-delay">
            <Controller
              name={`steps.${index}.delayMs`}
              control={control}
              render={({ field: delayField }) => (
                <NumberInput
                  value={delayField.value ?? 0}
                  min={0}
                  step={10}
                  onValueChange={(v) => delayField.onChange(v)}
                  onBlur={delayField.onBlur}
                  aria-label={`Delay before step ${index + 1} in milliseconds`}
                  data-testid={`macro-editor-step-delay-${index}`}
                />
              )}
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
              onClick={() => move(index, index - 1)}
              data-testid={`macro-editor-step-up-${index}`}
            />
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              aria-label={`Move step ${index + 1} down`}
              disabled={index === fields.length - 1}
              icon={<ArrowDown size={12} />}
              onClick={() => move(index, index + 1)}
              data-testid={`macro-editor-step-down-${index}`}
            />
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              aria-label={`Delete step ${index + 1}`}
              icon={<Trash2 size={12} />}
              onClick={() => remove(index)}
              data-testid={`macro-editor-step-delete-${index}`}
            />
          </div>
        </div>
        {error && (
          <p
            className="macro-editor__step-error"
            id={errorId}
            role="alert"
            data-testid={`macro-editor-step-error-${index}`}
          >
            {error}
          </p>
        )}
      </div>
    );
  });

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={isNew ? "New Macro" : "Edit Macro"}
      description={
        isNew
          ? "Author a macro by hand: name it and type the input each step sends"
          : "Edit a stored macro's details and steps"
      }
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
        <span className="macro-editor__steps-title">Steps ({fields.length})</span>
        <Button
          variant="ghost"
          size="sm"
          icon={<Plus size={12} />}
          onClick={addStep}
          data-testid="macro-editor-add-step"
        >
          Add Step
        </Button>
      </div>
      <p className="macro-editor__hint" data-testid="macro-editor-escape-hint">
        Type the exact input each step sends. Use <code>\r</code> for Enter, <code>\t</code> Tab,{" "}
        <code>\e</code> Esc, <code>\xHH</code> any other control byte (e.g. <code>\x03</code>{" "}
        Ctrl+C) and <code>\\</code> for a backslash.
      </p>
      {fields.length === 0 ? (
        <p className="macro-editor__empty" role="status" data-testid="macro-editor-no-steps">
          This macro has no steps. Add one, or it cannot be saved.
        </p>
      ) : (
        <div className="macro-editor__steps" data-testid="macro-editor-steps">
          {stepRows}
        </div>
      )}
    </Modal>
  );
}
