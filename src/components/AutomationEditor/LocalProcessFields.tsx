import { Plus, Trash2 } from "lucide-react";
import { Button, Field, Input } from "@/components/ui";
import type { AutomationStep } from "@/types/generated/AutomationStep";

/** Props of {@link LocalProcessFields}. */
export interface LocalProcessFieldsProps {
  step: Extract<AutomationStep, { kind: "run-local-process" }>;
  path: string;
  stepNumber: number;
  error?: string;
  onChange: (step: AutomationStep) => void;
}

/**
 * A local program and its arguments, one field per argument (#1857): an argument
 * with spaces stays one literal argument. Each is passed to the program as its
 * own argv entry with no shell involved, so nothing here is ever re-split.
 */
export function LocalProcessFields({
  step,
  path,
  stepNumber,
  error,
  onChange,
}: LocalProcessFieldsProps) {
  const { args } = step;
  const setArgs = (next: string[]) => onChange({ ...step, args: next });

  return (
    <>
      <Field label="Program" htmlFor={`automation-step-program-${path}`} error={error}>
        <Input
          error={Boolean(error)}
          id={`automation-step-program-${path}`}
          value={step.program}
          placeholder="e.g. /usr/bin/notify-send"
          onChange={(e) => onChange({ ...step, program: e.target.value })}
          data-testid={`automation-editor-step-program-${path}`}
        />
      </Field>
      <Field label="Arguments" htmlFor={`automation-step-arg-${path}-0`}>
        <div className="automation-step__args" data-testid={`automation-editor-step-args-${path}`}>
          {args.length === 0 && <span className="automation-step__args-empty">No arguments.</span>}
          {args.map((arg, i) => (
            <div className="automation-step__arg-row" key={i}>
              <Input
                id={`automation-step-arg-${path}-${i}`}
                value={arg}
                placeholder={`argument ${i + 1}`}
                onChange={(e) => setArgs(args.map((a, j) => (j === i ? e.target.value : a)))}
                aria-label={`Argument ${i + 1} for step ${stepNumber}`}
                data-testid={`automation-editor-step-arg-${path}-${i}`}
              />
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                aria-label={`Remove argument ${i + 1}`}
                icon={<Trash2 size={12} />}
                onClick={() => setArgs(args.filter((_, j) => j !== i))}
                data-testid={`automation-editor-step-arg-remove-${path}-${i}`}
              />
            </div>
          ))}
          <Button
            variant="secondary"
            size="sm"
            icon={<Plus size={12} />}
            onClick={() => setArgs([...args, ""])}
            data-testid={`automation-editor-step-arg-add-${path}`}
          >
            Add argument
          </Button>
        </div>
      </Field>
    </>
  );
}
