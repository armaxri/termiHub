/**
 * Tauri command wrappers for the merged automation store and its run history
 * (#5818, slice 4). Since slice 4 these are the only library and history
 * commands the UI calls: the legacy `macros.json` / `workflows.json` (and their
 * run-history files) are frozen for older builds and never written again.
 */

import { invoke } from "@tauri-apps/api/core";
import type { Automation } from "@/types/generated/Automation";
import type { AutomationRun } from "@/types/generated/AutomationRun";

/** List all stored automations. */
export async function listAutomations(): Promise<Automation[]> {
  return await invoke<Automation[]>("list_automations");
}

/** Get one stored automation by id. Rejects when there is none. */
export async function getAutomation(automationId: string): Promise<Automation> {
  return await invoke<Automation>("get_automation", { automationId });
}

/** Save (add or update) an automation. Returns it with authoritative timestamps. */
export async function saveAutomation(automation: Automation): Promise<Automation> {
  return await invoke<Automation>("save_automation", { automation });
}

/** Delete an automation by id. */
export async function deleteAutomation(automationId: string): Promise<void> {
  await invoke("delete_automation", { automationId });
}

/** List every recorded automation run, newest first. */
export async function listAutomationRuns(): Promise<AutomationRun[]> {
  return await invoke<AutomationRun[]>("list_automation_runs");
}

/** Record one finished run. Returns the updated (capped, newest-first) list. */
export async function recordAutomationRun(run: AutomationRun): Promise<AutomationRun[]> {
  return await invoke<AutomationRun[]>("record_automation_run", { run });
}

/**
 * Clear the runs with the given ids, or the whole history when `runIds` is
 * omitted. Returns the remaining runs, newest first.
 */
export async function clearAutomationRunHistory(runIds?: string[]): Promise<AutomationRun[]> {
  return await invoke<AutomationRun[]>("clear_automation_run_history", { runIds });
}
