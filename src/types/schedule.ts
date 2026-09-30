/**
 * Scheduled workflows and macros (PROD-043). The wire types are generated from
 * the Rust types in `src-tauri/src/schedules/{config,wire}.rs`.
 */

// The scheduler DTOs are generated from their Rust source of truth
// (`src-tauri/src/schedules/{config,wire}.rs`) via ts-rs (audit DUP-030,
// ts-rs rollout #3088). `ScheduleWeekday` is also used locally below.
import type { ScheduleWeekday } from "./generated/ScheduleWeekday";

export type { ScheduleWeekday };
export type { ScheduleRule } from "./generated/ScheduleRule";
export type { ScheduleAction } from "./generated/ScheduleAction";
export type { ScheduleTargets } from "./generated/ScheduleTargets";
export type { MissedRunPolicy } from "./generated/MissedRunPolicy";
export type { ScheduleRunOutcome } from "./generated/ScheduleRunOutcome";
export type { ScheduleRunResult } from "./generated/ScheduleRunResult";
export type { ScheduleView } from "./generated/ScheduleView";
export type { SchedulerState } from "./generated/SchedulerState";
export type { ScheduleInput } from "./generated/ScheduleInput";
export type { ScheduleFire } from "./generated/ScheduleFire";
export type { WindowRunReport } from "./generated/WindowRunReport";
export type { RunCoverage } from "./generated/RunCoverage";

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
