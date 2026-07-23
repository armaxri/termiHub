import type React from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, ArrowUp, ArrowDown, Trash2 } from "lucide-react";
import { Button, Input, Textarea, NumberInput, Select, Field } from "@/components/ui";
import type { WorkflowStep } from "@/types/workflow";
import type { Macro } from "@/types/macro";
import { stepKindIcon, stepKindLabel } from "./workflowStepMeta";

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
          index={index}
          step={step}
          macros={macros}
          onChange={(next) => onChange(entry.uid, next)}
        />
      </div>
    </li>
  );
}

interface StepDetailEditorProps {
  index: number;
  step: WorkflowStep;
  macros: Macro[];
  onChange: (step: WorkflowStep) => void;
}

/** The per-kind detail fields for a single step, driven by the discriminant. */
function StepDetailEditor({ index, step, macros, onChange }: StepDetailEditorProps) {
  switch (step.kind) {
    case "send-command":
      return (
        <Field label="Command" htmlFor={`workflow-step-command-${index}`}>
          <Input
            id={`workflow-step-command-${index}`}
            value={step.command}
            placeholder="e.g. sudo -v"
            onChange={(e) => onChange({ ...step, command: e.target.value })}
            data-testid={`workflow-editor-step-command-${index}`}
          />
        </Field>
      );
    case "run-script":
      return (
        <>
          <Field label="Script" htmlFor={`workflow-step-script-${index}`}>
            <Textarea
              id={`workflow-step-script-${index}`}
              value={step.script}
              placeholder="One command per line"
              onChange={(e) => onChange({ ...step, script: e.target.value })}
              data-testid={`workflow-editor-step-script-${index}`}
            />
          </Field>
          <Field label="Per-line delay (ms, optional)" htmlFor={`workflow-step-linedelay-${index}`}>
            <NumberInput
              value={step.perLineDelayMs ?? ""}
              min={0}
              step={10}
              onValueChange={(v) =>
                onChange({ ...step, perLineDelayMs: v === "" ? undefined : Math.max(0, v) })
              }
              aria-label={`Per-line delay for step ${index + 1} in milliseconds`}
              data-testid={`workflow-editor-step-linedelay-${index}`}
            />
          </Field>
        </>
      );
    case "run-macro":
      return (
        <Field label="Macro" htmlFor={`workflow-step-macro-${index}`}>
          <Select
            value={step.macroId || undefined}
            onChange={(value) => onChange({ ...step, macroId: value })}
            options={macros.map((m) => ({ value: m.id, label: m.name }))}
            placeholder={macros.length ? "Select a macro" : "No macros available"}
            aria-label={`Macro for step ${index + 1}`}
            data-testid={`workflow-editor-step-macro-${index}`}
          />
        </Field>
      );
    case "wait":
      return (
        <Field label="Delay (ms)" htmlFor={`workflow-step-delay-${index}`}>
          <NumberInput
            value={step.delayMs}
            min={0}
            step={100}
            onValueChange={(v) => onChange({ ...step, delayMs: v === "" ? 0 : Math.max(0, v) })}
            aria-label={`Wait delay for step ${index + 1} in milliseconds`}
            data-testid={`workflow-editor-step-delay-${index}`}
          />
        </Field>
      );
    case "run-local-process":
      return (
        <>
          <Field label="Program" htmlFor={`workflow-step-program-${index}`}>
            <Input
              id={`workflow-step-program-${index}`}
              value={step.program}
              placeholder="e.g. /usr/bin/notify-send"
              onChange={(e) => onChange({ ...step, program: e.target.value })}
              data-testid={`workflow-editor-step-program-${index}`}
            />
          </Field>
          <Field label="Arguments (space-separated)" htmlFor={`workflow-step-args-${index}`}>
            <Input
              id={`workflow-step-args-${index}`}
              value={step.args.join(" ")}
              placeholder="arg1 arg2"
              onChange={(e) =>
                onChange({ ...step, args: e.target.value.split(/\s+/).filter(Boolean) })
              }
              data-testid={`workflow-editor-step-args-${index}`}
            />
          </Field>
        </>
      );
  }
}
