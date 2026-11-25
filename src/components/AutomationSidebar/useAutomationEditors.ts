import { useCallback } from "react";
import { useAutomationEditor } from "@/components/AutomationEditor";
import { newId } from "@/services/transport/ids";
import { useAppStore } from "@/store/appStore";
import type { Automation } from "@/types/generated/Automation";
import type { AutomationStep } from "@/types/generated/AutomationStep";

/** A new automation that is not stored yet; the backend stamps its timestamps. */
function blankAutomation(steps: AutomationStep[]): Automation {
  return {
    id: newId("automation"),
    name: "",
    tags: [],
    steps,
    triggers: [],
    createdAt: "",
    updatedAt: "",
  };
}

/** Result of {@link useAutomationEditors}. */
export interface AutomationEditors {
  /** Create an automation step by step. */
  newFromSteps: () => void;
  /** Create an automation by writing the keystrokes it types. */
  newFromKeys: () => void;
  /** Create an automation that runs `automationId` as its first step. */
  newFromAutomation: (automationId: string) => void;
  /** Edit a stored automation. */
  edit: (automationId: string) => void;
}

/** The ways the sidebar opens the one automation editor (#5818, slice 7). */
export function useAutomationEditors(): AutomationEditors {
  const automations = useAppStore((s) => s.automations);
  const open = useAutomationEditor((s) => s.open);

  const newFromSteps = useCallback(() => open(blankAutomation([]), true), [open]);
  const newFromKeys = useCallback(
    () => open(blankAutomation([{ kind: "type-keys", chunks: [], timing: "recorded" }]), true),
    [open]
  );

  const newFromAutomation = useCallback(
    (automationId: string) => {
      const source = automations.find((a) => a.id === automationId);
      if (!source) return;
      const blank = blankAutomation([{ kind: "run-automation", automationId: source.id }]);
      const automation = { ...blank, name: source.name, tags: source.tags };
      if (source.description !== undefined) automation.description = source.description;
      open(automation, true);
    },
    [automations, open]
  );

  const edit = useCallback(
    (automationId: string) => {
      const automation = automations.find((a) => a.id === automationId);
      if (automation) open(automation, false);
    },
    [automations, open]
  );

  return { newFromSteps, newFromKeys, newFromAutomation, edit };
}
