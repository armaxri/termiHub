import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button, Input, Field, Select, Toggle, EmptyState } from "@/components/ui";
import type { WorkflowParameter, WorkflowParameterType } from "@/types/workflow";
import "./ParametersEditor.css";

/** The parameter value types, in the order shown in the type picker. */
const PARAMETER_TYPES: readonly WorkflowParameterType[] = [
  "string",
  "number",
  "boolean",
  "enum",
] as const;

export interface ParametersEditorProps {
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
 * Editor for the values an automation asks for when it runs (PROD-0040): a list
 * of rows, each defining a parameter's name, optional label, value type, default,
 * whether it is required, and — for an `enum` — its options. A `${name}`
 * reference in a step's text is replaced by the value given at run time.
 */
export function ParametersEditor({ parameters, onChange }: ParametersEditorProps) {
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
    <div className="automation-params" data-testid="automation-params">
      {parameters.length === 0 ? (
        <EmptyState
          title={
            <>
              Nothing is asked. Add a value to ask for it before each run and use it as{" "}
              <code className="automation-params__code">{"${name}"}</code> in a step.
            </>
          }
          data-testid="automation-params-empty"
        />
      ) : (
        <ul className="automation-params__list" data-testid="automation-params-list">
          {parameters.map((param, index) => (
            <li
              key={index}
              className="automation-params__row"
              data-testid={`automation-param-${index}`}
            >
              <div className="automation-params__grid">
                <Field label="Name" htmlFor={`automation-param-name-${index}`}>
                  <Input
                    id={`automation-param-name-${index}`}
                    value={param.name}
                    onChange={(e) => updateParam(index, { name: e.target.value })}
                    placeholder="host"
                    data-testid={`automation-param-name-${index}`}
                  />
                </Field>
                <Field label="Label (optional)" htmlFor={`automation-param-label-${index}`}>
                  <Input
                    id={`automation-param-label-${index}`}
                    value={param.label ?? ""}
                    onChange={(e) =>
                      updateParam(index, {
                        label: e.target.value === "" ? undefined : e.target.value,
                      })
                    }
                    placeholder="Target host"
                    data-testid={`automation-param-label-${index}`}
                  />
                </Field>
                <Field label="Type" htmlFor={`automation-param-type-${index}`}>
                  <Select
                    id={`automation-param-type-${index}`}
                    value={param.type}
                    onChange={(v) => changeType(index, v as WorkflowParameterType)}
                    options={PARAMETER_TYPES.map((t) => ({ value: t, label: t }))}
                    data-testid={`automation-param-type-${index}`}
                  />
                </Field>
                {param.type === "boolean" ? (
                  <Field label="Default" htmlFor={`automation-param-default-${index}`}>
                    <Toggle
                      id={`automation-param-default-${index}`}
                      checked={param.default === true}
                      onCheckedChange={(checked) => updateParam(index, { default: checked })}
                      aria-label="Default value"
                      data-testid={`automation-param-default-${index}`}
                    />
                  </Field>
                ) : (
                  <Field label="Default (optional)" htmlFor={`automation-param-default-${index}`}>
                    <Input
                      id={`automation-param-default-${index}`}
                      type={param.type === "number" ? "number" : "text"}
                      value={param.default === undefined ? "" : String(param.default)}
                      onChange={(e) => setDefault(index, e.target.value)}
                      placeholder="default value"
                      data-testid={`automation-param-default-${index}`}
                    />
                  </Field>
                )}
              </div>
              {param.type === "enum" && (
                <Field
                  label="Options (comma-separated)"
                  htmlFor={`automation-param-options-${index}`}
                >
                  <OptionsInput
                    id={`automation-param-options-${index}`}
                    options={param.options ?? []}
                    onChange={(options) => updateParam(index, { options })}
                  />
                </Field>
              )}
              <div className="automation-params__row-footer">
                <label className="automation-params__required">
                  <Toggle
                    checked={param.required === true}
                    onCheckedChange={(checked) =>
                      updateParam(index, { required: checked ? true : undefined })
                    }
                    aria-label="Required"
                    data-testid={`automation-param-required-${index}`}
                  />
                  Required
                </label>
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<Trash2 size={14} />}
                  onClick={() => removeParam(index)}
                  aria-label={`Remove value ${index + 1}`}
                  data-testid={`automation-param-remove-${index}`}
                >
                  Remove
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <div>
        <Button
          variant="secondary"
          size="sm"
          icon={<Plus size={14} />}
          onClick={addParam}
          data-testid="automation-params-add"
        >
          Add value
        </Button>
      </div>
    </div>
  );
}

interface OptionsInputProps {
  id: string;
  options: string[];
  onChange: (options: string[]) => void;
}

/**
 * The options of an `enum` value as comma-separated text. The text is kept as
 * typed: reading it back from the parsed list would eat each comma.
 */
function OptionsInput({ id, options, onChange }: OptionsInputProps) {
  const [text, setText] = useState(options.join(", "));
  return (
    <Input
      id={id}
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        onChange(parseOptions(e.target.value));
      }}
      placeholder="dev, staging, prod"
      data-testid={id}
    />
  );
}
