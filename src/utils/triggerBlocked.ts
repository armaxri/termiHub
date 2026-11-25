/**
 * Why a trigger can never start its automation (C-001): it is said where the trigger is
 * offered, on its card and on the row, so that nobody relies on one. All **pure**.
 */
import { t, tf } from "@/i18n/catalog";
import type { Automation } from "@/types/generated/Automation";
import type { AutomationTrigger } from "@/types/generated/AutomationTrigger";
import { unattendedParamValues, waitingStep } from "@/utils/unattended";

/** Why nothing unattended can start `automation`, in a few words: "step 4 waits for you". */
export function unattendedStartBlocked(
  automation: Automation,
  resolve: (id: string) => Automation | undefined
): string | null {
  const step = waitingStep(automation, resolve);
  if (step !== null) return tf("automation.startBlocked.waits", { step });
  const params = unattendedParamValues(automation.parameters ?? []);
  return "missing" in params
    ? tf("automation.startBlocked.missing", { name: params.missing })
    : null;
}

/** Why `trigger` can never start `automation`, in a few words, or `null`. */
export function triggerBlocked(
  trigger: AutomationTrigger,
  automation: Automation,
  resolve: (id: string) => Automation | undefined,
  connectionName: (id: string) => string | undefined
): string | null {
  if (trigger.kind === "hotkey") return null;
  const ids = trigger.connectionIds ?? [];
  if (ids.length > 0 && ids.every((id) => connectionName(id) === undefined)) {
    return t(ids.length === 1 ? "automation.startBlocked.gone" : "automation.startBlocked.goneAll");
  }
  return trigger.kind === "on-connect" ? null : unattendedStartBlocked(automation, resolve);
}
