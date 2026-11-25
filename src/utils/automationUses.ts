import { referencedAutomations } from "@/services/automationRunner";
import type { Automation } from "@/types/generated/Automation";
import type { ScheduleView } from "@/types/schedule";
import { joinWords } from "@/utils/joinWords";

/** What stops working when an automation is deleted, as a sentence; `""` when nothing does. */
export function usedBy(
  automationId: string,
  automations: readonly Automation[],
  schedules: readonly Pick<ScheduleView, "name" | "action">[]
): string {
  const uses = [
    ...schedules
      .filter((s) => s.action.automationId === automationId)
      .map((s) => `schedule “${s.name}”`),
    ...automations
      .filter((a) => a.id !== automationId && referencedAutomations(a.steps).includes(automationId))
      .map((a) => `automation “${a.name}”`),
  ];
  return uses.length === 0 ? "" : `It is used by ${joinWords(uses)}.`;
}
