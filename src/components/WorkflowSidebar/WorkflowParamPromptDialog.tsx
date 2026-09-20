import { useEffect, useMemo, useState } from "react";
import { Modal, Button, Input, Field, Select, Toggle } from "@/components/ui";
import { useAppStore } from "@/store/appStore";
import type { WorkflowParameter } from "@/types/workflow";
import type { WorkflowParamValues } from "@/services/workflowRunner";
import "./WorkflowParamPromptDialog.css";

/** A single collected value, typed by the parameter it belongs to. */
type ParamValue = string | number | boolean;

/** The initial value for a parameter: its `default`, else a type-appropriate zero. */
function initialValue(param: WorkflowParameter): ParamValue {
  if (param.default !== undefined) return param.default;
  switch (param.type) {
    case "boolean":
      return false;
    case "number":
      return "";
    case "enum":
      return param.options?.[0] ?? "";
    case "string":
      return "";
  }
}

/** Build the initial value map for a set of parameters. */
function initialValues(parameters: WorkflowParameter[]): Record<string, ParamValue> {
  const values: Record<string, ParamValue> = {};
  for (const param of parameters) values[param.name] = initialValue(param);
  return values;
}

/** Whether a required parameter's current value satisfies the requirement. */
function isMissing(param: WorkflowParameter, value: ParamValue): boolean {
  if (!param.required) return false;
  if (param.type === "boolean") return false; // false is a valid boolean value
  if (param.type === "number") return value === "" || Number.isNaN(Number(value));
  return typeof value === "string" && value.trim() === "";
}

/**
 * Run-time prompt collecting a workflow's declared parameter values (PROD-0040).
 *
 * Shown when a run starts a workflow that declares parameters. Each field is
 * pre-filled from the parameter's `default`; on submit the collected values are
 * handed back to the run so `${name}` references in the steps resolve. Cancelling
 * aborts the run before it starts. Mounted globally (like the local-process
 * dialog) so it works no matter how the workflow was launched (sidebar, palette,
 * hotkey). Composed entirely from the shared UI primitives.
 */
export function WorkflowParamPromptDialog() {
  const prompt = useAppStore((s) => s.workflowParamPrompt);
  const resolve = useAppStore((s) => s.resolveWorkflowParamPrompt);

  const open = prompt !== null;
  const [values, setValues] = useState<Record<string, ParamValue>>({});

  // Re-seed the working values each time a fresh prompt opens so a prior run's
  // edits never leak in and defaults are always applied.
  useEffect(() => {
    if (prompt) setValues(initialValues(prompt.parameters));
  }, [prompt]);

  const canRun = useMemo(() => {
    if (!prompt) return false;
    return prompt.parameters.every((p) => !isMissing(p, values[p.name] ?? initialValue(p)));
  }, [prompt, values]);

  const setValue = (name: string, value: ParamValue) => {
    setValues((prev) => ({ ...prev, [name]: value }));
  };

  const handleRun = () => {
    if (!prompt || !canRun) return;
    const collected: WorkflowParamValues = {};
    for (const param of prompt.parameters) {
      const raw = values[param.name] ?? initialValue(param);
      if (param.type === "number") {
        const n = Number(raw);
        collected[param.name] = Number.isFinite(n) ? n : 0;
      } else if (param.type === "boolean") {
        collected[param.name] = raw === true;
      } else {
        collected[param.name] = typeof raw === "string" ? raw : String(raw);
      }
    }
    resolve(collected);
  };

  return (
    <Modal
      open={open}
      onOpenChange={(isOpen) => {
        if (!isOpen) resolve(null);
      }}
      title={prompt ? `Run "${prompt.workflowName}"` : "Run workflow"}
      description="Provide values for this workflow's parameters"
      data-testid="workflow-param-prompt"
      footer={
        <>
          <Button
            variant="secondary"
            onClick={() => resolve(null)}
            data-testid="workflow-param-prompt-cancel"
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={handleRun}
            disabled={!canRun}
            data-testid="workflow-param-prompt-run"
          >
            Run
          </Button>
        </>
      }
    >
      {prompt && (
        <div className="workflow-param-prompt">
          {prompt.parameters.map((param) => {
            const value = values[param.name] ?? initialValue(param);
            const label = `${param.label ?? param.name}${param.required ? " *" : ""}`;
            const fieldId = `workflow-param-value-${param.name}`;
            if (param.type === "boolean") {
              return (
                <Field key={param.name} label={label} htmlFor={fieldId}>
                  <Toggle
                    id={fieldId}
                    checked={value === true}
                    onCheckedChange={(checked) => setValue(param.name, checked)}
                    aria-label={label}
                    data-testid={fieldId}
                  />
                </Field>
              );
            }
            if (param.type === "enum") {
              return (
                <Field key={param.name} label={label} htmlFor={fieldId}>
                  <Select
                    id={fieldId}
                    value={typeof value === "string" ? value : ""}
                    onChange={(v) => setValue(param.name, v)}
                    options={(param.options ?? []).map((o) => ({ value: o, label: o }))}
                    placeholder="Select…"
                    data-testid={fieldId}
                  />
                </Field>
              );
            }
            return (
              <Field key={param.name} label={label} htmlFor={fieldId}>
                <Input
                  id={fieldId}
                  type={param.type === "number" ? "number" : "text"}
                  value={value === undefined ? "" : String(value)}
                  onChange={(e) => setValue(param.name, e.target.value)}
                  data-testid={fieldId}
                />
              </Field>
            );
          })}
        </div>
      )}
    </Modal>
  );
}
