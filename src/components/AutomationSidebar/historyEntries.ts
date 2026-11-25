/**
 * The one History (#5818, #6024): every recorded run, plus the scheduled times
 * at which nothing ran (missed, skipped, failed to start). A schedule keeps
 * those itself, so without them a night without a run would leave no trace here.
 * All **pure**.
 */
import { summarizeAttempt, type AttemptSummary } from "@/components/Schedules/scheduleStatus";
import { t } from "@/i18n/catalog";
import type { AutomationRun } from "@/types/generated/AutomationRun";
import type { ScheduleView } from "@/types/schedule";

/** What the schedule that started a run says about it. */
export interface RunSchedule {
  name: string;
  /** Targets the run left out, or `null`. */
  leftOut: string | null;
}

/** A scheduled time at which nothing ran. */
export interface ScheduleGap {
  /** Stable key. */
  id: string;
  automationId: string;
  automationName: string;
  scheduleId: string;
  scheduleName: string;
  /** ISO time it was recorded: its place in the list. */
  at: string;
  summary: AttemptSummary;
}

/** One entry of the History. */
export type HistoryEntry =
  | { kind: "run"; run: AutomationRun; schedule?: RunSchedule }
  | { kind: "gap"; gap: ScheduleGap };

/** The schedule of each run a schedule started, by run id. */
export function schedulesOfRuns(schedules: readonly ScheduleView[]): Map<string, RunSchedule> {
  const out = new Map<string, RunSchedule>();
  for (const schedule of schedules) {
    for (const attempt of schedule.history ?? []) {
      const summary = summarizeAttempt(attempt);
      const leftOut = summary.kind === "partly" ? summary.reason : null;
      for (const id of attempt.runIds ?? []) out.set(id, { name: schedule.name, leftOut });
    }
  }
  return out;
}

function time(iso: string): number {
  return Date.parse(iso) || 0;
}

/**
 * The scheduled times at which nothing ran, newest first. An attempt that left
 * run records is not one: its runs are in the list already.
 */
export function scheduleGaps(
  schedules: readonly ScheduleView[],
  names: ReadonlyMap<string, string>
): ScheduleGap[] {
  const gaps = schedules.flatMap((schedule) =>
    (schedule.history ?? [])
      .filter((a) => (a.runIds ?? []).length === 0 && a.outcome !== "completed")
      .map((attempt, index) => {
        const { automationId } = schedule.action;
        return {
          id: `${schedule.id}:${attempt.at}:${index}`,
          automationId,
          automationName: names.get(automationId) ?? t("schedule.action.deleted"),
          scheduleId: schedule.id,
          scheduleName: schedule.name,
          at: attempt.at,
          summary: summarizeAttempt(attempt),
        };
      })
  );
  return gaps.sort((a, b) => time(b.at) - time(a.at));
}

/** Runs (in the order given, newest first) and gaps in one newest-first list. */
export function mergeHistory(
  runs: readonly AutomationRun[],
  gaps: readonly ScheduleGap[],
  schedules: ReadonlyMap<string, RunSchedule>
): HistoryEntry[] {
  const out: HistoryEntry[] = [];
  let next = 0;
  for (const run of runs) {
    while (next < gaps.length && time(gaps[next].at) > time(run.endedAt)) {
      out.push({ kind: "gap", gap: gaps[next] });
      next += 1;
    }
    out.push({ kind: "run", run, schedule: schedules.get(run.id) });
  }
  for (; next < gaps.length; next += 1) out.push({ kind: "gap", gap: gaps[next] });
  return out;
}
