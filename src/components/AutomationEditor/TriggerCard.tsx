import { Trash2 } from "lucide-react";
import { Button, Field, Input } from "@/components/ui";
import type { SavedConnection } from "@/types/connection";
import type { AutomationTrigger } from "@/types/generated/AutomationTrigger";
import { OnDisconnectTriggerDetail } from "./OnDisconnectTriggerDetail";
import { OnOutputMatchTriggerDetail, type OutputMatchErrors } from "./OnOutputMatchTriggerDetail";
import { triggerKindIcon, triggerKindLabel } from "./stepMeta";
import { TriggerConnectionPicker } from "./TriggerConnectionPicker";

/** Props of {@link TriggerCard}. */
export interface TriggerCardProps {
  trigger: AutomationTrigger;
  /** Position in the list, unique in the editor. */
  index: number;
  connections: SavedConnection[];
  errors: OutputMatchErrors;
  onChange: (trigger: AutomationTrigger) => void;
  onRemove: () => void;
}

/** One automatic trigger with its own settings right under it (R-158). */
export function TriggerCard({
  trigger,
  index,
  connections,
  errors,
  onChange,
  onRemove,
}: TriggerCardProps) {
  const Icon = triggerKindIcon(trigger.kind);
  const label = triggerKindLabel(trigger.kind) ?? trigger.kind;
  return (
    <li
      className="automation-triggers__card"
      data-trigger-index={index}
      data-testid={`automation-editor-trigger-${index}`}
    >
      <div className="automation-triggers__card-header">
        <Icon size={14} />
        <span
          className="automation-triggers__kind"
          data-kind={trigger.kind}
          data-testid={`automation-editor-trigger-kind-${index}`}
        >
          {label}
        </span>
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          aria-label={`Remove the ${label} trigger`}
          icon={<Trash2 size={12} />}
          onClick={onRemove}
          data-testid={`automation-editor-trigger-remove-${index}`}
        />
      </div>
      <div className="automation-triggers__fields">
        <TriggerFields
          trigger={trigger}
          index={index}
          connections={connections}
          errors={errors}
          onChange={onChange}
        />
      </div>
    </li>
  );
}

/** The settings of one trigger, by kind. */
function TriggerFields({
  trigger,
  index,
  connections,
  errors,
  onChange,
}: Omit<TriggerCardProps, "onRemove">) {
  switch (trigger.kind) {
    case "hotkey":
      return (
        <Field
          label="Keys"
          htmlFor={`automation-trigger-binding-${index}`}
          hint="An app shortcut with the same keys wins."
        >
          <Input
            id={`automation-trigger-binding-${index}`}
            value={trigger.binding}
            placeholder="e.g. Ctrl+Alt+H"
            onChange={(e) => onChange({ ...trigger, binding: e.target.value })}
            data-testid={`automation-trigger-binding-${index}`}
          />
        </Field>
      );
    case "on-connect":
      return (
        <TriggerConnectionPicker
          label="When connecting to:"
          connections={connections}
          selected={trigger.connectionIds}
          onChange={(connectionIds) => onChange({ ...trigger, connectionIds })}
          testIdPrefix={`automation-trigger-connection-${index}`}
        />
      );
    case "on-disconnect":
      return (
        <OnDisconnectTriggerDetail
          index={index}
          trigger={trigger}
          connections={connections}
          onChange={onChange}
        />
      );
    case "on-output-match":
      return (
        <OnOutputMatchTriggerDetail
          index={index}
          errors={errors}
          trigger={trigger}
          connections={connections}
          onChange={onChange}
        />
      );
    default:
      return (
        <p className="automation-step__note">
          This version of termiHub cannot edit this trigger. Saving keeps it as it is.
        </p>
      );
  }
}
