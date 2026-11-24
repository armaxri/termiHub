/**
 * The store's side of the "Run local process" experimental gate (#5988): the
 * rule of `localProcessGate` on the automation a run would execute and the
 * current settings. Kept apart from the opt-in and the per-program allowlist,
 * which are separate controls; a spawn needs all three.
 */
import type { Workflow } from "@/types/workflow";
import { localProcessBlockedReason } from "@/utils/localProcessGate";

import type { AppState } from "./appStore";
import { currentSettingsView } from "./settingsBridge";
import { automationForRun } from "./slices/automationStoreState";
import { workflowToAutomation } from "./slices/automationViews";

/** Whether experimental features are on; anything but an explicit `true` is off. */
export function experimentalFeaturesOn(): boolean {
  return currentSettingsView().experimentalFeaturesEnabled === true;
}

/** Why a run of `workflow` must not start, or `null` when it may. */
export function localProcessRefusal(state: AppState, workflow: Workflow): string | null {
  const resolve = (id: string) => automationForRun(state, id);
  // The same automation `runWorkflowOnTarget` executes.
  const automation = resolve(workflow.id) ?? workflowToAutomation(workflow);
  return localProcessBlockedReason(automation, resolve, experimentalFeaturesOn());
}

/** One toast per workflow, so a trigger that keeps firing does not pile them up. */
export function localProcessRefusalToastId(workflowId: string): string {
  return `workflow-local-process-refused-${workflowId}`;
}
