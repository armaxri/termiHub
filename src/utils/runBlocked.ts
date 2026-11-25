/**
 * Why an automation cannot run here at all (#6026), whatever starts it. The row,
 * the palette and the menus say so instead of offering Run; the run itself is
 * refused elsewhere (`automationRunner`, `localProcessRefusal`). All **pure**.
 */
import { findUnknownStep, unknownStepReason } from "@/services/automationRunner";
import { t, tf } from "@/i18n/catalog";
import type { Automation } from "@/types/generated/Automation";
import { EXPERIMENTAL_SETTING_PATH } from "@/utils/experimentalSetting";
import { localProcessBlockedReason } from "@/utils/localProcessGate";

/** Finds an automation by id. */
export type ResolveAutomation = (id: string) => Automation | undefined;

/** Why `automation` cannot run, as a sentence that says what to do; `null` when it can. */
export function runBlockedReason(
  automation: Automation,
  resolve: ResolveAutomation,
  experimental: boolean
): string | null {
  const unknown = findUnknownStep(automation, resolve);
  if (unknown) return unknownStepReason(automation, unknown);
  return localProcessBlockedReason(automation, resolve, experimental) === null
    ? null
    : tf("automation.blocked.localProcess", { path: EXPERIMENTAL_SETTING_PATH });
}

/** The same in a few words: "needs a newer termiHub". */
export function runBlockedShort(
  automation: Automation,
  resolve: ResolveAutomation,
  experimental: boolean
): string | null {
  if (findUnknownStep(automation, resolve)) return t("automation.blockedShort.unknown");
  return localProcessBlockedReason(automation, resolve, experimental) === null
    ? null
    : t("automation.blockedShort.local");
}
