import type React from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, ArrowUp, ArrowDown, Trash2, Plus } from "lucide-react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  Button,
  Input,
  Textarea,
  NumberInput,
  Select,
  Field,
  useModalPortalContainer,
} from "@/components/ui";
import type { WorkflowStep, WorkflowStepKind } from "@/types/workflow";
import type { Macro } from "@/types/macro";
import {
  WORKFLOW_STEP_KINDS,
  WORKFLOW_CONDITION_OPS,
  conditionOpLabel,
  newWorkflowStep,
  stepKindIcon,
  stepKindLabel,
} from "./workflowStepMeta";

/** A working step paired with a stable uid for drag-and-drop and React keys. */
export interface WorkflowStepEntry {
  uid: string;
  step: WorkflowStep;
}

interface WorkflowStepRowProps {
  entry: WorkflowStepEntry;
  index: number;
  total: number;
  /** Stored macros, for the run-macro step's target picker. */
  macros: Macro[];
  onChange: (uid: string, step: WorkflowStep) => void;
  onMove: (index: number, direction: -1 | 1) => void;
  onDelete: (uid: string) => void;
}

/**
 * One editable, reorderable step row in the workflow editor. The grip handle
 * drives drag-and-drop (dnd-kit sortable); up/down buttons provide a
 * keyboard/click reorder fallback. The row body is a per-kind detail editor —
 * a command input, a script textarea, a macro picker, a wait delay, or a
 * local-process program+args pair — driven by the step's discriminant.
 */
export function WorkflowStepRow({
  entry,
  index,
  total,
  macros,
  onChange,
  onMove,
  onDelete,
}: WorkflowStepRowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: entry.uid,
  });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : undefined,
  };

  const { step } = entry;
  const Icon = stepKindIcon(step.kind);

  return (
    <li
      ref={setNodeRef}
      style={style}
      className="workflow-step"
      data-testid={`workflow-editor-step-${index}`}
    >
      <div className="workflow-step__header">
        <button
          type="button"
          className="workflow-step__grip"
          aria-label={`Reorder step ${index + 1}`}
          data-testid={`workflow-editor-step-grip-${index}`}
          {...attributes}
          {...listeners}
        >
          <GripVertical size={14} />
        </button>
        <span className="workflow-step__index">{index + 1}</span>
        <Icon size={14} />
        <span className="workflow-step__kind" data-testid={`workflow-editor-step-kind-${index}`}>
          {stepKindLabel(step.kind)}
        </span>
        <div className="workflow-step__actions">
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            aria-label={`Move step ${index + 1} up`}
            disabled={index === 0}
            icon={<ArrowUp size={12} />}
            onClick={() => onMove(index, -1)}
            data-testid={`workflow-editor-step-up-${index}`}
          />
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            aria-label={`Move step ${index + 1} down`}
            disabled={index === total - 1}
            icon={<ArrowDown size={12} />}
            onClick={() => onMove(index, 1)}
            data-testid={`workflow-editor-step-down-${index}`}
          />
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            aria-label={`Delete step ${index + 1}`}
            icon={<Trash2 size={12} />}
            onClick={() => onDelete(entry.uid)}
            data-testid={`workflow-editor-step-delete-${index}`}
          />
        </div>
      </div>
      <div className="workflow-step__body">
        <StepDetailEditor
          fieldId={String(index)}
          stepNumber={index + 1}
          step={step}
          macros={macros}
          onChange={(next) => onChange(entry.uid, next)}
        />
      </div>
    </li>
  );
}

interface StepDetailEditorProps {
  /** Unique id/testid suffix for this step's fields (e.g. `"0"` or `"0-then-1"`). */
  fieldId: string;
  /** 1-based number used in aria labels ("step N"). */
  stepNumber: number;
  step: WorkflowStep;
  macros: Macro[];
  onChange: (step: WorkflowStep) => void;
}

/**
 * The per-kind detail fields for a single step, driven by the discriminant.
 * `fieldId` scopes every input's id/testid so a nested step (inside a
 * `conditional`'s then/else list) never collides with its parent's ids.
 * Exported so the conditional editor can render its sub-steps recursively.
 */
export function StepDetailEditor({
  fieldId,
  stepNumber,
  step,
  macros,
  onChange,
}: StepDetailEditorProps) {
  switch (step.kind) {
    case "send-command":
      return (
        <Field label="Command" htmlFor={`workflow-step-command-${fieldId}`}>
          <Input
            id={`workflow-step-command-${fieldId}`}
            value={step.command}
            placeholder="e.g. sudo -v"
            onChange={(e) => onChange({ ...step, command: e.target.value })}
            data-testid={`workflow-editor-step-command-${fieldId}`}
          />
        </Field>
      );
    case "run-script":
      return (
        <>
          <Field label="Script" htmlFor={`workflow-step-script-${fieldId}`}>
            <Textarea
              id={`workflow-step-script-${fieldId}`}
              value={step.script}
              placeholder="One command per line"
              onChange={(e) => onChange({ ...step, script: e.target.value })}
              data-testid={`workflow-editor-step-script-${fieldId}`}
            />
          </Field>
          <Field
            label="Per-line delay (ms, optional)"
            htmlFor={`workflow-step-linedelay-${fieldId}`}
          >
            <NumberInput
              value={step.perLineDelayMs ?? ""}
              min={0}
              step={10}
              onValueChange={(v) =>
                onChange({ ...step, perLineDelayMs: v === "" ? undefined : Math.max(0, v) })
              }
              aria-label={`Per-line delay for step ${stepNumber} in milliseconds`}
              data-testid={`workflow-editor-step-linedelay-${fieldId}`}
            />
          </Field>
        </>
      );
    case "run-macro":
      return (
        <Field label="Macro" htmlFor={`workflow-step-macro-${fieldId}`}>
          <Select
            value={step.macroId || undefined}
            onChange={(value) => onChange({ ...step, macroId: value })}
            options={macros.map((m) => ({ value: m.id, label: m.name }))}
            placeholder={macros.length ? "Select a macro" : "No macros available"}
            aria-label={`Macro for step ${stepNumber}`}
            data-testid={`workflow-editor-step-macro-${fieldId}`}
          />
        </Field>
      );
    case "wait":
      return (
        <Field label="Delay (ms)" htmlFor={`workflow-step-delay-${fieldId}`}>
          <NumberInput
            value={step.delayMs}
            min={0}
            step={100}
            onValueChange={(v) => onChange({ ...step, delayMs: v === "" ? 0 : Math.max(0, v) })}
            aria-label={`Wait delay for step ${stepNumber} in milliseconds`}
            data-testid={`workflow-editor-step-delay-${fieldId}`}
          />
        </Field>
      );
    case "run-local-process":
      return (
        <>
          <Field label="Program" htmlFor={`workflow-step-program-${fieldId}`}>
            <Input
              id={`workflow-step-program-${fieldId}`}
              value={step.program}
              placeholder="e.g. /usr/bin/notify-send"
              onChange={(e) => onChange({ ...step, program: e.target.value })}
              data-testid={`workflow-editor-step-program-${fieldId}`}
            />
          </Field>
          <LocalProcessArgsEditor
            fieldId={fieldId}
            stepNumber={stepNumber}
            args={step.args}
            onChange={(args) => onChange({ ...step, args })}
          />
        </>
      );
    case "conditional":
      return (
        <ConditionalStepEditor fieldId={fieldId} step={step} macros={macros} onChange={onChange} />
      );
  }
}

interface LocalProcessArgsEditorProps {
  fieldId: string;
  stepNumber: number;
  args: string[];
  onChange: (args: string[]) => void;
}

/**
 * A discrete, ordered list of program arguments — one {@link Input} per argument
 * (#1857). This replaces the old whitespace-split single field so an argument
 * that contains spaces (e.g. a message body or a path) stays a single, literal
 * argument. Each argument is passed to the backend as its own argv entry with no
 * shell involved, so nothing here is ever re-split or interpreted.
 */
function LocalProcessArgsEditor({
  fieldId,
  stepNumber,
  args,
  onChange,
}: LocalProcessArgsEditorProps) {
  const setArg = (i: number, value: string) => {
    const next = args.slice();
    next[i] = value;
    onChange(next);
  };
  const removeArg = (i: number) => onChange(args.filter((_, j) => j !== i));
  const addArg = () => onChange([...args, ""]);

  return (
    <Field label="Arguments" htmlFor={`workflow-step-arg-${fieldId}-0`}>
      <div className="workflow-step__args" data-testid={`workflow-editor-step-args-${fieldId}`}>
        {args.length === 0 && <span className="workflow-step__args-empty">No arguments.</span>}
        {args.map((arg, i) => (
          <div className="workflow-step__arg-row" key={i}>
            <Input
              id={`workflow-step-arg-${fieldId}-${i}`}
              value={arg}
              placeholder={`argument ${i + 1}`}
              onChange={(e) => setArg(i, e.target.value)}
              aria-label={`Argument ${i + 1} for step ${stepNumber}`}
              data-testid={`workflow-editor-step-arg-${fieldId}-${i}`}
            />
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              aria-label={`Remove argument ${i + 1}`}
              icon={<Trash2 size={12} />}
              onClick={() => removeArg(i)}
              data-testid={`workflow-editor-step-arg-remove-${fieldId}-${i}`}
            />
          </div>
        ))}
        <Button
          variant="secondary"
          size="sm"
          icon={<Plus size={12} />}
          onClick={addArg}
          data-testid={`workflow-editor-step-arg-add-${fieldId}`}
        >
          Add argument
        </Button>
      </div>
    </Field>
  );
}

/** Step kinds offered in a conditional's then/else "add step" menu. Slice 1
 * keeps sub-branches flat: a nested `conditional` is not offered here (the model
 * and runner support nesting; the authoring UI is bounded to one level). */
const LEAF_STEP_KINDS: readonly WorkflowStepKind[] = WORKFLOW_STEP_KINDS.filter(
  (k) => k !== "conditional"
);

interface ConditionalStepEditorProps {
  fieldId: string;
  step: Extract<WorkflowStep, { kind: "conditional" }>;
  macros: Macro[];
  onChange: (step: WorkflowStep) => void;
}

/**
 * Detail editor for a `conditional` step (PROD-0044): a structured condition
 * builder (left / operator / right) and two sub-step lists for the `then` and
 * `else` branches. `${param}` references in the operands are resolved at run
 * time. Sub-steps reuse {@link StepDetailEditor}, so each branch is a normal,
 * editable step list — kept flat in slice 1 (no nested conditional in the menu).
 */
function ConditionalStepEditor({ fieldId, step, macros, onChange }: ConditionalStepEditorProps) {
  const { condition } = step;
  return (
    <div
      className="workflow-step__conditional"
      data-testid={`workflow-editor-conditional-${fieldId}`}
    >
      <div className="workflow-step__condition">
        <Field label="If (left)" htmlFor={`workflow-step-cond-left-${fieldId}`}>
          <Input
            id={`workflow-step-cond-left-${fieldId}`}
            value={condition.left}
            placeholder="e.g. ${env}"
            onChange={(e) =>
              onChange({ ...step, condition: { ...condition, left: e.target.value } })
            }
            data-testid={`workflow-editor-cond-left-${fieldId}`}
          />
        </Field>
        <Field label="Operator" htmlFor={`workflow-step-cond-op-${fieldId}`}>
          <Select
            value={condition.op}
            onChange={(value) =>
              onChange({
                ...step,
                condition: { ...condition, op: value as typeof condition.op },
              })
            }
            options={WORKFLOW_CONDITION_OPS.map((op) => ({
              value: op,
              label: conditionOpLabel(op),
            }))}
            aria-label={`Condition operator for step ${fieldId}`}
            data-testid={`workflow-editor-cond-op-${fieldId}`}
          />
        </Field>
        <Field label="Right" htmlFor={`workflow-step-cond-right-${fieldId}`}>
          <Input
            id={`workflow-step-cond-right-${fieldId}`}
            value={condition.right}
            placeholder="e.g. prod"
            onChange={(e) =>
              onChange({ ...step, condition: { ...condition, right: e.target.value } })
            }
            data-testid={`workflow-editor-cond-right-${fieldId}`}
          />
        </Field>
      </div>
      <SubStepList
        label="Then"
        branch="then"
        fieldId={fieldId}
        steps={step.then}
        macros={macros}
        onChange={(then) => onChange({ ...step, then })}
      />
      <SubStepList
        label="Else (optional)"
        branch="else"
        fieldId={fieldId}
        steps={step.else ?? []}
        macros={macros}
        onChange={(next) => onChange({ ...step, else: next.length ? next : undefined })}
      />
    </div>
  );
}

interface SubStepListProps {
  label: string;
  branch: "then" | "else";
  fieldId: string;
  steps: WorkflowStep[];
  macros: Macro[];
  onChange: (steps: WorkflowStep[]) => void;
}

/** An editable, ordered list of a conditional branch's sub-steps. */
function SubStepList({ label, branch, fieldId, steps, macros, onChange }: SubStepListProps) {
  const base = `${fieldId}-${branch}`;
  const update = (i: number, next: WorkflowStep) =>
    onChange(steps.map((s, j) => (j === i ? next : s)));
  const remove = (i: number) => onChange(steps.filter((_, j) => j !== i));
  const move = (i: number, dir: -1 | 1) => {
    const target = i + dir;
    if (target < 0 || target >= steps.length) return;
    const next = steps.slice();
    [next[i], next[target]] = [next[target], next[i]];
    onChange(next);
  };
  const add = (kind: WorkflowStepKind) => onChange([...steps, newWorkflowStep(kind)]);

  return (
    <div className="workflow-step__branch" data-testid={`workflow-editor-branch-${base}`}>
      <span className="workflow-step__branch-label">
        {label} ({steps.length})
      </span>
      <ul className="workflow-step__substeps">
        {steps.map((sub, i) => {
          const Icon = stepKindIcon(sub.kind);
          return (
            <li
              key={i}
              className="workflow-step__substep"
              data-testid={`workflow-editor-substep-${base}-${i}`}
            >
              <div className="workflow-step__substep-header">
                <Icon size={12} />
                <span className="workflow-step__kind">{stepKindLabel(sub.kind)}</span>
                <div className="workflow-step__actions">
                  <Button
                    variant="ghost"
                    size="sm"
                    iconOnly
                    aria-label={`Move ${label} sub-step ${i + 1} up`}
                    disabled={i === 0}
                    icon={<ArrowUp size={12} />}
                    onClick={() => move(i, -1)}
                    data-testid={`workflow-editor-substep-up-${base}-${i}`}
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    iconOnly
                    aria-label={`Move ${label} sub-step ${i + 1} down`}
                    disabled={i === steps.length - 1}
                    icon={<ArrowDown size={12} />}
                    onClick={() => move(i, 1)}
                    data-testid={`workflow-editor-substep-down-${base}-${i}`}
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    iconOnly
                    aria-label={`Delete ${label} sub-step ${i + 1}`}
                    icon={<Trash2 size={12} />}
                    onClick={() => remove(i)}
                    data-testid={`workflow-editor-substep-delete-${base}-${i}`}
                  />
                </div>
              </div>
              <div className="workflow-step__substep-body">
                <StepDetailEditor
                  fieldId={`${base}-${i}`}
                  stepNumber={i + 1}
                  step={sub}
                  macros={macros}
                  onChange={(next) => update(i, next)}
                />
              </div>
            </li>
          );
        })}
      </ul>
      <AddSubStepMenu base={base} onAdd={add} />
    </div>
  );
}

interface AddSubStepMenuProps {
  base: string;
  onAdd: (kind: WorkflowStepKind) => void;
}

/**
 * "Add step…" dropdown for a conditional branch, offering the leaf step kinds.
 * Portals into the modal's content node (not `document.body`) so the modal's
 * `pointer-events: none` on the body does not leave it dead (#1868).
 */
function AddSubStepMenu({ base, onAdd }: AddSubStepMenuProps) {
  const portalContainer = useModalPortalContainer();
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <Button
          variant="secondary"
          size="sm"
          icon={<Plus size={12} />}
          data-testid={`workflow-editor-add-substep-${base}`}
        >
          Add step…
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal container={portalContainer}>
        <DropdownMenu.Content className="settings-menu__content" align="start" sideOffset={4}>
          {LEAF_STEP_KINDS.map((kind) => {
            const Icon = stepKindIcon(kind);
            return (
              <DropdownMenu.Item
                key={kind}
                className="settings-menu__item"
                onSelect={() => onAdd(kind)}
                data-testid={`workflow-editor-add-substep-${base}-${kind}`}
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
