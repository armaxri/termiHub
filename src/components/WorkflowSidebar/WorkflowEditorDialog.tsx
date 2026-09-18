import { useEffect, useMemo, useState } from "react";
import { Controller, useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Plus } from "lucide-react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { DndContext, DragEndEvent, PointerSensor, useSensor, useSensors } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy, arrayMove } from "@dnd-kit/sortable";
import { Modal, Button, Input, Field, useModalPortalContainer } from "@/components/ui";
import type { Workflow, WorkflowStep, WorkflowStepKind, WorkflowTrigger } from "@/types/workflow";
import type { Macro } from "@/types/macro";
import type { SavedConnection } from "@/types/connection";
import { WorkflowStepRow, type WorkflowStepEntry } from "./WorkflowStepRow";
import { WorkflowTriggersEditor } from "./WorkflowTriggersEditor";
import {
  WORKFLOW_STEP_KINDS,
  stepKindLabel,
  stepKindIcon,
  newWorkflowStep,
} from "./workflowStepMeta";
import { newId } from "@/services/transport/ids";
import { parseTags } from "@/utils/parseTags";
import "./WorkflowEditorDialog.css";

/** The editable fields the dialog collects before saving a workflow. */
export interface WorkflowEditorResult {
  name: string;
  description?: string;
  tags: string[];
  steps: WorkflowStep[];
  triggers: WorkflowTrigger[];
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
 * section binding manual / on-connect / hotkey. Composed entirely from the
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
  const { control, getValues, reset } = useForm<WorkflowFormValues>({
    defaultValues: { name: "", description: "", tags: "" },
    resolver: zodResolver(workflowFormSchema),
    mode: "onChange",
  });
  const [entries, setEntries] = useState<WorkflowStepEntry[]>([]);
  const [triggers, setTriggers] = useState<WorkflowTrigger[]>([]);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  // Reload the working copy each time a workflow is opened so a prior edit never
  // leaks in and cancel truly discards.
  useEffect(() => {
    if (open && workflow) {
      reset({
        name: workflow.name,
        description: workflow.description ?? "",
        tags: workflow.tags.join(", "),
      });
      setEntries(workflow.steps.map((step) => ({ uid: stepUid(), step: { ...step } })));
      setTriggers(workflow.triggers.map((t) => ({ ...t })));
    }
  }, [open, workflow, reset]);

  // Deterministic, synchronous form validity derived straight from the schema
  // (same approach as CustomRuleEditor / ConnectionSettingsForm) rather than
  // react-hook-form's async error proxy, so the Save gate updates on the same
  // render as the edit and stays testable without awaiting.
  const watched = useWatch({ control });
  const formValid = useMemo(() => {
    return workflowFormSchema.safeParse({
      name: watched.name ?? "",
      description: watched.description ?? "",
      tags: watched.tags ?? "",
    }).success;
  }, [watched.name, watched.description, watched.tags]);

  // Preserves today's exact gate: a valid form AND at least one step.
  const canSave = formValid && entries.length > 0;

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
    setEntries((prev) => [...prev, { uid: stepUid(), step: newWorkflowStep(kind) }]);
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
      description: values.description.trim() || undefined,
      tags: parseTags(values.tags),
      steps: entries.map((e) => e.step),
      triggers,
    });
  };

  const stepIds = useMemo(() => entries.map((e) => e.uid), [entries]);

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={isNew ? "New Workflow" : "Edit Workflow"}
      description="Author an ordered list of typed steps and bind its triggers"
      size="lg"
      data-testid="workflow-editor-dialog"
      footer={
        <>
          <Button
            variant="secondary"
            onClick={() => onOpenChange(false)}
            data-testid="workflow-editor-cancel"
          >
            Cancel
          </Button>
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
      <Controller
        name="name"
        control={control}
        render={({ field }) => (
          <Field label="Name" htmlFor="workflow-editor-name">
            <Input
              id="workflow-editor-name"
              value={field.value ?? ""}
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
          <Field label="Description (optional)" htmlFor="workflow-editor-description">
            <Input
              id="workflow-editor-description"
              value={field.value ?? ""}
              onChange={(e) => field.onChange(e.target.value)}
              onBlur={field.onBlur}
              placeholder="What this workflow does"
              data-testid="workflow-editor-description"
            />
          </Field>
        )}
      />
      <Controller
        name="tags"
        control={control}
        render={({ field }) => (
          <Field label="Tags (optional, comma-separated)" htmlFor="workflow-editor-tags">
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

      <div className="workflow-editor__section-header">
        <span className="workflow-editor__section-title">Steps ({entries.length})</span>
      </div>
      {entries.length === 0 ? (
        <p className="workflow-editor__empty" role="status" data-testid="workflow-editor-no-steps">
          No steps yet. Add one below — a workflow needs at least one step to be saved.
        </p>
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
                />
              ))}
            </ul>
          </SortableContext>
        </DndContext>
      )}

      <AddStepMenu onAdd={addStep} />

      <div className="workflow-editor__section-header">
        <span className="workflow-editor__section-title">Triggers</span>
      </div>
      <WorkflowTriggersEditor
        triggers={triggers}
        connections={connections}
        onChange={setTriggers}
      />
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
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <Button
          variant="secondary"
          size="sm"
          icon={<Plus size={14} />}
          data-testid="workflow-editor-add-step"
        >
          Add step…
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal container={portalContainer}>
        <DropdownMenu.Content className="settings-menu__content" align="start" sideOffset={4}>
          {WORKFLOW_STEP_KINDS.map((kind) => {
            const Icon = stepKindIcon(kind);
            return (
              <DropdownMenu.Item
                key={kind}
                className="settings-menu__item"
                onSelect={() => onAdd(kind)}
                data-testid={`workflow-editor-add-step-${kind}`}
              >
                <Icon size={14} />
                {stepKindLabel(kind)}
              </DropdownMenu.Item>
            );
          })}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
