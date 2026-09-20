import { Plus, Trash2 } from "lucide-react";
import { Button, Input, Field, Select, Toggle } from "@/components/ui";
import type { WorkflowParameter, WorkflowParameterType } from "@/types/workflow";
import "./WorkflowParametersEditor.css";

/** The parameter value types, in the order shown in the type picker. */
const PARAMETER_TYPES: readonly WorkflowParameterType[] = [
  "string",
  "number",
  "boolean",
  "enum",
] as const;

export interface WorkflowParametersEditorProps {
  /** The parameters being edited. */
  parameters: WorkflowParameter[];
  /** Called with the next parameter list on any edit. */
  onChange: (parameters: WorkflowParameter[]) => void;
}

/** Split a comma-separated enum-options string into a trimmed, non-empty list. */
function parseOptions(raw: string): string[] {
  return raw
    .split(",")
    .map((o) => o.trim())
    .filter((o) => o.length > 0);
}

/**
 * Editor for a workflow's declared parameters (PROD-0040): a list of rows, each
 * defining a parameter's name, optional label, value type, default, whether it
 * is required, and — for an `enum` — its options. Parameter references of the
 * form `${name}` in step text fields are substituted with the value collected at
 * run time. Composed entirely from the shared UI primitives, mirroring
 * {@link "./WorkflowTriggersEditor".WorkflowTriggersEditor}.
 */
export function WorkflowParametersEditor({ parameters, onChange }: WorkflowParametersEditorProps) {
  const updateParam = (index: number, patch: Partial<WorkflowParameter>) => {
    onChange(parameters.map((p, i) => (i === index ? { ...p, ...patch } : p)));
  };

  const changeType = (index: number, type: WorkflowParameterType) => {
    const current = parameters[index];
    // Reset the default and options that no longer apply to the new type so the
    // stored parameter never carries a stale value of the wrong shape.
    const next: WorkflowParameter = { ...current, type, default: undefined };
    if (type === "enum") {
      next.options = current.options ?? [];
    } else {
      delete next.options;
    }
    onChange(parameters.map((p, i) => (i === index ? next : p)));
  };

  const setDefault = (index: number, raw: string) => {
    const param = parameters[index];
    if (param.type === "number") {
      const trimmed = raw.trim();
      const value = trimmed === "" ? undefined : Number(trimmed);
      updateParam(index, {
        default: value !== undefined && Number.isNaN(value) ? undefined : value,
      });
      return;
    }
    updateParam(index, { default: raw === "" ? undefined : raw });
  };

  const addParam = () => {
    onChange([...parameters, { name: "", type: "string" }]);
  };

  const removeParam = (index: number) => {
    onChange(parameters.filter((_, i) => i !== index));
  };

  return (
    <div className="workflow-params" data-testid="workflow-params">
      {parameters.length === 0 ? (
        <p className="workflow-params__empty" role="status" data-testid="workflow-params-empty">
          No parameters. Add one to prompt for a value before the workflow runs and reference it as{" "}
          <code>{"${name}"}</code> in a step.
        </p>
      ) : (
        <ul className="workflow-params__list" data-testid="workflow-params-list">
          {parameters.map((param, index) => (
            <li
              key={index}
              className="workflow-params__row"
              data-testid={`workflow-param-${index}`}
            >
              <div className="workflow-params__grid">
                <Field label="Name" htmlFor={`workflow-param-name-${index}`}>
                  <Input
                    id={`workflow-param-name-${index}`}
                    value={param.name}
                    onChange={(e) => updateParam(index, { name: e.target.value })}
                    placeholder="host"
                    data-testid={`workflow-param-name-${index}`}
                  />
                </Field>
                <Field label="Label (optional)" htmlFor={`workflow-param-label-${index}`}>
                  <Input
                    id={`workflow-param-label-${index}`}
                    value={param.label ?? ""}
                    onChange={(e) =>
                      updateParam(index, {
                        label: e.target.value === "" ? undefined : e.target.value,
                      })
                    }
                    placeholder="Target host"
                    data-testid={`workflow-param-label-${index}`}
                  />
                </Field>
                <Field label="Type" htmlFor={`workflow-param-type-${index}`}>
                  <Select
                    id={`workflow-param-type-${index}`}
                    value={param.type}
                    onChange={(v) => changeType(index, v as WorkflowParameterType)}
                    options={PARAMETER_TYPES.map((t) => ({ value: t, label: t }))}
                    data-testid={`workflow-param-type-${index}`}
                  />
                </Field>
                {param.type === "boolean" ? (
                  <Field label="Default" htmlFor={`workflow-param-default-${index}`}>
                    <Toggle
                      id={`workflow-param-default-${index}`}
                      checked={param.default === true}
                      onCheckedChange={(checked) => updateParam(index, { default: checked })}
                      aria-label="Default value"
                      data-testid={`workflow-param-default-${index}`}
                    />
                  </Field>
                ) : (
                  <Field label="Default (optional)" htmlFor={`workflow-param-default-${index}`}>
                    <Input
                      id={`workflow-param-default-${index}`}
                      type={param.type === "number" ? "number" : "text"}
                      value={param.default === undefined ? "" : String(param.default)}
                      onChange={(e) => setDefault(index, e.target.value)}
                      placeholder="default value"
                      data-testid={`workflow-param-default-${index}`}
                    />
                  </Field>
                )}
              </div>
              {param.type === "enum" && (
                <Field
                  label="Options (comma-separated)"
                  htmlFor={`workflow-param-options-${index}`}
                >
                  <Input
                    id={`workflow-param-options-${index}`}
                    value={(param.options ?? []).join(", ")}
                    onChange={(e) => updateParam(index, { options: parseOptions(e.target.value) })}
                    placeholder="dev, staging, prod"
                    data-testid={`workflow-param-options-${index}`}
                  />
                </Field>
              )}
              <div className="workflow-params__row-footer">
                <label className="workflow-params__required">
                  <Toggle
                    checked={param.required === true}
                    onCheckedChange={(checked) =>
                      updateParam(index, { required: checked ? true : undefined })
                    }
                    aria-label="Required"
                    data-testid={`workflow-param-required-${index}`}
                  />
                  Required
                </label>
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<Trash2 size={14} />}
                  onClick={() => removeParam(index)}
                  aria-label={`Remove parameter ${index + 1}`}
                  data-testid={`workflow-param-remove-${index}`}
                >
                  Remove
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <Button
        variant="secondary"
        size="sm"
        icon={<Plus size={14} />}
        onClick={addParam}
        data-testid="workflow-params-add"
      >
        Add parameter…
      </Button>
    </div>
  );
}
