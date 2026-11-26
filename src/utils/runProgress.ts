/**
 * How far a run is, in the one wording every place uses (B-002): a step-by-step run
 * says the step it is at, a run that types keys says the share that was typed. All
 * **pure**.
 */
import { t, tf } from "@/i18n/catalog";

/** The step a run is at, 1-based; the last one while it finishes. */
export function currentStep(completed: number, total: number): number {
  return Math.min(completed + 1, Math.max(1, total));
}

/** "Step 2 of 3". */
export function stepProgress(completed: number, total: number): string {
  return `Step ${currentStep(completed, total)} of ${total}`;
}

/** The share that was typed, in percent: the parts of a recording are keys and pastes (A-003). */
export function typedPercent(typed: number, total: number): number {
  return total > 0 ? Math.floor((typed / total) * 100) : 0;
}

/** "50 % typed". */
export function typedProgress(typed: number, total: number): string {
  return `${typedPercent(typed, total)} % typed`;
}

/**
 * What the History says of a target stopped while it waited for its turn (#6133):
 * it never started, and what stopped it when another run did.
 */
export function notRunBecause(reason: string | undefined): string {
  return reason === undefined
    ? t("automation.notRun")
    : tf("automation.notRunBecause", { why: reason });
}
