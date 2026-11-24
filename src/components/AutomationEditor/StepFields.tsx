import { Field, Input, NumberInput, Select, Textarea, Toggle } from "@/components/ui";
import { MAX_STEP_DELAY_MS } from "@/services/macroPlayback";
import { WAIT_FOR_OUTPUT_DEFAULT_TIMEOUT_MS } from "@/services/workflowRunner";
import type { AutomationStep } from "@/types/generated/AutomationStep";
import type { StepDraft } from "./automationDraft";
import { ConditionalFields, LoopFields } from "./ContainerFields";
import { LocalProcessFields } from "./LocalProcessFields";
import { ScriptSourceField } from "./ScriptSourceField";
import { SecondsInput } from "./SecondsInput";
import { useStepEditor } from "./stepEditorContext";
import { formatSeconds } from "./stepMeta";
import { TypeKeysFields } from "./TypeKeysFields";

/** Props of {@link StepFields}. */
export interface StepFieldsProps {
  draft: StepDraft;
  /** Path of the step (`0`, `2-then-1`), unique in the editor. */
  path: string;
  /** 1-based number in its list, for accessible names. */
  stepNumber: number;
  onChange: (draft: StepDraft) => void;
}

/** Why a longer delay is not what runs. */
function delayCapHint(ms: number): string | undefined {
  return ms > MAX_STEP_DELAY_MS
    ? `A wait lasts at most ${formatSeconds(MAX_STEP_DELAY_MS)}.`
    : undefined;
}

/** The fields of one step, by kind. */
export function StepFields({ draft, path, stepNumber, onChange }: StepFieldsProps) {
  const { step } = draft;
  const setStep = (next: AutomationStep) => onChange({ ...draft, step: next });
  switch (step.kind) {
    case "type-keys":
      return (
        <TypeKeysFields
          draft={draft}
          step={step}
          path={path}
          stepNumber={stepNumber}
          onChange={onChange}
        />
      );
    case "send-command":
      return (
        <Field label="Command" htmlFor={`automation-step-command-${path}`}>
          <Input
            id={`automation-step-command-${path}`}
            value={step.command}
            placeholder="e.g. sudo -v"
            onChange={(e) => setStep({ ...step, command: e.target.value })}
            data-testid={`automation-editor-step-command-${path}`}
          />
        </Field>
      );
    case "run-script":
      return <RunScriptFields step={step} path={path} stepNumber={stepNumber} onChange={setStep} />;
    case "run-automation":
      return <RunAutomationField step={step} path={path} onChange={setStep} />;
    case "wait": {
      const cap = delayCapHint(step.delayMs);
      return (
        <Field
          label="Wait (seconds)"
          htmlFor={`automation-step-delay-${path}`}
          hint={cap}
          hintVariant="warning"
        >
          <SecondsInput
            id={`automation-step-delay-${path}`}
            valueMs={step.delayMs}
            onChangeMs={(ms) => setStep({ ...step, delayMs: Math.max(0, ms ?? 0) })}
            data-testid={`automation-editor-step-delay-${path}`}
          />
        </Field>
      );
    }
    case "run-local-process":
      return (
        <LocalProcessFields step={step} path={path} stepNumber={stepNumber} onChange={setStep} />
      );
    case "conditional":
      return <ConditionalFields draft={draft} step={step} path={path} onChange={onChange} />;
    case "loop":
      return <LoopFields draft={draft} step={step} path={path} onChange={onChange} />;
    case "wait-for-output":
      return <WaitForOutputFields step={step} path={path} onChange={setStep} />;
    default:
      return (
        <p className="automation-step__note">
          This version of termiHub cannot edit this step. Saving keeps it as it is.
        </p>
      );
  }
}

interface RunScriptFieldsProps {
  step: Extract<AutomationStep, { kind: "run-script" }>;
  path: string;
  stepNumber: number;
  onChange: (step: AutomationStep) => void;
}

/** A script's body, its file and the delay between its lines. */
function RunScriptFields({ step, path, stepNumber, onChange }: RunScriptFieldsProps) {
  // Editing the body detaches any script file (#4310): what the user sees and
  // types is then exactly what runs.
  const withoutFile = () => {
    const { sourcePath: _detached, ...rest } = step;
    return rest;
  };
  return (
    <>
      <Field label="Script" htmlFor={`automation-step-script-${path}`}>
        <Textarea
          id={`automation-step-script-${path}`}
          value={step.script}
          placeholder="One command per line"
          onChange={(e) => onChange({ ...withoutFile(), script: e.target.value })}
          data-testid={`automation-editor-step-script-${path}`}
        />
      </Field>
      <ScriptSourceField
        path={path}
        stepNumber={stepNumber}
        sourcePath={step.sourcePath}
        onPick={(sourcePath, contents) => onChange({ ...step, script: contents, sourcePath })}
        onDetach={() => onChange(withoutFile())}
      />
      <Field
        label="Delay between lines (ms, optional)"
        htmlFor={`automation-step-linedelay-${path}`}
      >
        <NumberInput
          id={`automation-step-linedelay-${path}`}
          value={step.perLineDelayMs ?? ""}
          min={0}
          step={10}
          onValueChange={(v) => {
            const next = { ...step };
            if (v === "") delete next.perLineDelayMs;
            else next.perLineDelayMs = Math.max(0, Math.round(v));
            onChange(next);
          }}
          data-testid={`automation-editor-step-linedelay-${path}`}
        />
      </Field>
    </>
  );
}

interface RunAutomationFieldProps {
  step: Extract<AutomationStep, { kind: "run-automation" }>;
  path: string;
  onChange: (step: AutomationStep) => void;
}

/** Which automation the step runs. A deleted one stays shown as such. */
function RunAutomationField({ step, path, onChange }: RunAutomationFieldProps) {
  const { automations } = useStepEditor();
  const options = automations.map((a) => ({ value: a.id, label: a.name }));
  if (step.automationId && !automations.some((a) => a.id === step.automationId)) {
    options.unshift({ value: step.automationId, label: "Deleted automation" });
  }
  return (
    <Field label="Automation" htmlFor={`automation-step-automation-${path}`}>
      <Select
        id={`automation-step-automation-${path}`}
        value={step.automationId || undefined}
        onChange={(automationId) => onChange({ ...step, automationId })}
        options={options}
        placeholder={options.length > 0 ? "Choose an automation" : "No other automations yet"}
        data-testid={`automation-editor-step-automation-${path}`}
      />
    </Field>
  );
}

interface WaitForOutputFieldsProps {
  step: Extract<AutomationStep, { kind: "wait-for-output" }>;
  path: string;
  onChange: (step: AutomationStep) => void;
}

/**
 * What to wait for, as text or a regular expression, and for how long at most.
 * `${param}` references in the pattern are resolved at run time.
 */
function WaitForOutputFields({ step, path, onChange }: WaitForOutputFieldsProps) {
  return (
    <>
      <Field label="Wait until output matches" htmlFor={`automation-step-wfo-pattern-${path}`}>
        <Input
          id={`automation-step-wfo-pattern-${path}`}
          value={step.pattern}
          placeholder={step.isRegex ? "e.g. login:\\s*$" : "e.g. $ "}
          onChange={(e) => onChange({ ...step, pattern: e.target.value })}
          data-testid={`automation-editor-wfo-pattern-${path}`}
        />
      </Field>
      <div className="automation-step__inline">
        <Field
          label="Regular expression"
          htmlFor={`automation-step-wfo-regex-${path}`}
          layout="checkbox"
        >
          <Toggle
            id={`automation-step-wfo-regex-${path}`}
            checked={step.isRegex ?? false}
            onCheckedChange={(checked) => {
              const next = { ...step };
              if (checked) next.isRegex = true;
              else delete next.isRegex;
              onChange(next);
            }}
            data-testid={`automation-editor-wfo-regex-${path}`}
          />
        </Field>
        <Field label="Give up after (seconds)" htmlFor={`automation-step-wfo-timeout-${path}`}>
          <SecondsInput
            id={`automation-step-wfo-timeout-${path}`}
            valueMs={step.timeoutMs}
            step={1}
            placeholder={String(WAIT_FOR_OUTPUT_DEFAULT_TIMEOUT_MS / 1000)}
            onChangeMs={(ms) => {
              const next = { ...step };
              if (ms === undefined) delete next.timeoutMs;
              else next.timeoutMs = Math.max(0, ms);
              onChange(next);
            }}
            data-testid={`automation-editor-wfo-timeout-${path}`}
          />
        </Field>
      </div>
    </>
  );
}
