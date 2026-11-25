import { t, tf } from "@/i18n/catalog";
import type { ScheduleInput, ScheduleRule, ScheduleTargets } from "@/types/schedule";
import { formatDayTime } from "@/utils/formatters";
import type { ScheduleFormValues, TargetNames } from "./scheduleForm";
import { joinWords } from "@/utils/joinWords";

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
  /** The automation itself will not run; its field says why. */
  cannotRun: boolean;
  /** What still keeps it from being saved, in words. */
  missing: string[];
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
  if (s.missing.length > 0) {
    if (s.cannotRun) lines.push(t("schedule.summary.cannot"));
    lines.push(tf("schedule.summary.toSave", { list: joinWords(s.missing) }));
    return lines;
  }
  if (s.cannotRun) {
    lines.push(t("schedule.summary.cannot"));
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
    if (s.targets.gone) {
      lines.push(
        `${tf("schedule.blocked", { reason: s.targets.gone })} ${t("schedule.summary.repair")}`
      );
    } else {
      // Off is off: the next run is only what would happen then (B-030).
      const key = fromSwitch
        ? "schedule.summary.nextAfter"
        : !staysOn
          ? "schedule.summary.whenOn"
          : s.paused
            ? "schedule.summary.next"
            : "schedule.summary.onNext";
      lines.push(tf(key, { when, targets: s.targets.label }));
    }
  }
  if (s.ifClosed === "skip") lines.push(t("schedule.summary.skips"));
  if (s.switchesOff) lines.push(t("schedule.summary.switchesOff"));
  else if (!s.isOn && s.next === null) lines.push(t("schedule.summary.off"));
  else if (s.paused) lines.push(t("schedule.summary.paused"));
  return lines;
}
