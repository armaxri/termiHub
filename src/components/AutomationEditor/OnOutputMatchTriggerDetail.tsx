import { Field, Input, NumberInput, Toggle } from "@/components/ui";
import { t } from "@/i18n/catalog";
import type { SavedConnection } from "@/types/connection";
import type { AutomationTrigger } from "@/types/generated/AutomationTrigger";
import { TriggerConnectionPicker } from "./TriggerConnectionPicker";

type OnOutputMatchTrigger = Extract<AutomationTrigger, { kind: "on-output-match" }>;

/** The errors of an output-match trigger the user should see now. */
export interface OutputMatchErrors {
  pattern?: string;
  cooldownMs?: string;
  maxFiresPerSession?: string;
}

interface OnOutputMatchTriggerDetailProps {
  /** Position of the trigger, unique in the editor. */
  index: number;
  errors: OutputMatchErrors;
  trigger: OnOutputMatchTrigger;
  connections: SavedConnection[];
  onChange: (trigger: OnOutputMatchTrigger) => void;
}

/** Milliseconds per second: the cooldown is edited in seconds, stored in ms. */
const MS_PER_SECOND = 1000;

/**
 * Detail editor of an `on-output-match` trigger (#3791): the watched
 * connections, the pattern (literal or regex, validated inline), and the
 * cooldown and max-runs-per-session limits. Blank limits use the defaults.
 */
export function OnOutputMatchTriggerDetail({
  index,
  errors,
  trigger,
  connections,
  onChange,
}: OnOutputMatchTriggerDetailProps) {
  /** Set an optional field, or drop it from the stored trigger. */
  const setOptional = <K extends "isRegex" | "cooldownMs" | "maxFiresPerSession">(
    key: K,
    value: OnOutputMatchTrigger[K] | undefined
  ) => {
    const next = { ...trigger };
    if (value === undefined) delete next[key];
    else next[key] = value;
    onChange(next);
  };
  const cooldownSeconds =
    trigger.cooldownMs === undefined ? "" : trigger.cooldownMs / MS_PER_SECOND;

  return (
    <>
      <TriggerConnectionPicker
        label={t("workflow.trigger.onOutputMatch.connections")}
        connections={connections}
        selected={trigger.connectionIds}
        onChange={(connectionIds) => onChange({ ...trigger, connectionIds })}
        testIdPrefix={`automation-trigger-connection-${index}`}
      />
      <Field
        label={t("workflow.trigger.onOutputMatch.pattern")}
        htmlFor={`automation-trigger-pattern-${index}`}
        error={errors.pattern}
        hint={t("workflow.trigger.onOutputMatch.hint")}
      >
        <Input
          id={`automation-trigger-pattern-${index}`}
          value={trigger.pattern}
          placeholder={t("workflow.trigger.onOutputMatch.patternPlaceholder")}
          onChange={(e) => onChange({ ...trigger, pattern: e.target.value })}
          data-testid={`automation-trigger-pattern-${index}`}
        />
      </Field>
      <Field
        label={t("workflow.trigger.onOutputMatch.isRegex")}
        htmlFor={`automation-trigger-regex-${index}`}
      >
        <Toggle
          id={`automation-trigger-regex-${index}`}
          checked={trigger.isRegex ?? false}
          onCheckedChange={(checked) => setOptional("isRegex", checked ? true : undefined)}
          data-testid={`automation-trigger-regex-${index}`}
        />
      </Field>
      <Field
        label={t("workflow.trigger.onOutputMatch.cooldown")}
        htmlFor={`automation-trigger-cooldown-${index}`}
        hint={t("workflow.trigger.onOutputMatch.cooldownHint")}
        error={errors.cooldownMs}
      >
        <NumberInput
          id={`automation-trigger-cooldown-${index}`}
          value={cooldownSeconds}
          min={1}
          onValueChange={(v) =>
            setOptional("cooldownMs", v === "" ? undefined : Math.round(v * MS_PER_SECOND))
          }
          data-testid={`automation-trigger-cooldown-${index}`}
        />
      </Field>
      <Field
        label={t("workflow.trigger.onOutputMatch.maxFires")}
        htmlFor={`automation-trigger-max-fires-${index}`}
        hint={t("workflow.trigger.onOutputMatch.maxFiresHint")}
        error={errors.maxFiresPerSession}
      >
        <NumberInput
          id={`automation-trigger-max-fires-${index}`}
          value={trigger.maxFiresPerSession ?? ""}
          min={1}
          onValueChange={(v) => setOptional("maxFiresPerSession", v === "" ? undefined : v)}
          data-testid={`automation-trigger-max-fires-${index}`}
        />
      </Field>
    </>
  );
}
