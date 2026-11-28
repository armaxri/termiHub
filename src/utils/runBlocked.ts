/**
 * Why an automation cannot run here at all (#6026), whatever starts it. The row,
 * the palette and the menus say so instead of offering Run; the run itself is
 * refused elsewhere (`automationRunner`, `localProcessRefusal`). All **pure**.
 */
import { findUnknownStep, unknownStepReason, visitSteps } from "@/services/automationRunner";
import { t, tf } from "@/i18n/catalog";
import type { Automation } from "@/types/generated/Automation";
import { EXPERIMENTAL_SETTING_PATH } from "@/utils/experimentalSetting";
import {
  LOCAL_PROGRAMS_SETTING_PATH,
  localProcessBlockedReason,
  localProcessSwitchOff,
  type LocalProcessSwitches,
} from "@/utils/localProcessGate";

/** Finds an automation by id. */
export type ResolveAutomation = (id: string) => Automation | undefined;

/** Why `automation` cannot run, as a sentence that says what to do; `null` when it can. */
export function runBlockedReason(
  automation: Automation,
  resolve: ResolveAutomation,
  switches: boolean | LocalProcessSwitches
): string | null {
  const unknown = findUnknownStep(automation, resolve);
  if (unknown) return unknownStepReason(automation, unknown);
  if (localProcessBlockedReason(automation, resolve, switches) === null) return null;
  // Which switch it waits for (#6178): experimental features, then Security.
  return localProcessSwitchOff(switches) === "experimental"
    ? tf("automation.blocked.localProcess", { path: EXPERIMENTAL_SETTING_PATH })
    : tf("automation.blocked.localPrograms", { path: LOCAL_PROGRAMS_SETTING_PATH });
}

/** The same in a few words: "needs a newer termiHub". */
export function runBlockedShort(
  automation: Automation,
  resolve: ResolveAutomation,
  switches: boolean | LocalProcessSwitches
): string | null {
  if (findUnknownStep(automation, resolve)) return t("automation.blockedShort.unknown");
  if (localProcessBlockedReason(automation, resolve, switches) === null) return null;
  return localProcessSwitchOff(switches) === "experimental"
    ? t("automation.blockedShort.local")
    : t("automation.blockedShort.localPrograms");
}

/**
 * The 1-based top-level step of `automation` that runs an automation the library
 * does not hold, or chooses none; `null` when there is none (live review files-2).
 * The run is not refused for it (the step may be skipped or continue on error),
 * but its row keeps saying so until the step is fixed.
 */
export function missingCalleeStep(
  automation: Automation,
  resolve: ResolveAutomation
): number | null {
  for (const [index, step] of automation.steps.entries()) {
    let missing = false;
    visitSteps([step], (inner) => {
      if (inner.kind === "run-automation" && !resolve(inner.automationId)) missing = true;
    });
    if (missing) return index + 1;
  }
  return null;
}
