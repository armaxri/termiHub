/**
 * Tauri command + event wrappers for scheduled runs (PROD-043).
 */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type {
  ScheduleFire,
  ScheduleInput,
  ScheduleView,
  SchedulerState,
  WindowRunReport,
} from "@/types/schedule";

/** The scheduler state: the pause switch and every schedule with its next run. */
export async function listSchedules(): Promise<SchedulerState> {
  return await invoke<SchedulerState>("list_schedules");
}

/** Add or update a schedule. New schedules are always stored disabled. */
export async function saveSchedule(schedule: ScheduleInput): Promise<ScheduleView> {
  return await invoke<ScheduleView>("save_schedule", { schedule });
}

/** Delete a schedule. */
export async function deleteSchedule(scheduleId: string): Promise<void> {
  await invoke("delete_schedule", { scheduleId });
}

/**
 * Enable or disable a schedule. The first enable must pass `confirmed: true`
 * (the user confirmed the hosts the schedule sends input to).
 */
export async function setScheduleEnabled(
  scheduleId: string,
  enabled: boolean,
  confirmed: boolean
): Promise<ScheduleView> {
  return await invoke<ScheduleView>("set_schedule_enabled", { scheduleId, enabled, confirmed });
}

/** Pause or resume all schedules. */
export async function setSchedulesPaused(paused: boolean): Promise<SchedulerState> {
  return await invoke<SchedulerState>("set_schedules_paused", { paused });
}

/** Tell the scheduler this window listens for fired runs (boot / reload). */
export async function registerScheduleWindow(): Promise<void> {
  await invoke("register_schedule_window");
}

/** Acknowledge receipt of a fired run (this window will report on it). */
export async function ackScheduleRun(token: string): Promise<void> {
  await invoke("ack_schedule_run", { token });
}

/** Report this window's outcome of a fired run. */
export async function reportScheduleRun(token: string, report: WindowRunReport): Promise<void> {
  await invoke("report_schedule_run", { token, report });
}

/** Listen for fired scheduled runs. */
export async function onScheduleFire(callback: (fire: ScheduleFire) => void): Promise<UnlistenFn> {
  return await listen<ScheduleFire>("schedule-fire", (event) => callback(event.payload));
}

/** Listen for schedule-list changes (a run settled, a next run moved, an edit). */
export async function onSchedulesChanged(callback: () => void): Promise<UnlistenFn> {
  return await listen("schedules-changed", () => callback());
}
