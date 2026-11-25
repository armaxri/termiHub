import { Button, Field, Input, NumberInput, Select } from "@/components/ui";
import type { AutomationStep } from "@/types/generated/AutomationStep";
import type { WorkflowCondition } from "@/types/workflow";
import type { StepDraft, StepListName } from "./automationDraft";
import { useStepEditor } from "./stepEditorContext";
import { conditionOpLabel, WORKFLOW_CONDITION_OPS } from "./stepMeta";

/** How a step refers to a value the run asks for. */
const reference = (name: string): string => "${" + name + "}";

interface ConditionFieldsProps {
  path: string;
  condition: WorkflowCondition;
  error?: string;
  onChange: (condition: WorkflowCondition) => void;
}

/**
 * The `left` / operator / `right` comparison (PROD-0044) of a condition step and
 * of a loop's while-condition. `${param}` references (and `${iteration}` inside
 * a loop) are resolved at run time.
 */
function ConditionFields({ path, condition, error, onChange }: ConditionFieldsProps) {
  const { valueNames } = useStepEditor();
  // Inside a loop its count is one more; a while-condition is always inside one.
  const names =
    path.includes("body") || path.endsWith("-loop") ? [...valueNames, "iteration"] : valueNames;
  return (
    <>
      <div className="automation-step__condition">
        <Field label="If" htmlFor={`automation-step-cond-left-${path}`} error={error}>
          <Input
            error={Boolean(error)}
            id={`automation-step-cond-left-${path}`}
            value={condition.left}
            placeholder="e.g. ${env}"
            onChange={(e) => onChange({ ...condition, left: e.target.value })}
            data-testid={`automation-editor-cond-left-${path}`}
          />
        </Field>
        <Field label="Operator" htmlFor={`automation-step-cond-op-${path}`}>
          <Select
            id={`automation-step-cond-op-${path}`}
            value={condition.op}
            onChange={(value) => onChange({ ...condition, op: value as WorkflowCondition["op"] })}
            options={WORKFLOW_CONDITION_OPS.map((op) => ({
              value: op,
              label: conditionOpLabel(op),
            }))}
            data-testid={`automation-editor-cond-op-${path}`}
          />
        </Field>
        <Field label="Value" htmlFor={`automation-step-cond-right-${path}`}>
          <Input
            id={`automation-step-cond-right-${path}`}
            value={condition.right}
            placeholder="e.g. prod"
            onChange={(e) => onChange({ ...condition, right: e.target.value })}
            data-testid={`automation-editor-cond-right-${path}`}
          />
        </Field>
      </div>
      {names.length > 0 ? (
        <p className="automation-step__note" data-testid={`automation-editor-cond-values-${path}`}>
          Values you can use:{" "}
          {names.map((name) => (
            <Button
              key={name}
              variant="secondary"
              size="xs"
              aria-label={`Insert the value ${name}`}
              onClick={() =>
                onChange({ ...condition, left: `${condition.left}${reference(name)}` })
              }
            >
              {reference(name)}
            </Button>
          ))}
        </p>
      ) : null}
    </>
  );
}

interface NestedListProps {
  draft: StepDraft;
  path: string;
  list: StepListName;
  label: string;
  onChange: (draft: StepDraft) => void;
}

/** One nested step list of a container step. */
function NestedList({ draft, path, list, label, onChange }: NestedListProps) {
  const { renderStepList } = useStepEditor();
  return renderStepList({
    nested: { parent: path, list, label },
    steps: draft.lists?.[list] ?? [],
    onChange: (steps) => onChange({ ...draft, lists: { ...draft.lists, [list]: steps } }),
  });
}

/** Props of {@link ConditionalFields}. */
export interface ConditionalFieldsProps {
  draft: StepDraft;
  step: Extract<AutomationStep, { kind: "conditional" }>;
  path: string;
  /** What is wrong with what it compares. */
  error?: string;
  onChange: (draft: StepDraft) => void;
}

/** A condition and the steps of its two branches (PROD-0044). */
export function ConditionalFields({ draft, step, path, error, onChange }: ConditionalFieldsProps) {
  return (
    <div
      className="automation-step__container"
      data-testid={`automation-editor-conditional-${path}`}
    >
      <ConditionFields
        path={path}
        condition={step.condition}
        error={error}
        onChange={(condition) => onChange({ ...draft, step: { ...step, condition } })}
      />
      <NestedList draft={draft} path={path} list="then" label="Then" onChange={onChange} />
      <NestedList
        draft={draft}
        path={path}
        list="else"
        label="Otherwise (optional)"
        onChange={onChange}
      />
    </div>
  );
}

/** Props of {@link LoopFields}. */
export interface LoopFieldsProps {
  draft: StepDraft;
  step: Extract<AutomationStep, { kind: "loop" }>;
  path: string;
  /** What is wrong with what it compares. */
  error?: string;
  onChange: (draft: StepDraft) => void;
}

/**
 * How often a loop repeats, and the steps it repeats (PROD-044). The runner caps
 * the number of iterations.
 */
export function LoopFields({ draft, step, path, error, onChange }: LoopFieldsProps) {
  const mode = step.loop;
  const setMode = (loop: typeof mode) => onChange({ ...draft, step: { ...step, loop } });
  return (
    <div className="automation-step__container" data-testid={`automation-editor-loop-${path}`}>
      <div className="automation-step__condition">
        <Field label="Repeat" htmlFor={`automation-step-loop-mode-${path}`}>
          <Select
            id={`automation-step-loop-mode-${path}`}
            value={mode.kind}
            onChange={(value) => {
              if (value === mode.kind) return;
              setMode(
                value === "while"
                  ? { kind: "while", condition: { left: "${iteration}", op: "lt", right: "3" } }
                  : { kind: "count", count: 3 }
              );
            }}
            options={[
              { value: "count", label: "a fixed number of times" },
              { value: "while", label: "while a condition holds" },
            ]}
            data-testid={`automation-editor-loop-mode-${path}`}
          />
        </Field>
        {mode.kind === "count" && (
          <Field label="Times" htmlFor={`automation-step-loop-count-${path}`}>
            <NumberInput
              id={`automation-step-loop-count-${path}`}
              value={mode.count}
              min={0}
              step={1}
              onValueChange={(v) =>
                setMode({ kind: "count", count: v === "" ? 0 : Math.max(0, Math.floor(v)) })
              }
              data-testid={`automation-editor-loop-count-${path}`}
            />
          </Field>
        )}
      </div>
      {mode.kind === "while" && (
        <ConditionFields
          path={`${path}-loop`}
          condition={mode.condition}
          error={error}
          onChange={(condition) => setMode({ kind: "while", condition })}
        />
      )}
      <NestedList draft={draft} path={path} list="body" label="Do" onChange={onChange} />
    </div>
  );
}
