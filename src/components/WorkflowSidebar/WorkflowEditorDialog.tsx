import { useEffect, useMemo, useState } from "react";
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
import "./WorkflowEditorDialog.css";

/** The editable fields the dialog collects before saving a workflow. */
export interface WorkflowEditorResult {
  name: string;
  description?: string;
  tags: string[];
  steps: WorkflowStep[];
  triggers: WorkflowTrigger[];
}

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

/** Generate a transient uid for a working step entry (React key + dnd id). */
function stepUid(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return `step-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
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
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [tags, setTags] = useState("");
  const [entries, setEntries] = useState<WorkflowStepEntry[]>([]);
  const [triggers, setTriggers] = useState<WorkflowTrigger[]>([]);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  // Reload the working copy each time a workflow is opened so a prior edit never
  // leaks in and cancel truly discards.
  useEffect(() => {
    if (open && workflow) {
      setName(workflow.name);
      setDescription(workflow.description ?? "");
      setTags(workflow.tags.join(", "));
      setEntries(workflow.steps.map((step) => ({ uid: stepUid(), step: { ...step } })));
      setTriggers(workflow.triggers.map((t) => ({ ...t })));
    }
  }, [open, workflow]);

  const trimmedName = name.trim();
  const canSave = trimmedName.length > 0 && entries.length > 0;

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
    return onSave({
      name: trimmedName,
      description: description.trim() || undefined,
      tags: parseTags(tags),
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
      <Field label="Name" htmlFor="workflow-editor-name">
        <Input
          id="workflow-editor-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Workflow name"
          data-testid="workflow-editor-name"
        />
      </Field>
      <Field label="Description (optional)" htmlFor="workflow-editor-description">
        <Input
          id="workflow-editor-description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What this workflow does"
          data-testid="workflow-editor-description"
        />
      </Field>
      <Field label="Tags (optional, comma-separated)" htmlFor="workflow-editor-tags">
        <Input
          id="workflow-editor-tags"
          value={tags}
          onChange={(e) => setTags(e.target.value)}
          placeholder="ops, release"
          data-testid="workflow-editor-tags"
        />
      </Field>

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
