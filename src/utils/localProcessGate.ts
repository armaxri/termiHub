/**
 * The "Run local process" step stays behind the experimental switch (#5818,
 * maintainer decision 2026-11-23): with the switch off, nothing runs an
 * automation that can reach that step, whatever starts the run (#5988). The
 * run entry points, the schedule editor and the schedules list share this rule.
 */
import { reachesLocalProcess } from "@/services/automationRunner";
import type { Automation } from "@/types/generated/Automation";
import { EXPERIMENTAL_SETTING_PATH } from "@/utils/experimentalSetting";

/** Why such a run does not start. */
export const LOCAL_PROCESS_REASON =
  `Will not run: it runs a local process, which is experimental. ` +
  `Turn on ${EXPERIMENTAL_SETTING_PATH} to run it.`;

/** The reason `automation` must not run, or `null` when it may. */
export function localProcessBlockedReason(
  automation: Automation,
  resolve: (id: string) => Automation | undefined,
  experimental: boolean
): string | null {
  if (experimental || !reachesLocalProcess(automation, resolve)) return null;
  return LOCAL_PROCESS_REASON;
}
