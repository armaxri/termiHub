import type React from "react";
import { flushSync } from "react-dom";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ChevronRight, GripVertical, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui";
import { useLocalProcessSwitches } from "@/hooks/useExperimentalFeatures";
import { localProcessSwitchOff } from "@/utils/localProcessGate";
import { fromStepDraft, type StepDraft } from "./automationDraft";
import { FailureOptions } from "./FailureOptions";
import { useStepEditor } from "./stepEditorContext";
import { StepFields } from "./StepFields";
import {
  LOCAL_PROCESS_STEP_REASON,
  LOCAL_PROGRAMS_STEP_REASON,
  UNKNOWN_STEP_REASON,
  isKnownStepKind,
  stepKindIcon,
  stepKindLabel,
  stepNotes,
  stepSummary,
  type AutomationStepKind,
} from "./stepMeta";
import { StepRowMenu } from "./StepRowMenu";

/** Props of {@link StepRow}. */
export interface StepRowProps {
  draft: StepDraft;
  /** Path of the step (`0`, `2-then-1`), unique in the editor. */
  path: string;
  /** Position in its list, from 0. */
  index: number;
  total: number;
  onChange: (draft: StepDraft) => void;
  /** Move the step; `keepFocus` when its handle did it. */
  onMove: (direction: -1 | 1, keepFocus: boolean) => void;
  onDuplicate: () => void;
  onDelete: () => void;
  /** Path of the nested list it sits in, if any. */
  nestedIn?: string;
  /** Add a step after this one; returns what to do once the menu closed. */
  onAddBelow: (kind: AutomationStepKind) => () => void;
}

/**
 * One step: a single line (handle, kind, what it does, notes, "…" menu) that
 * opens to the step's fields (#5637, #5818). Its failure options show once they
 * are set or asked for, so a plain step stays plain.
 */
export function StepRow({
  draft,
  path,
  index,
  total,
  onChange,
  onMove,
  onDuplicate,
  onDelete,
  nestedIn,
  onAddBelow,
}: StepRowProps) {
  const { automations, expanded, setExpanded, failureOpen, showFailure, errors, openSettings } =
    useStepEditor();
  const localSwitchOff = localProcessSwitchOff(useLocalProcessSwitches());
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: draft.uid,
  });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : undefined,
  };

  const step = fromStepDraft(draft);
  const open = expanded.has(draft.uid);
  const Icon = stepKindIcon(step.kind);
  const notes = stepNotes(step);
  const blocked = !isKnownStepKind(step.kind)
    ? UNKNOWN_STEP_REASON
    : step.kind === "run-local-process" && localSwitchOff !== null
      ? localSwitchOff === "experimental"
        ? LOCAL_PROCESS_STEP_REASON
        : LOCAL_PROGRAMS_STEP_REASON
      : null;
  // A wait for the user never goes on by itself, so nothing of it can fail softly.
  const hasFailure = step.kind !== "wait-for-user";
  const hasPolicy = hasFailure && (step.continueOnError === true || step.retry !== undefined);
  const bodyId = `automation-step-body-${path}`;

  /** Open the row, then focus a field of it. */
  const openAndFocus = (selector: string) => {
    // Render the opened row first: the field is in it.
    flushSync(() => setExpanded(draft.uid, true));
    document.querySelector<HTMLElement>(selector)?.focus();
  };

  const handleGripKey = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    e.preventDefault();
    onMove(e.key === "ArrowUp" ? -1 : 1, true);
  };

  return (
    <li
      ref={setNodeRef}
      style={style}
      className="automation-step"
      data-step-uid={draft.uid}
      data-testid={`automation-editor-step-${path}`}
    >
      <div className="automation-step__header">
        <button
          type="button"
          className="automation-step__grip"
          data-testid={`automation-editor-step-grip-${path}`}
          {...attributes}
          {...listeners}
          onKeyDown={handleGripKey}
          aria-label={`Reorder step ${index + 1}`}
        >
          <GripVertical size={14} />
        </button>
        <span className="automation-step__index">{index + 1}</span>
        <button
          type="button"
          className="automation-step__toggle"
          aria-expanded={open}
          aria-controls={open ? bodyId : undefined}
          onClick={() => setExpanded(draft.uid, !open)}
          data-testid={`automation-editor-step-toggle-${path}`}
        >
          <ChevronRight
            size={14}
            className={
              open
                ? "automation-step__chevron automation-step__chevron--open"
                : "automation-step__chevron"
            }
            aria-hidden="true"
          />
          <Icon size={14} />
          <span
            className="automation-step__kind"
            data-testid={`automation-editor-step-kind-${path}`}
            data-kind={step.kind}
          >
            {stepKindLabel(step.kind)}
          </span>
          <span
            className="automation-step__summary"
            data-testid={`automation-editor-step-summary-${path}`}
          >
            {!open && (
              <span className="automation-step__summary-value">
                {stepSummary(step, automations)}
              </span>
            )}
            {!open && notes.length > 0 && (
              <span className="automation-step__notes">{notes.join(" · ")}</span>
            )}
            {blocked !== null && (
              <span className="automation-step__blocked">
                <TriangleAlert size={12} aria-hidden="true" /> Will not run
              </span>
            )}
          </span>
        </button>
        <StepRowMenu
          path={path}
          index={index}
          total={total}
          nestedIn={nestedIn}
          onAddBelow={onAddBelow}
          onFailure={
            hasFailure
              ? () => {
                  flushSync(() => showFailure(draft.uid));
                  openAndFocus(`#automation-step-on-failure-${path}`);
                }
              : undefined
          }
          onSpeed={
            step.kind === "type-keys" &&
            ((draft.keys?.length ?? 0) > 1 || (step.timing ?? "recorded") !== "recorded")
              ? () => openAndFocus(`#automation-step-speed-${path}`)
              : undefined
          }
          onMove={(direction) => onMove(direction, false)}
          onDuplicate={onDuplicate}
          onDelete={onDelete}
        />
      </div>
      {open && (
        <div
          id={bodyId}
          className="automation-step__body"
          data-testid={`automation-editor-step-body-${path}`}
        >
          {blocked !== null && (
            <div
              className="automation-step__note automation-step__note--warning"
              data-testid={`automation-editor-step-blocked-${path}`}
            >
              {blocked}{" "}
              {(blocked === LOCAL_PROCESS_STEP_REASON ||
                blocked === LOCAL_PROGRAMS_STEP_REASON) && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() =>
                    openSettings(blocked === LOCAL_PROCESS_STEP_REASON ? "general" : "security")
                  }
                  data-testid={`automation-editor-step-open-settings-${path}`}
                >
                  Open settings
                </Button>
              )}
            </div>
          )}
          <StepFields draft={draft} path={path} stepNumber={index + 1} onChange={onChange} />
          {(hasPolicy || (hasFailure && failureOpen.has(draft.uid))) && (
            <FailureOptions
              path={path}
              step={draft.step}
              errors={{
                count: errors[`steps.${draft.uid}.retry.count`],
                delayMs: errors[`steps.${draft.uid}.retry.delayMs`],
              }}
              onChange={(next) => onChange({ ...draft, step: next })}
            />
          )}
        </div>
      )}
    </li>
  );
}
