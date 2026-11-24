/**
 * The "Run local process" step stays behind the experimental switch (#5818,
 * maintainer decision 2026-11-23), and a schedule runs unattended: with the
 * switch off, a schedule never runs an automation that can reach that step.
 * The schedule editor, the schedules list and the runtime share this one rule.
 */
import { reachesLocalProcess } from "@/services/automationRunner";
import type { Automation } from "@/types/generated/Automation";
import { EXPERIMENTAL_SETTING_PATH } from "@/utils/experimentalSetting";

/** Why such a schedule does not run. */
export const SCHEDULE_LOCAL_PROCESS_REASON =
  `Will not run: it runs a local process, which is experimental. ` +
  `Turn on ${EXPERIMENTAL_SETTING_PATH} to schedule it.`;

/** The reason a schedule must not run `automation`, or `null` when it may. */
export function scheduleBlockedReason(
  automation: Automation,
  resolve: (id: string) => Automation | undefined,
  experimental: boolean
): string | null {
  if (experimental || !reachesLocalProcess(automation, resolve)) return null;
  return SCHEDULE_LOCAL_PROCESS_REASON;
}
