import { reachesLocalProcess } from "@/services/automationRunner";
import type { Automation } from "@/types/generated/Automation";
import { fromStepDraft, visitStepDrafts, type StepDraft } from "./automationDraft";
import { isKnownStepKind } from "./stepMeta";

/**
 * Why running the draft would be refused, in a few words, or `null` (A-032): a
 * step of an unknown kind, or a local process while the switch is off, of its own
 * or of an automation it runs. A **pure** helper.
 */
export function blockedSummary(
  steps: readonly StepDraft[],
  resolve: (id: string) => Automation | undefined,
  experimental: boolean
): string | null {
  let unknown = false;
  visitStepDrafts(steps, ({ step }) => {
    if (!isKnownStepKind(step.kind)) unknown = true;
  });
  if (unknown) return "Cannot run: it has a step this version does not know.";
  if (experimental) return null;
  const probe = { id: "", steps: steps.map(fromStepDraft) } as Automation;
  return reachesLocalProcess(probe, resolve)
    ? "Cannot run: local programs are switched off."
    : null;
}
