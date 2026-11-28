import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui";
import { tf } from "@/i18n/catalog";
import type { SavedConnection } from "@/types/connection";
import type { Automation } from "@/types/generated/Automation";
import type { AutomationTrigger } from "@/types/generated/AutomationTrigger";
import { HotkeyField } from "./HotkeyField";
import { OnDisconnectTriggerDetail } from "./OnDisconnectTriggerDetail";
import { OnOutputMatchTriggerDetail, type OutputMatchErrors } from "./OnOutputMatchTriggerDetail";
import { triggerKindIcon, triggerKindLabel } from "./stepMeta";
import { TriggerConnectionPicker } from "./TriggerConnectionPicker";

import { ICON_SIZE } from "@/components/ui/iconSize";
/** Props of {@link TriggerCard}. */
export interface TriggerCardProps {
  trigger: AutomationTrigger;
  /** Position in the list, unique in the editor. */
  index: number;
  connections: SavedConnection[];
  errors: OutputMatchErrors & { binding?: string };
  /** Why it can never start the automation, in a few words, or `null`. */
  blocked: string | null;
  /** The other automations. */
  automations: readonly Automation[];
  onChange: (trigger: AutomationTrigger) => void;
  onRemove: () => void;
}

/** One automatic trigger with its own settings right under it (R-158). */
export function TriggerCard({
  trigger,
  index,
  connections,
  errors,
  blocked,
  automations,
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
        <Icon size={ICON_SIZE.sm} />
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
          icon={<Trash2 size={ICON_SIZE.xs} />}
          onClick={onRemove}
          data-testid={`automation-editor-trigger-remove-${index}`}
        />
      </div>
      {blocked !== null && (
        <p
          className="automation-step__note automation-step__note--warning"
          data-testid={`automation-editor-trigger-blocked-${index}`}
        >
          {tf("automation.startBlocked.card", { reason: blocked })}
        </p>
      )}
      <div className="automation-triggers__fields">
        <TriggerFields
          trigger={trigger}
          index={index}
          connections={connections}
          errors={errors}
          automations={automations}
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
  automations,
  onChange,
}: Omit<TriggerCardProps, "onRemove" | "blocked">) {
  switch (trigger.kind) {
    case "hotkey":
      return (
        <HotkeyField
          index={index}
          binding={trigger.binding}
          error={errors.binding}
          automations={automations}
          onChange={(binding) => onChange({ ...trigger, binding })}
        />
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
