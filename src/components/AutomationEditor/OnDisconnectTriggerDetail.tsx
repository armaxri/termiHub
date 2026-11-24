import { Field, Select } from "@/components/ui";
import { t } from "@/i18n/catalog";
import type { SavedConnection } from "@/types/connection";
import type { AutomationTrigger } from "@/types/generated/AutomationTrigger";
import type { WorkflowDisconnectCause } from "@/types/workflow";
import { TriggerConnectionPicker } from "./TriggerConnectionPicker";

type OnDisconnectTrigger = Extract<AutomationTrigger, { kind: "on-disconnect" }>;

interface OnDisconnectTriggerDetailProps {
  /** Position of the trigger, unique in the editor. */
  index: number;
  trigger: OnDisconnectTrigger;
  connections: SavedConnection[];
  onChange: (trigger: OnDisconnectTrigger) => void;
}

const CAUSE_OPTIONS: { value: WorkflowDisconnectCause; label: string }[] = [
  { value: "drop", label: t("workflow.trigger.onDisconnect.when.drop") },
  { value: "user-close", label: t("workflow.trigger.onDisconnect.when.userClose") },
  { value: "any", label: t("workflow.trigger.onDisconnect.when.any") },
];

/**
 * Detail editor of an `on-disconnect` trigger (#3791): the bound connections
 * and which session endings fire it (default: unexpected drops only).
 */
export function OnDisconnectTriggerDetail({
  index,
  trigger,
  connections,
  onChange,
}: OnDisconnectTriggerDetailProps) {
  return (
    <>
      <TriggerConnectionPicker
        label={t("workflow.trigger.onDisconnect.connections")}
        connections={connections}
        selected={trigger.connectionIds}
        onChange={(connectionIds) => onChange({ ...trigger, connectionIds })}
        testIdPrefix={`automation-trigger-connection-${index}`}
      />
      <Field
        label={t("workflow.trigger.onDisconnect.when")}
        htmlFor={`automation-trigger-when-${index}`}
        hint={t("workflow.trigger.onDisconnect.hint")}
      >
        <Select
          id={`automation-trigger-when-${index}`}
          value={trigger.when ?? "drop"}
          onChange={(value) => onChange({ ...trigger, when: value as WorkflowDisconnectCause })}
          options={CAUSE_OPTIONS}
          data-testid={`automation-trigger-when-${index}`}
        />
      </Field>
    </>
  );
}
