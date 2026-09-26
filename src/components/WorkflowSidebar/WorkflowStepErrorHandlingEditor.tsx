import { Field, NumberInput, Select, Toggle } from "@/components/ui";
import { MAX_RETRY_DELAY_MS, MAX_STEP_RETRIES } from "@/services/workflowRunner";
import type { WorkflowRetryBackoff, WorkflowStep } from "@/types/workflow";
import { DEFAULT_STEP_RETRY, stepPolicyErrors } from "./workflowStepPolicySchema";

/** Props for {@link WorkflowStepErrorHandlingEditor}. */
export interface WorkflowStepErrorHandlingEditorProps {
  /** Unique id/testid suffix for this step's fields (e.g. `"0"` or `"0-then-1"`). */
  fieldId: string;
  /** The step whose policy is edited. */
  step: WorkflowStep;
  /** Called with the step carrying its updated policy. */
  onChange: (step: WorkflowStep) => void;
}

const BACKOFF_OPTIONS: { value: WorkflowRetryBackoff; label: string }[] = [
  { value: "fixed", label: "Fixed delay" },
  { value: "exponential", label: "Exponential (doubles each retry)" },
];

/**
 * The "On failure" controls shared by every step kind (PROD-045): a
 * continue-on-error toggle and an opt-in bounded retry policy (retries, delay,
 * backoff). Turning an option off removes its key from the step entirely, so a
 * step that uses no error handling saves exactly as it did before the feature.
 */
export function WorkflowStepErrorHandlingEditor({
  fieldId,
  step,
  onChange,
}: WorkflowStepErrorHandlingEditorProps) {
  const errors = stepPolicyErrors(step);
  const retry = step.retry;

  const setContinue = (checked: boolean) => {
    const next = { ...step };
    if (checked) next.continueOnError = true;
    else delete next.continueOnError;
    onChange(next);
  };

  const setRetryEnabled = (checked: boolean) => {
    const next = { ...step };
    if (checked) next.retry = { ...DEFAULT_STEP_RETRY };
    else delete next.retry;
    onChange(next);
  };

  return (
    <div className="workflow-step__policy" data-testid={`workflow-editor-step-policy-${fieldId}`}>
      <Field label="Continue on error" htmlFor={`workflow-step-continue-${fieldId}`}>
        <Toggle
          id={`workflow-step-continue-${fieldId}`}
          checked={step.continueOnError ?? false}
          onCheckedChange={setContinue}
          aria-label={`Continue the workflow when step ${fieldId} fails`}
          data-testid={`workflow-editor-step-continue-${fieldId}`}
        />
      </Field>
      <Field label="Retry on failure" htmlFor={`workflow-step-retry-${fieldId}`}>
        <Toggle
          id={`workflow-step-retry-${fieldId}`}
          checked={retry !== undefined}
          onCheckedChange={setRetryEnabled}
          aria-label={`Retry step ${fieldId} when it fails`}
          data-testid={`workflow-editor-step-retry-${fieldId}`}
        />
      </Field>
      {retry && (
        <div className="workflow-step__retry">
          <Field
            label={`Retries (1–${MAX_STEP_RETRIES})`}
            htmlFor={`workflow-step-retry-count-${fieldId}`}
            error={errors.count ?? errors.other}
          >
            <NumberInput
              id={`workflow-step-retry-count-${fieldId}`}
              value={retry.count}
              min={1}
              max={MAX_STEP_RETRIES}
              step={1}
              onValueChange={(v) =>
                onChange({ ...step, retry: { ...retry, count: v === "" ? 0 : v } })
              }
              data-testid={`workflow-editor-step-retry-count-${fieldId}`}
            />
          </Field>
          <Field
            label="Retry delay (ms)"
            htmlFor={`workflow-step-retry-delay-${fieldId}`}
            error={errors.delayMs}
          >
            <NumberInput
              id={`workflow-step-retry-delay-${fieldId}`}
              value={retry.delayMs ?? ""}
              min={0}
              max={MAX_RETRY_DELAY_MS}
              step={100}
              onValueChange={(v) =>
                onChange({ ...step, retry: { ...retry, delayMs: v === "" ? undefined : v } })
              }
              data-testid={`workflow-editor-step-retry-delay-${fieldId}`}
            />
          </Field>
          <Field label="Backoff" htmlFor={`workflow-step-retry-backoff-${fieldId}`}>
            <Select
              value={retry.backoff ?? "fixed"}
              onChange={(value) =>
                onChange({
                  ...step,
                  retry: { ...retry, backoff: value as WorkflowRetryBackoff },
                })
              }
              options={BACKOFF_OPTIONS}
              aria-label={`Retry backoff for step ${fieldId}`}
              data-testid={`workflow-editor-step-retry-backoff-${fieldId}`}
            />
          </Field>
        </div>
      )}
    </div>
  );
}
