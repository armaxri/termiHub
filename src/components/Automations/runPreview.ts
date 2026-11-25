import { stepKindLabel, stepSummary } from "@/components/AutomationEditor/stepText";
import type { Automation } from "@/types/generated/Automation";

/** How many steps the confirmation lists before it counts the rest. */
export const RUN_PREVIEW_STEPS = 5;

/** "1 step" / "3 steps". */
export function stepCountText(count: number): string {
  return `${count} step${count === 1 ? "" : "s"}`;
}

/**
 * What running `automation` does, a line per step (A-035): what is typed into the
 * terminals the user confirms. A **pure** helper.
 */
export function runPreview(
  automation: Pick<Automation, "steps">,
  library: readonly Pick<Automation, "id" | "name">[]
): string[] {
  const { steps } = automation;
  const lines = steps
    .slice(0, RUN_PREVIEW_STEPS)
    .map((step) =>
      [stepKindLabel(step.kind), stepSummary(step, library)].filter(Boolean).join(": ")
    );
  const more = steps.length - lines.length;
  return more > 0 ? [...lines, `and ${stepCountText(more)} more`] : lines;
}
