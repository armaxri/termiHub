/** The choices the schedule editor offers (PROD-043, #6024). */
import type { SelectOption } from "@/components/ui";
import { t } from "@/i18n/catalog";
import type { Automation } from "@/types/generated/Automation";
import type { BroadcastGroup } from "@/types/terminal";

export const TARGET_OPTIONS = [
  { value: "connections", label: "Saved connections" },
  { value: "broadcast-group", label: "Broadcast group" },
];
export const RULE_OPTIONS = [
  { value: "interval", label: "Every N minutes" },
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
];
export const MISSED_OPTIONS = [
  { value: "skip", label: "Skip missed runs" },
  { value: "run-once", label: "Run once when termiHub is back" },
];
/** What a run does about a closed connection: shown as a choice, never a default. */
export const CLOSED_OPTIONS = [
  {
    value: "connect",
    label: t("schedule.closed.connect"),
    description: t("schedule.closed.connectHint"),
    "data-testid": "schedule-editor-closed-connect",
  },
  {
    value: "skip",
    label: t("schedule.closed.skip"),
    description: t("schedule.closed.skipHint"),
    "data-testid": "schedule-editor-closed-skip",
  },
];

/** The groups, plus a stored one that was deleted, so the choice is never blank. */
export function groupOptions(groups: readonly BroadcastGroup[], selected: string): SelectOption[] {
  const options = groups.map((g) => ({ value: g.id, label: g.name }));
  if (selected && !groups.some((g) => g.id === selected)) {
    options.push({ value: selected, label: t("schedule.group.deleted") });
  }
  return options;
}

/**
 * The picker's options: every automation by name, plus the stored id when it
 * no longer resolves, so an edit keeps (and shows) a deleted automation. One
 * that a schedule must not run (#5818) is listed disabled, with the reason.
 */
export function automationOptions(
  automations: readonly Automation[],
  selected: string,
  blockedReason: (id: string) => string | null
): SelectOption[] {
  const options: SelectOption[] = automations.map((a) =>
    blockedReason(a.id)
      ? { value: a.id, label: `${a.name} (experimental: runs a local process)`, disabled: true }
      : { value: a.id, label: a.name }
  );
  if (selected && !automations.some((a) => a.id === selected)) {
    options.push({ value: selected, label: t("schedule.action.deleted") });
  }
  return options;
}
