import { t, tf } from "@/i18n/catalog";
import type { ScheduleInput, ScheduleRule, ScheduleTargets } from "@/types/schedule";
import { formatDayTime } from "@/utils/formatters";
import type { ScheduleFormValues, TargetNames } from "./scheduleForm";

/** Connection ids without blanks and repeats, as the backend compares them. */
function comparable(targets: ScheduleTargets): string {
  if (targets.kind !== "connections") return JSON.stringify(targets);
  const ids = [...new Set(targets.connectionIds.filter((id) => id.trim() !== ""))];
  return JSON.stringify({ kind: targets.kind, ids });
}

/**
 * Whether saving `next` over `stored` switches the schedule off until its hosts
 * are confirmed again: it runs something else, elsewhere, or newly connects.
 * Mirrors `ScheduleManager::save`.
 */
export function needsNewConfirmation(stored: ScheduleInput, next: ScheduleInput): boolean {
  return (
    stored.action.automationId !== next.action.automationId ||
    comparable(stored.targets) !== comparable(next.targets) ||
    (next.connectIfNeeded === true && stored.connectIfNeeded !== true)
  );
}

/** What {@link scheduleSummary} needs to know. */
export interface ScheduleSummaryInput {
  /** ISO time of the next run, or `null` while unknown. */
  next: string | null;
  rule: ScheduleRule;
  targets: TargetNames;
  /** How many targets are chosen. */
  targetCount: number;
  /** Why the automation itself will not run, in full, or `null`. */
  cannotRun: string | null;
  ifClosed: ScheduleFormValues["ifClosed"];
  /** The stored schedule is on. */
  isOn: boolean;
  /** Saving switches it off. */
  switchesOff: boolean;
  paused: boolean;
}

/** What will happen once this is saved, in short sentences (#6024). */
export function scheduleSummary(s: ScheduleSummaryInput): string[] {
  const lines: string[] = [];
  const staysOn = s.isOn && !s.switchesOff;
  if (s.cannotRun) {
    lines.push(s.cannotRun);
  } else if (s.next !== null) {
    // An interval counts from the moment the schedule is switched on.
    const fromSwitch = s.rule.kind === "interval" && !staysOn;
    const when =
      s.rule.kind === "interval" && !staysOn
        ? tf(
            s.rule.everyMinutes === 1
              ? "schedule.summary.afterMinute"
              : "schedule.summary.afterMinutes",
            { count: s.rule.everyMinutes }
          )
        : formatDayTime(s.next);
    if (s.targetCount === 0) lines.push(tf("schedule.summary.noTarget", { when }));
    else if (s.targets.gone) lines.push(tf("schedule.blocked", { reason: s.targets.gone }));
    else {
      const key = fromSwitch ? "schedule.summary.nextAfter" : "schedule.summary.next";
      lines.push(tf(key, { when, targets: s.targets.label }));
    }
  }
  if (s.ifClosed === "skip") lines.push(t("schedule.summary.skips"));
  if (s.switchesOff) lines.push(t("schedule.summary.switchesOff"));
  else if (!s.isOn) lines.push(t("schedule.summary.off"));
  else if (s.paused) lines.push(t("schedule.summary.paused"));
  return lines;
}
