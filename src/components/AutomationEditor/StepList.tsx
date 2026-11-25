import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DndContext, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, arrayMove, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { Button } from "@/components/ui";
import { ReleaseScopedPointerSensor } from "@/utils/releaseScopedPointerSensor";
import { AddStepMenu } from "./AddStepMenu";
import { duplicateStepDraft, toStepDraft, type StepDraft } from "./automationDraft";
import { useStepEditor, type StepListProps } from "./stepEditorContext";
import { newStep, stepKindLabel, type AutomationStepKind } from "./stepMeta";
import { StepRow } from "./StepRow";

/** What to focus once the list has rendered. */
interface PendingFocus {
  uid: string;
  target: "grip" | "toggle" | "field";
}

const FOCUS_SELECTOR: Record<PendingFocus["target"], string> = {
  grip: ".automation-step__grip",
  toggle: ".automation-step__toggle",
  field: ".automation-step__body :is(input, textarea, button):not(.type-keys__more)",
};

/** Drag instructions for a screen reader: the handle reorders with the arrows. */
const DRAG_INSTRUCTIONS = {
  draggable: "Press the Up or Down arrow key to move the step.",
};

/**
 * An ordered, editable list of steps with its "Add step" menu: the automation's
 * own steps, and the branches of a condition and the body of a loop. A step is
 * reordered by dragging its handle or with the arrow keys on it (R-167), and a
 * deleted one can be brought back with Undo.
 */
export function StepList({ steps, onChange, nested }: StepListProps) {
  const { setExpanded, announce } = useStepEditor();
  const rootRef = useRef<HTMLDivElement>(null);
  const [deleted, setDeleted] = useState<{ index: number; step: StepDraft } | null>(null);
  const [pendingFocus, setPendingFocus] = useState<PendingFocus | null>(null);
  const addedUid = useRef<string | null>(null);
  const sensors = useSensors(
    useSensor(ReleaseScopedPointerSensor, { activationConstraint: { distance: 5 } })
  );
  const ids = useMemo(() => steps.map((s) => s.uid), [steps]);
  const base = nested ? `${nested.parent}-${nested.list}` : undefined;

  const focusStep = useCallback((uid: string, target: PendingFocus["target"]) => {
    const row = Array.from(
      rootRef.current?.querySelectorAll<HTMLElement>("[data-step-uid]") ?? []
    ).find((el) => el.dataset.stepUid === uid);
    row?.querySelector<HTMLElement>(FOCUS_SELECTOR[target])?.focus();
  }, []);

  useEffect(() => {
    if (!pendingFocus) return;
    setPendingFocus(null);
    focusStep(pendingFocus.uid, pendingFocus.target);
  }, [pendingFocus, focusStep]);

  /** Add a step before the one at `index`. */
  const addStepAt = (kind: AutomationStepKind, index: number) => {
    const step = toStepDraft(newStep(kind));
    addedUid.current = step.uid;
    setDeleted(null);
    setExpanded(step.uid, true);
    const next = steps.slice();
    next.splice(index, 0, step);
    onChange(next);
  };

  const handleAdded = () => {
    if (addedUid.current) focusStep(addedUid.current, "field");
  };

  /** Move a step to `to`, keeping the focus on the handle that moved it. */
  const moveStep = (from: number, to: number, keepFocus: boolean) => {
    if (to < 0 || to >= steps.length || from === to) return;
    onChange(arrayMove(steps, from, to));
    announce(`Step moved to position ${to + 1} of ${steps.length}.`);
    if (keepFocus) setPendingFocus({ uid: steps[from].uid, target: "grip" });
  };

  const deleteStep = (index: number) => {
    const step = steps[index];
    const rest = steps.filter((_, i) => i !== index);
    setDeleted({ index, step });
    onChange(rest);
    announce(`${stepKindLabel(step.step.kind)} step deleted. Undo is available.`);
    const neighbor = rest[Math.min(index, rest.length - 1)];
    if (neighbor) setPendingFocus({ uid: neighbor.uid, target: "toggle" });
  };

  const undoDelete = () => {
    if (!deleted) return;
    const next = steps.slice();
    next.splice(Math.min(deleted.index, next.length), 0, deleted.step);
    onChange(next);
    setDeleted(null);
    setPendingFocus({ uid: deleted.step.uid, target: "toggle" });
  };

  const duplicateStep = (index: number) => {
    const copy = duplicateStepDraft(steps[index]);
    const next = steps.slice();
    next.splice(index + 1, 0, copy);
    onChange(next);
    setPendingFocus({ uid: copy.uid, target: "toggle" });
  };

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    moveStep(
      steps.findIndex((s) => s.uid === active.id),
      steps.findIndex((s) => s.uid === over.id),
      false
    );
  };

  return (
    <div
      ref={rootRef}
      className={nested ? "automation-steps automation-steps--nested" : "automation-steps"}
      data-testid={base === undefined ? undefined : `automation-editor-branch-${base}`}
    >
      {nested && (
        <span className="automation-steps__label">
          {nested.label} ({steps.length})
        </span>
      )}
      {steps.length > 0 && (
        <DndContext
          sensors={sensors}
          onDragEnd={handleDragEnd}
          accessibility={{ screenReaderInstructions: DRAG_INSTRUCTIONS }}
        >
          <SortableContext items={ids} strategy={verticalListSortingStrategy}>
            <ul
              className="automation-steps__list"
              data-testid={base === undefined ? "automation-editor-steps" : undefined}
            >
              {steps.map((step, index) => (
                <Fragment key={step.uid}>
                  {index > 0 && (
                    <li className="automation-steps__insert" role="presentation">
                      <AddStepMenu
                        nestedIn={base}
                        before={index}
                        onAdd={(kind) => addStepAt(kind, index)}
                        onAdded={handleAdded}
                      />
                    </li>
                  )}
                  <StepRow
                    nestedIn={base}
                    onAddBelow={(kind) => {
                      addStepAt(kind, index + 1);
                      return handleAdded;
                    }}
                    draft={step}
                    path={base === undefined ? String(index) : `${base}-${index}`}
                    index={index}
                    total={steps.length}
                    onChange={(next) => onChange(steps.map((s, i) => (i === index ? next : s)))}
                    onMove={(direction, keepFocus) => moveStep(index, index + direction, keepFocus)}
                    onDuplicate={() => duplicateStep(index)}
                    onDelete={() => deleteStep(index)}
                  />
                </Fragment>
              ))}
            </ul>
          </SortableContext>
        </DndContext>
      )}
      <div className="automation-steps__footer">
        <AddStepMenu
          nestedIn={base}
          onAdd={(kind) => addStepAt(kind, steps.length)}
          onAdded={handleAdded}
        />
        {deleted && (
          <span
            className="automation-steps__deleted"
            data-testid={
              base === undefined
                ? "automation-editor-step-deleted"
                : `automation-editor-step-deleted-${base}`
            }
          >
            Deleted {stepKindLabel(deleted.step.step.kind)}.
            <Button
              variant="ghost"
              size="sm"
              onClick={undoDelete}
              aria-label={`Undo deleting the ${stepKindLabel(deleted.step.step.kind)} step`}
              data-testid={
                base === undefined
                  ? "automation-editor-step-undo"
                  : `automation-editor-step-undo-${base}`
              }
            >
              Undo
            </Button>
          </span>
        )}
      </div>
    </div>
  );
}
