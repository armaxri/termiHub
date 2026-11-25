import { stepKindLabel, stepSummary } from "@/components/AutomationEditor/stepText";
import { joinWords } from "@/utils/joinWords";
import type { AutomationStep } from "@/types/generated/AutomationStep";

/**
 * Where a run uses the value it asks for (B-006): "Used in step 2 (Condition: If
 * ${env} equals prod)", so its short name means something. `""` when no step does.
 * A **pure** helper.
 */
export function parameterUse(name: string, steps: readonly AutomationStep[]): string {
  const used = steps.flatMap((step, i) =>
    JSON.stringify(step).includes(`\${${name}}`) ? [i] : []
  );
  if (used.length === 0) return "";
  if (used.length > 1) {
    return `Used in steps ${joinWords(used.map((i) => String(i + 1)))}`;
  }
  const step = steps[used[0]];
  if (step.kind === "conditional" && step.condition.op === "eq") {
    const { left, right } = step.condition;
    if (left === `\${${name}}`) return `Step ${used[0] + 1} checks whether it is “${right}”`;
  }
  const what = [stepKindLabel(step.kind), stepSummary(step)].filter(Boolean).join(": ");
  return `Used in step ${used[0] + 1} (${what})`;
}
