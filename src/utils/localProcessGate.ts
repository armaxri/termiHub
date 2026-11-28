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

/** Where the Security switch for local programs lives (#6178). */
export const LOCAL_PROGRAMS_SETTING_PATH =
  "Settings ▸ Security ▸ Allow automations to run local programs";

/** Why such a run does not start while the Security switch is off (#6178). */
export const LOCAL_PROGRAMS_OFF_REASON =
  `Will not run: it runs a local program, and ${LOCAL_PROGRAMS_SETTING_PATH} is off. ` +
  "Turn it on to run it.";

/**
 * The two switches a local program needs: experimental features, then the Security
 * switch for local programs (#6178). `true` alone stands for the first with the
 * second on.
 */
export interface LocalProcessSwitches {
  experimental: boolean;
  localPrograms: boolean;
}

/** Which switch keeps a local program from running, or `null` when both are on. */
export function localProcessSwitchOff(
  switches: boolean | LocalProcessSwitches
): "experimental" | "localPrograms" | null {
  const { experimental, localPrograms } =
    typeof switches === "boolean" ? { experimental: switches, localPrograms: true } : switches;
  if (!experimental) return "experimental";
  return localPrograms ? null : "localPrograms";
}

/** The reason `automation` must not run, or `null` when it may. */
export function localProcessBlockedReason(
  automation: Automation,
  resolve: (id: string) => Automation | undefined,
  switches: boolean | LocalProcessSwitches
): string | null {
  const off = localProcessSwitchOff(switches);
  if (off === null || !reachesLocalProcess(automation, resolve)) return null;
  return off === "experimental" ? LOCAL_PROCESS_REASON : LOCAL_PROGRAMS_OFF_REASON;
}
