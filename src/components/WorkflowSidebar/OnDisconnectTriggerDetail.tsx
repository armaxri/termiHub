import { Field, Select } from "@/components/ui";
import { t } from "@/i18n/catalog";
import type { SavedConnection } from "@/types/connection";
import type { WorkflowDisconnectCause, WorkflowTrigger } from "@/types/workflow";
import { TriggerConnectionPicker } from "./TriggerConnectionPicker";

type OnDisconnectTrigger = Extract<WorkflowTrigger, { kind: "on-disconnect" }>;

interface OnDisconnectTriggerDetailProps {
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
  trigger,
  connections,
  onChange,
}: OnDisconnectTriggerDetailProps) {
  return (
    <div className="workflow-triggers__detail" data-testid="workflow-trigger-on-disconnect-detail">
      <TriggerConnectionPicker
        label={t("workflow.trigger.onDisconnect.connections")}
        connections={connections}
        selected={trigger.connectionIds}
        onChange={(connectionIds) => onChange({ ...trigger, connectionIds })}
        testIdPrefix="workflow-trigger-on-disconnect-connection"
      />
      <Field
        label={t("workflow.trigger.onDisconnect.when")}
        htmlFor="workflow-trigger-on-disconnect-when"
        hint={t("workflow.trigger.onDisconnect.hint")}
      >
        <Select
          id="workflow-trigger-on-disconnect-when"
          value={trigger.when ?? "drop"}
          onChange={(value) => onChange({ ...trigger, when: value as WorkflowDisconnectCause })}
          options={CAUSE_OPTIONS}
          data-testid="workflow-trigger-on-disconnect-when"
        />
      </Field>
    </div>
  );
}
