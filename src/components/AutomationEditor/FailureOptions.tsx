import { Field, NumberInput, Select, Toggle } from "@/components/ui";
import { MAX_RETRY_DELAY_MS, MAX_STEP_RETRIES } from "@/services/workflowRunner";
import type { AutomationStep } from "@/types/generated/AutomationStep";
import type { WorkflowRetryBackoff } from "@/types/workflow";
import { SecondsInput } from "./SecondsInput";
import { DEFAULT_STEP_RETRY } from "./stepPolicySchema";

/** Props of {@link FailureOptions}. */
export interface FailureOptionsProps {
  /** Path of the step (`0`, `2-then-1`). */
  path: string;
  step: AutomationStep;
  /** The retry errors the user should see now. */
  errors: { count?: string; delayMs?: string };
  onChange: (step: AutomationStep) => void;
}

const ON_FAILURE_OPTIONS = [
  { value: "stop", label: "Stop the automation" },
  { value: "continue", label: "Continue with the next step" },
];

const BACKOFF_OPTIONS: { value: WorkflowRetryBackoff; label: string }[] = [
  { value: "fixed", label: "Same wait each time" },
  { value: "exponential", label: "Double the wait each time" },
];

/**
 * "If this step fails" (PROD-045): stop or continue, after an optional bounded
 * number of retries. Turning an option off removes its key, so a step without
 * failure options is stored as if it never had any.
 */
export function FailureOptions({ path, step, errors, onChange }: FailureOptionsProps) {
  const { retry } = step;

  const setOnFailure = (value: string) => {
    const next = { ...step };
    if (value === "continue") next.continueOnError = true;
    else delete next.continueOnError;
    onChange(next);
  };

  const setRetry = (enabled: boolean) => {
    const next = { ...step };
    if (enabled) next.retry = { ...DEFAULT_STEP_RETRY };
    else delete next.retry;
    onChange(next);
  };

  return (
    <div className="automation-step__policy" data-testid={`automation-editor-step-policy-${path}`}>
      <div className="automation-step__policy-row">
        <Field label="If this step fails" htmlFor={`automation-step-on-failure-${path}`}>
          <Select
            id={`automation-step-on-failure-${path}`}
            value={step.continueOnError ? "continue" : "stop"}
            onChange={setOnFailure}
            options={ON_FAILURE_OPTIONS}
            data-testid={`automation-editor-step-on-failure-${path}`}
          />
        </Field>
        <Field label="Retry first" htmlFor={`automation-step-retry-${path}`} layout="checkbox">
          <Toggle
            id={`automation-step-retry-${path}`}
            checked={retry !== undefined}
            onCheckedChange={setRetry}
            data-testid={`automation-editor-step-retry-${path}`}
          />
        </Field>
      </div>
      {retry && (
        <div className="automation-step__retry">
          <Field
            label={`Retries (1–${MAX_STEP_RETRIES})`}
            htmlFor={`automation-step-retry-count-${path}`}
            error={errors.count}
          >
            <NumberInput
              id={`automation-step-retry-count-${path}`}
              value={retry.count}
              min={1}
              max={MAX_STEP_RETRIES}
              step={1}
              error={Boolean(errors.count)}
              onValueChange={(v) =>
                onChange({ ...step, retry: { ...retry, count: v === "" ? 0 : v } })
              }
              data-testid={`automation-editor-step-retry-count-${path}`}
            />
          </Field>
          <Field
            label="Wait before each retry (s)"
            htmlFor={`automation-step-retry-delay-${path}`}
            error={errors.delayMs}
          >
            <SecondsInput
              id={`automation-step-retry-delay-${path}`}
              valueMs={retry.delayMs}
              max={MAX_RETRY_DELAY_MS / 1000}
              error={Boolean(errors.delayMs)}
              onChangeMs={(delayMs) => {
                const next = { ...retry };
                if (delayMs === undefined) delete next.delayMs;
                else next.delayMs = delayMs;
                onChange({ ...step, retry: next });
              }}
              data-testid={`automation-editor-step-retry-delay-${path}`}
            />
          </Field>
          <Field label="Between retries" htmlFor={`automation-step-retry-backoff-${path}`}>
            <Select
              id={`automation-step-retry-backoff-${path}`}
              value={retry.backoff ?? "fixed"}
              onChange={(value) =>
                onChange({ ...step, retry: { ...retry, backoff: value as WorkflowRetryBackoff } })
              }
              options={BACKOFF_OPTIONS}
              data-testid={`automation-editor-step-retry-backoff-${path}`}
            />
          </Field>
        </div>
      )}
    </div>
  );
}
