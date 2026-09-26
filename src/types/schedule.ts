/**
 * Scheduled workflows and macros (PROD-043). Mirrors the Rust types in
 * `src-tauri/src/schedules/{config,wire}.rs` byte-for-byte over the wire.
 */

/** A weekday, as stored (`mon` … `sun`). */
export type ScheduleWeekday = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";

/** Every weekday in display order (Monday first). */
export const SCHEDULE_WEEKDAYS: readonly ScheduleWeekday[] = [
  "mon",
  "tue",
  "wed",
  "thu",
  "fri",
  "sat",
  "sun",
];

/** When a schedule fires. Times are local wall-clock `HH:MM` (24h). */
export type ScheduleRule =
  | { kind: "interval"; everyMinutes: number }
  | { kind: "daily"; time: string }
  | { kind: "weekly"; days: ScheduleWeekday[]; time: string };

/** What a schedule runs. */
export type ScheduleAction =
  | { kind: "workflow"; workflowId: string }
  | { kind: "macro"; macroId: string };

/** Which terminals a scheduled run types into — always explicit. */
export type ScheduleTargets =
  | { kind: "connections"; connectionIds: string[] }
  | { kind: "broadcast-group"; groupId: string };

/** What to do about a run that fell due while the app was closed / asleep. */
export type MissedRunPolicy = "skip" | "run-once";

/** How a scheduled run ended. */
export type ScheduleRunOutcome = "completed" | "failed" | "cancelled" | "skipped";

/** The recorded result of one run attempt of a schedule (a fired run or a skip). */
export interface ScheduleRunResult {
  /** RFC 3339 time the attempt settled. */
  at: string;
  /** RFC 3339 time the run fired (absent for a skipped slot). */
  startedAt?: string;
  /** Milliseconds from firing to settling (fired runs only). */
  durationMs?: number;
  /** Workflow run-history record ids this attempt produced (workflows only). */
  workflowRunIds?: string[];
  outcome: ScheduleRunOutcome;
  /** The skip reason, the failure, or the target count. */
  message?: string;
  /** `true` for a catch-up of a missed slot. */
  catchUp?: boolean;
}

/** A stored schedule (the backend owns every field below `missedRuns`). */
export interface Schedule {
  id: string;
  name: string;
  action: ScheduleAction;
  targets: ScheduleTargets;
  rule: ScheduleRule;
  missedRuns: MissedRunPolicy;
  enabled: boolean;
  /** Set once the user confirmed the targets on first enable. */
  confirmedAt?: string;
  enabledAt?: string;
  lastRunAt?: string;
  lastResult?: ScheduleRunResult;
  /** Recent attempts, newest first, capped by the backend (20). */
  history?: ScheduleRunResult[];
  createdAt: string;
  updatedAt: string;
}

/** A schedule plus its live state, as `list_schedules` returns it. */
export interface ScheduleView extends Schedule {
  /** RFC 3339 time of the next run (enabled schedules only). */
  nextRunAt?: string;
  /** A fired run is still in flight. */
  running: boolean;
}

/** The whole scheduler state. */
export interface SchedulerState {
  /** The global pause switch. */
  paused: boolean;
  schedules: ScheduleView[];
}

/** The user-editable part of a schedule, sent by the editor. */
export interface ScheduleInput {
  /** Existing id to update, or a fresh id for a new schedule. */
  id: string;
  name: string;
  action: ScheduleAction;
  targets: ScheduleTargets;
  rule: ScheduleRule;
  missedRuns: MissedRunPolicy;
}

/** The `schedule-fire` event payload: run `action` on `targets`, then report. */
export interface ScheduleFire {
  token: string;
  scheduleId: string;
  scheduleName: string;
  action: ScheduleAction;
  targets: ScheduleTargets;
  catchUp: boolean;
}

/** This window's report of a fired run. */
export interface WindowRunReport {
  /** `skipped` = nothing ran in this window. */
  outcome: ScheduleRunOutcome;
  message?: string;
  /** Terminals the run was started on in this window. */
  targetsRun: number;
  /** Workflow run-history record ids the run produced in this window. */
  workflowRunIds?: string[];
}
