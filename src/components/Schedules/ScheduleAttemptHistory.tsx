import { StatusDot } from "@/components/ui";
import type { StatusTone } from "@/components/ui";
import type { ScheduleRunOutcome, ScheduleRunResult } from "@/types/schedule";
import { formatAbsoluteTime, formatElapsed, formatRelativeTime } from "@/utils/formatters";

/** Status-dot tone of a run outcome. */
export function outcomeTone(outcome: ScheduleRunOutcome): StatusTone {
  switch (outcome) {
    case "completed":
      return "success";
    case "failed":
      return "error";
    case "cancelled":
    case "skipped":
      return "warning";
  }
}

/** Human label of a run outcome. */
function outcomeLabel(outcome: ScheduleRunOutcome): string {
  switch (outcome) {
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    case "skipped":
      return "Skipped";
  }
}

/** How long a fired run took, e.g. `2s`; empty for skips. */
function attemptDuration(attempt: ScheduleRunResult): string {
  const ms = attempt.durationMs;
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return "";
  return formatElapsed(Math.round(ms / 1000));
}

/** The "N workflow runs" note linking an attempt to the run history. */
function runsNote(ids: readonly string[] | undefined): string {
  if (!ids || ids.length === 0) return "";
  return `${ids.length} workflow run${ids.length === 1 ? "" : "s"} in history`;
}

/** Props of {@link ScheduleAttemptHistory}. */
export interface ScheduleAttemptHistoryProps {
  /** The schedule whose attempts are listed (test hooks). */
  scheduleId: string;
  /** Recent attempts, newest first. */
  attempts: readonly ScheduleRunResult[];
}

/**
 * The recent run attempts of one schedule (#3528), newest first: outcome,
 * when it settled, how long it ran, whether it was a catch-up, the skip
 * reason / failure detail, and how many workflow run-history records it
 * produced (their ids are in the tooltip). Tokens only.
 */
export function ScheduleAttemptHistory({ scheduleId, attempts }: ScheduleAttemptHistoryProps) {
  return (
    <ol
      className="schedule-attempts"
      data-testid={`schedule-attempts-${scheduleId}`}
      aria-label="Recent attempts"
    >
      {attempts.map((attempt, index) => {
        const duration = attemptDuration(attempt);
        const runs = runsNote(attempt.workflowRunIds);
        return (
          <li
            key={`${attempt.at}-${index}`}
            className="schedule-attempts__item"
            data-testid={`schedule-attempt-${scheduleId}-${index}`}
          >
            <span className="schedule-attempts__head">
              <StatusDot
                tone={outcomeTone(attempt.outcome)}
                label={outcomeLabel(attempt.outcome)}
              />
              <span className="schedule-attempts__outcome">{outcomeLabel(attempt.outcome)}</span>
              <time dateTime={attempt.at} title={formatAbsoluteTime(attempt.at)}>
                {formatRelativeTime(attempt.at)}
              </time>
              {duration ? <span>· {duration}</span> : null}
              {attempt.catchUp ? <span>· catch-up</span> : null}
            </span>
            {attempt.message ? (
              <span className="schedule-attempts__message" title={attempt.message}>
                {attempt.message}
              </span>
            ) : null}
            {runs ? (
              <span
                className="schedule-attempts__runs"
                title={attempt.workflowRunIds?.join("\n")}
                data-testid={`schedule-attempt-runs-${scheduleId}-${index}`}
              >
                {runs}
              </span>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
