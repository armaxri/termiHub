import { Field, Input, NumberInput, Toggle } from "@/components/ui";
import { t, type MessageId } from "@/i18n/catalog";
import {
  cooldownInRange,
  maxFiresInRange,
  validateOutputPattern,
  type OutputPatternError,
} from "@/services/workflowOutputTriggers";
import type { SavedConnection } from "@/types/connection";
import type { WorkflowTrigger } from "@/types/workflow";
import { TriggerConnectionPicker } from "./TriggerConnectionPicker";

type OnOutputMatchTrigger = Extract<WorkflowTrigger, { kind: "on-output-match" }>;

interface OnOutputMatchTriggerDetailProps {
  trigger: OnOutputMatchTrigger;
  connections: SavedConnection[];
  onChange: (trigger: OnOutputMatchTrigger) => void;
}

/** The catalog message for each pattern-validation error. */
const PATTERN_ERROR_MESSAGE: Record<OutputPatternError, MessageId> = {
  empty: "workflow.trigger.pattern.error.empty",
  "too-long": "workflow.trigger.pattern.error.tooLong",
  "invalid-regex": "workflow.trigger.pattern.error.invalidRegex",
  "unsafe-regex": "workflow.trigger.pattern.error.unsafeRegex",
};

/** Milliseconds per second: the cooldown is edited in seconds, stored in ms. */
const MS_PER_SECOND = 1000;

/**
 * Detail editor of an `on-output-match` trigger (#3791): the watched
 * connections, the pattern (literal or regex, validated inline), and the
 * cooldown and max-runs-per-session limits. Blank limits use the defaults.
 */
export function OnOutputMatchTriggerDetail({
  trigger,
  connections,
  onChange,
}: OnOutputMatchTriggerDetailProps) {
  const patternError = validateOutputPattern(trigger.pattern, trigger.isRegex);
  const cooldownSeconds =
    trigger.cooldownMs === undefined ? "" : trigger.cooldownMs / MS_PER_SECOND;

  return (
    <div
      className="workflow-triggers__detail"
      data-testid="workflow-trigger-on-output-match-detail"
    >
      <TriggerConnectionPicker
        label={t("workflow.trigger.onOutputMatch.connections")}
        connections={connections}
        selected={trigger.connectionIds}
        onChange={(connectionIds) => onChange({ ...trigger, connectionIds })}
        testIdPrefix="workflow-trigger-on-output-match-connection"
      />
      <Field
        label={t("workflow.trigger.onOutputMatch.pattern")}
        htmlFor="workflow-trigger-on-output-match-pattern"
        error={patternError ? t(PATTERN_ERROR_MESSAGE[patternError]) : undefined}
        hint={t("workflow.trigger.onOutputMatch.hint")}
      >
        <Input
          id="workflow-trigger-on-output-match-pattern"
          value={trigger.pattern}
          placeholder={t("workflow.trigger.onOutputMatch.patternPlaceholder")}
          onChange={(e) => onChange({ ...trigger, pattern: e.target.value })}
          data-testid="workflow-trigger-on-output-match-pattern"
        />
      </Field>
      <Field
        label={t("workflow.trigger.onOutputMatch.isRegex")}
        htmlFor="workflow-trigger-on-output-match-regex"
      >
        <Toggle
          id="workflow-trigger-on-output-match-regex"
          checked={trigger.isRegex ?? false}
          onCheckedChange={(checked) =>
            onChange({ ...trigger, isRegex: checked ? true : undefined })
          }
          data-testid="workflow-trigger-on-output-match-regex"
        />
      </Field>
      <Field
        label={t("workflow.trigger.onOutputMatch.cooldown")}
        htmlFor="workflow-trigger-on-output-match-cooldown"
        hint={t("workflow.trigger.onOutputMatch.cooldownHint")}
        error={
          cooldownInRange(trigger.cooldownMs)
            ? undefined
            : t("workflow.trigger.onOutputMatch.cooldownError")
        }
      >
        <NumberInput
          id="workflow-trigger-on-output-match-cooldown"
          value={cooldownSeconds}
          min={1}
          onValueChange={(v) =>
            onChange({ ...trigger, cooldownMs: v === "" ? undefined : v * MS_PER_SECOND })
          }
          data-testid="workflow-trigger-on-output-match-cooldown"
        />
      </Field>
      <Field
        label={t("workflow.trigger.onOutputMatch.maxFires")}
        htmlFor="workflow-trigger-on-output-match-max-fires"
        hint={t("workflow.trigger.onOutputMatch.maxFiresHint")}
        error={
          maxFiresInRange(trigger.maxFiresPerSession)
            ? undefined
            : t("workflow.trigger.onOutputMatch.maxFiresError")
        }
      >
        <NumberInput
          id="workflow-trigger-on-output-match-max-fires"
          value={trigger.maxFiresPerSession ?? ""}
          min={1}
          onValueChange={(v) =>
            onChange({ ...trigger, maxFiresPerSession: v === "" ? undefined : v })
          }
          data-testid="workflow-trigger-on-output-match-max-fires"
        />
      </Field>
    </div>
  );
}
