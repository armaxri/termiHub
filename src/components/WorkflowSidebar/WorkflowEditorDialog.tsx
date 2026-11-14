import { useEffect, useMemo, useState } from "react";
import { ITEM_DESCRIPTION_MAX_LENGTH, normalizeItemDescription } from "@/utils/itemDescription";
import { Controller } from "react-hook-form";
import { z } from "zod";
import { useZodEditorForm } from "@/hooks/useZodEditorForm";
import { Plus } from "lucide-react";
import { DndContext, DragEndEvent, useSensor, useSensors } from "@dnd-kit/core";
import { ReleaseScopedPointerSensor } from "@/utils/releaseScopedPointerSensor";
import { SortableContext, verticalListSortingStrategy, arrayMove } from "@dnd-kit/sortable";
import {
  Modal,
  ModalClose,
  Button,
  Input,
  Field,
  useModalPortalContainer,
  EmptyState,
  DropdownMenuContent,
  DropdownMenuRoot,
  DropdownMenuTrigger,
  MenuItem,
} from "@/components/ui";
import type {
  Workflow,
  WorkflowParameter,
  WorkflowStep,
  WorkflowStepKind,
  WorkflowTrigger,
} from "@/types/workflow";
import type { Macro } from "@/types/macro";
import type { SavedConnection } from "@/types/connection";
import { WorkflowStepRow, type WorkflowStepEntry } from "./WorkflowStepRow";
import { WorkflowTriggersEditor } from "./WorkflowTriggersEditor";
import { WorkflowParametersEditor } from "./WorkflowParametersEditor";
import { workflowStepsPolicyValid } from "./workflowStepPolicySchema";
import {
  WORKFLOW_STEP_KINDS,
  stepKindLabel,
  stepKindIcon,
  newWorkflowStep,
} from "./workflowStepMeta";
import { newId } from "@/services/transport/ids";
import { parseTags } from "@/utils/parseTags";
import { draftKey } from "@/utils/draftKey";
import { useFollowConnectionIdChanges } from "@/hooks/useFollowConnectionIdChanges";
import { remapWorkflowTriggers } from "@/utils/connectionIdChanges";
import { workflowTriggersValid } from "@/services/workflowOutputTriggers";
import "./WorkflowEditorDialog.css";

/** The editable fields the dialog collects before saving a workflow. */
export interface WorkflowEditorResult {
  name: string;
  description?: string;
  tags: string[];
  steps: WorkflowStep[];
  triggers: WorkflowTrigger[];
  /** Declared parameters (PROD-0040); empty when the workflow uses none. */
  parameters: WorkflowParameter[];
}

/**
 * The scalar text fields backed by react-hook-form. The typed step list and
 * triggers stay in imperative local state (add/remove/reorder/edit are not a
 * natural fit for an RHF field-array here), and their validity is AND-ed with
 * this form's at the Save gate — see {@link WorkflowEditorDialog}.
 */
interface WorkflowFormValues {
  name: string;
  description: string;
  tags: string;
}

/**
 * Client-side validation schema for the workflow's scalar fields (UX feedback
 * only; the same check the dialog previously ran by hand, translated 1:1 into
 * zod, part of #3073 / UISF-011):
 *
 * - `name` must be non-empty once trimmed.
 * - `description` and `tags` are free-text and always valid.
 *
 * The step-list requirement ("a workflow needs at least one step") is not a
 * form field, so it stays out of the schema and is AND-ed into the Save gate.
 */
const workflowFormSchema = z
  .object({
    name: z.string(),
    description: z.string(),
    tags: z.string(),
  })
  .superRefine((values, ctx) => {
    if (values.name.trim() === "") {
      ctx.addIssue({ code: "custom", path: ["name"], message: "Name is required." });
    }
  });

export interface WorkflowEditorDialogProps {
  /** Whether the dialog is open. */
  open: boolean;
  /** The workflow being edited, or `null` when the dialog is closed. */
  workflow: Workflow | null;
  /** Stored macros, for the run-macro step's target picker. */
  macros: Macro[];
  /** Saved connections, for the on-connect trigger's target picker. */
  connections: SavedConnection[];
  /** Whether this is a brand-new workflow (affects the dialog title). */
  isNew?: boolean;
  /** Called when the dialog should open/close. */
  onOpenChange: (open: boolean) => void;
  /**
   * Called with the edited fields when the user saves. May be async — the Save
   * button shows a pending state and the dialog stays open on rejection so the
   * user can retry without losing edits.
   */
  onSave: (result: WorkflowEditorResult) => void | Promise<void>;
}

/** Generate a transient uid for a working step entry (React key + dnd id). */
function stepUid(): string {
  return newId("step");
}

/**
 * Create/edit view for a workflow: name, description, tags, an ordered typed
 * step list (add / remove / reorder via grip-drag or up/down), and a Triggers
 * section binding manual / on-connect / hotkey. Triggers sit above the steps
 * and every step collapses to a summary line, so the dialog has a single scroll
 * container and the "when does this run" choice is visible at once (#5637). Composed entirely from the
 * shared UI primitives, mirroring `MacroEditorDialog`.
 *
 * Edits are held locally and only persisted when the user saves, so cancelling
 * discards them. The name is required; a workflow with no steps cannot be saved.
 */
export function WorkflowEditorDialog({
  open,
  workflow,
  macros,
  connections,
  isNew = false,
  onOpenChange,
  onSave,
}: WorkflowEditorDialogProps) {
  // Scalar fields live in react-hook-form; the typed step list and triggers
  // stay in imperative local state (their edit surface is not a natural field
  // array), and their validity is AND-ed into the Save gate below.
  const {
    form: { control, getValues, reset },
    draft: formDraft,
    errors,
    valid: formValid,
  } = useZodEditorForm<WorkflowFormValues>({
    schema: workflowFormSchema,
    defaultValues: { name: "", description: "", tags: "" },
  });
  const [entries, setEntries] = useState<WorkflowStepEntry[]>([]);
  const [triggers, setTriggers] = useState<WorkflowTrigger[]>([]);
  const [parameters, setParameters] = useState<WorkflowParameter[]>([]);
  // Uids of the step rows showing their detail editor (#5637). Opened steps
  // start collapsed to one summary line each; added steps start expanded.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  // A connection renamed while the dialog is open: re-point the on-connect
  // triggers, or saving would write the old id back (#3603).
  useFollowConnectionIdChanges(setTriggers, remapWorkflowTriggers, open);

  const sensors = useSensors(
    useSensor(ReleaseScopedPointerSensor, { activationConstraint: { distance: 5 } })
  );

  // Reload the working copy each time a workflow is opened so a prior edit never
  // leaks in and cancel truly discards.
  useEffect(() => {
    if (open && workflow) {
      reset({
        name: workflow.name,
        description: workflow.description ?? "",
        tags: workflow.tags.join(", "),
      });
      const opened = workflow.steps.map((step) => ({ uid: stepUid(), step: { ...step } }));
      setEntries(opened);
      // A step whose failure policy is out of bounds opens expanded, so the
      // inline reason that blocks Save is visible without hunting for it.
      setExpanded(
        new Set(opened.filter((e) => !workflowStepsPolicyValid([e.step])).map((e) => e.uid))
      );
      setTriggers(workflow.triggers.map((t) => ({ ...t })));
      setParameters((workflow.parameters ?? []).map((p) => ({ ...p })));
    }
  }, [open, workflow, reset]);

  // A valid form AND at least one step AND every step's error-handling policy
  // (PROD-045) within the runner's bounds.
  const policiesValid = useMemo(
    () => workflowStepsPolicyValid(entries.map((e) => e.step)),
    [entries]
  );
  // Every on-output-match trigger needs a valid, bounded pattern and in-range
  // limits (#3791); the trigger editor shows the reason inline.
  const triggersValid = useMemo(() => workflowTriggersValid(triggers), [triggers]);
  const canSave = formValid && entries.length > 0 && policiesValid && triggersValid;

  // Unsaved work spans the RHF fields and the imperative step / trigger /
  // parameter lists; any of them differing from the opened workflow arms the
  // Modal's dismiss guard (UX2-004).
  const isDirty =
    workflow !== null &&
    draftKey({
      ...formDraft,
      steps: entries.map((e) => e.step),
      triggers,
      parameters,
    }) !==
      draftKey({
        name: workflow.name,
        description: workflow.description ?? "",
        tags: workflow.tags.join(", "),
        steps: workflow.steps,
        triggers: workflow.triggers,
        parameters: workflow.parameters ?? [],
      });

  const updateStep = (uid: string, step: WorkflowStep) => {
    setEntries((prev) => prev.map((e) => (e.uid === uid ? { ...e, step } : e)));
  };

  const moveStep = (index: number, direction: -1 | 1) => {
    setEntries((prev) => {
      const target = index + direction;
      if (target < 0 || target >= prev.length) return prev;
      return arrayMove(prev, index, target);
    });
  };

  const deleteStep = (uid: string) => {
    setEntries((prev) => prev.filter((e) => e.uid !== uid));
  };

  const addStep = (kind: WorkflowStepKind) => {
    const uid = stepUid();
    setEntries((prev) => [...prev, { uid, step: newWorkflowStep(kind) }]);
    setExpanded((prev) => new Set(prev).add(uid));
  };

  const toggleStep = (uid: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(uid)) next.add(uid);
      return next;
    });
  };

  const allExpanded = entries.length > 0 && entries.every((e) => expanded.has(e.uid));
  const toggleAllSteps = () => {
    setExpanded(allExpanded ? new Set() : new Set(entries.map((e) => e.uid)));
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    setEntries((prev) => {
      const from = prev.findIndex((e) => e.uid === active.id);
      const to = prev.findIndex((e) => e.uid === over.id);
      if (from === -1 || to === -1) return prev;
      return arrayMove(prev, from, to);
    });
  };

  // Returns the parent's (possibly async) save promise so the Button drives its
  // own pending spinner; the parent surfaces its own error toast, so the Button's
  // is disabled to avoid a duplicate.
  const handleSave = () => {
    if (!canSave) return;
    const values = getValues();
    return onSave({
      name: values.name.trim(),
      description: normalizeItemDescription(values.description),
      tags: parseTags(values.tags),
      steps: entries.map((e) => e.step),
      triggers,
      parameters,
    });
  };

  const stepIds = useMemo(() => entries.map((e) => e.uid), [entries]);

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      dirty={isDirty}
      title={isNew ? "New workflow" : "Edit workflow"}
      description="Author an ordered list of typed steps and bind its triggers"
      size="lg"
      data-testid="workflow-editor-dialog"
      footer={
        <>
          {/* Routed through the Modal so a dirty form asks first (UX2-004). */}
          <ModalClose>
            <Button variant="secondary" data-testid="workflow-editor-cancel">
              Cancel
            </Button>
          </ModalClose>
          <Button
            variant="primary"
            onClick={handleSave}
            disabled={!canSave}
            errorToast={false}
            data-testid="workflow-editor-save"
          >
            Save
          </Button>
        </>
      }
    >
      {/* One scroll container — the Modal body — and one vertical rhythm:
          every field and section is a flex child spaced by a token (#5637). */}
      <div className="workflow-editor__form" data-testid="workflow-editor-form">
        <Controller
          name="name"
          control={control}
          render={({ field }) => (
            <Field label="Name" htmlFor="workflow-editor-name" error={errors["name"]}>
              <Input
                id="workflow-editor-name"
                value={field.value ?? ""}
                error={Boolean(errors["name"])}
                onChange={(e) => field.onChange(e.target.value)}
                onBlur={field.onBlur}
                placeholder="Workflow name"
                data-testid="workflow-editor-name"
              />
            </Field>
          )}
        />
        <Controller
          name="description"
          control={control}
          render={({ field }) => (
            <Field
              label="Description (optional)"
              htmlFor="workflow-editor-description"
              labelTestId="workflow-editor-description-label"
            >
              <Input
                id="workflow-editor-description"
                value={field.value ?? ""}
                onChange={(e) => field.onChange(e.target.value)}
                onBlur={field.onBlur}
                placeholder="What this workflow does"
                maxLength={ITEM_DESCRIPTION_MAX_LENGTH}
                data-testid="workflow-editor-description"
              />
            </Field>
          )}
        />
        <Controller
          name="tags"
          control={control}
          render={({ field }) => (
            <Field
              label="Tags (optional, comma-separated)"
              htmlFor="workflow-editor-tags"
              labelTestId="workflow-editor-tags-label"
            >
              <Input
                id="workflow-editor-tags"
                value={field.value ?? ""}
                onChange={(e) => field.onChange(e.target.value)}
                onBlur={field.onBlur}
                placeholder="ops, release"
                data-testid="workflow-editor-tags"
              />
            </Field>
          )}
        />

        <section
          className="workflow-editor__section"
          aria-labelledby="workflow-editor-triggers-title"
        >
          <div className="workflow-editor__section-header">
            <span id="workflow-editor-triggers-title" className="workflow-editor__section-title">
              Triggers
            </span>
            <span className="workflow-editor__section-hint">Pick one or more</span>
          </div>
          <WorkflowTriggersEditor
            triggers={triggers}
            connections={connections}
            onChange={setTriggers}
          />
        </section>

        <section className="workflow-editor__section" aria-labelledby="workflow-editor-steps-title">
          <div className="workflow-editor__section-header">
            <span id="workflow-editor-steps-title" className="workflow-editor__section-title">
              Steps ({entries.length})
            </span>
            {entries.length > 0 && (
              <Button
                variant="ghost"
                size="sm"
                onClick={toggleAllSteps}
                data-testid="workflow-editor-steps-toggle-all"
              >
                {allExpanded ? "Collapse all" : "Expand all"}
              </Button>
            )}
          </div>
          {entries.length === 0 ? (
            <EmptyState
              title="No steps yet. Add one below — a workflow needs at least one step to be saved."
              data-testid="workflow-editor-no-steps"
            />
          ) : (
            <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
              <SortableContext items={stepIds} strategy={verticalListSortingStrategy}>
                <ul className="workflow-editor__steps" data-testid="workflow-editor-steps">
                  {entries.map((entry, index) => (
                    <WorkflowStepRow
                      key={entry.uid}
                      entry={entry}
                      index={index}
                      total={entries.length}
                      macros={macros}
                      onChange={updateStep}
                      onMove={moveStep}
                      onDelete={deleteStep}
                      expanded={expanded.has(entry.uid)}
                      onToggleExpanded={toggleStep}
                    />
                  ))}
                </ul>
              </SortableContext>
            </DndContext>
          )}

          <AddStepMenu onAdd={addStep} />
        </section>

        <section
          className="workflow-editor__section"
          aria-labelledby="workflow-editor-params-title"
        >
          <div className="workflow-editor__section-header">
            <span id="workflow-editor-params-title" className="workflow-editor__section-title">
              Parameters ({parameters.length})
            </span>
          </div>
          <WorkflowParametersEditor parameters={parameters} onChange={setParameters} />
        </section>
      </div>
    </Modal>
  );
}

interface AddStepMenuProps {
  onAdd: (kind: WorkflowStepKind) => void;
}

/**
 * The "Add step…" dropdown. Extracted so it renders *inside* the {@link Modal}
 * body and can read {@link useModalPortalContainer}: the menu content must
 * portal into the dialog's content node, not `document.body`, or the modal's
 * `pointer-events: none` on the body leaves it dead/unclickable (#1868).
 */
function AddStepMenu({ onAdd }: AddStepMenuProps) {
  const portalContainer = useModalPortalContainer();
  return (
    <DropdownMenuRoot>
      <DropdownMenuTrigger asChild>
        <Button
          variant="secondary"
          size="sm"
          icon={<Plus size={14} />}
          data-testid="workflow-editor-add-step"
        >
          Add step…
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent container={portalContainer} align="start" sideOffset={4}>
        {WORKFLOW_STEP_KINDS.map((kind) => {
          const Icon = stepKindIcon(kind);
          return (
            <MenuItem
              key={kind}
              onSelect={() => onAdd(kind)}
              data-testid={`workflow-editor-add-step-${kind}`}
            >
              <Icon size={14} />
              {stepKindLabel(kind)}
            </MenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenuRoot>
  );
}
