/**
 * What a schedule's row and the History say about it (#6024): its state, its
 * next run, and how the last run ended and why. All **pure**.
 */
import type { StatusTone } from "@/components/ui";
import { t, tf } from "@/i18n/catalog";
import type { ScheduleRunResult, ScheduleView } from "@/types/schedule";
import { formatDayTime } from "@/utils/formatters";

/**
 * A schedule's state, named first on its row. One that cannot run (`blocked`)
 * names no next run: nothing would happen then.
 */
export function scheduleState(
  s: ScheduleView,
  paused: boolean,
  blocked: boolean,
  now?: Date
): string {
  if (!s.enabled) return t(s.confirmedAt ? "schedule.state.off" : "schedule.state.neverOn");
  if (s.running) return t("schedule.state.running");
  if (paused) return t("schedule.state.paused");
  if (blocked) return t("schedule.state.on");
  return s.nextRunAt
    ? tf("schedule.state.next", { when: formatDayTime(s.nextRunAt, now) })
    : t("schedule.state.none");
}

/** How an attempt ended, finer than its stored outcome. */
export type AttemptKind = "completed" | "partly" | "failed" | "canceled" | "skipped" | "missed";

/** What an attempt says: how it ended, why, and when it ran or was due. */
export interface AttemptSummary {
  kind: AttemptKind;
  /** The reason in full, or `null` when there is nothing to explain. */
  reason: string | null;
  /** ISO time it ran, was skipped, or was due. */
  when: string;
}

/** Before #6024 a missed run's message held its due time, in local time. */
const OLD_MISSED = /^Missed the run due at (\d{4}-\d\d-\d\d) (\d\d:\d\d) \((.+)\)$/;
/** A run that left some targets out says so in parentheses after the count. */
const PARTLY = /^Ran on \d+ terminals? \((.+)\)$/;
/** Before #6024 a failure's count came before its reason. */
const OLD_FAILED = /^Ran on \d+ terminals?: (.+)$/;

/** Read what a recorded attempt says, also one an older version wrote. */
export function summarizeAttempt(result: ScheduleRunResult): AttemptSummary {
  const message = result.message?.trim() || null;
  const when = result.startedAt ?? result.at;
  switch (result.outcome) {
    case "completed": {
      const left = message ? PARTLY.exec(message)?.[1] : undefined;
      return left
        ? { kind: "partly", reason: left, when }
        : { kind: "completed", reason: null, when };
    }
    case "failed":
      return { kind: "failed", reason: message?.replace(OLD_FAILED, "$1") ?? null, when };
    case "cancelled":
      return { kind: "canceled", reason: null, when };
    case "skipped": {
      if (result.missedDueAt) return { kind: "missed", reason: message, when: result.missedDueAt };
      const old = message ? OLD_MISSED.exec(message) : null;
      if (old) {
        const due = new Date(`${old[1]}T${old[2]}`);
        return { kind: "missed", reason: old[3], when: due.toISOString() };
      }
      return { kind: "skipped", reason: message?.replace(/^Skipped: /, "") ?? null, when };
    }
  }
}

/** "Last run failed: … (yesterday 02:00)". */
export function lastRunText(summary: AttemptSummary, now?: Date): string {
  return tf(`schedule.last.${summary.kind}`, {
    when: formatDayTime(summary.when, now),
    reason: summary.reason ?? t("schedule.last.unknownReason"),
  });
}

/** The outcome in a word or two, e.g. "Missed". */
export function attemptLabel(kind: AttemptKind): string {
  return t(`schedule.outcome.${kind}`);
}

/** The {@link StatusTone} of how an attempt ended. */
export function attemptTone(kind: AttemptKind): StatusTone {
  switch (kind) {
    case "completed":
      return "success";
    case "failed":
      return "error";
    case "partly":
    case "canceled":
    case "skipped":
    case "missed":
      return "warning";
  }
}

/**
 * Whether the last run of a schedule that is on is something the user should
 * know: it failed, or did not (fully) happen.
 */
export function lastRunAttention(s: ScheduleView): "error" | "warning" | null {
  if (!s.enabled || !s.lastResult) return null;
  const { kind } = summarizeAttempt(s.lastResult);
  if (kind === "failed") return "error";
  return kind === "skipped" || kind === "missed" || kind === "partly" ? "warning" : null;
}
