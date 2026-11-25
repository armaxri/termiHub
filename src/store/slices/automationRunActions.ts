/**
 * What a failed run offers (#6026): its automation's editor and its runs. The
 * stores that raise the toast must not import the views, so they ask for them.
 */
import type { ToastOptions } from "@/components/ui";

/** Open the editor of an automation. `AutomationEditorHost` does it. */
export const EDIT_AUTOMATION_EVENT = "termihub:edit-automation";
/** Show an automation's runs in the History. `AutomationEditorHost` does it. */
export const SHOW_AUTOMATION_RUNS_EVENT = "termihub:show-automation-runs";

/** The detail both events carry. */
export interface AutomationEventDetail {
  automationId: string;
}

function ask(event: string, automationId: string): void {
  const detail: AutomationEventDetail = { automationId };
  window.dispatchEvent(new CustomEvent(event, { detail }));
}

/** The two ways on from a failed run, as a toast's buttons. */
export function failedRunActions(automationId: string): Pick<ToastOptions, "action" | "cancel"> {
  return {
    action: {
      label: "Edit",
      testId: "automation-failed-edit",
      onClick: () => ask(EDIT_AUTOMATION_EVENT, automationId),
    },
    cancel: {
      label: "History",
      testId: "automation-failed-history",
      onClick: () => ask(SHOW_AUTOMATION_RUNS_EVENT, automationId),
    },
  };
}
