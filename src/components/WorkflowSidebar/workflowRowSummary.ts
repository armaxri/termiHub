import type { Workflow, WorkflowTrigger } from "@/types/workflow";
import { triggerKindLabel } from "./workflowStepMeta";

/** How many bound connection names a trigger lists before collapsing to "+N". */
export const MAX_SUMMARY_CONNECTIONS = 2;

/** Triggers that launch a workflow by themselves once a bound session acts. */
type AutomaticTrigger = Extract<
  WorkflowTrigger,
  { kind: "on-connect" | "on-disconnect" | "on-output-match" }
>;

/** True for a connection-bound trigger with at least one connection bound. */
function isArmedTrigger(trigger: WorkflowTrigger): trigger is AutomaticTrigger {
  return (
    (trigger.kind === "on-connect" ||
      trigger.kind === "on-disconnect" ||
      trigger.kind === "on-output-match") &&
    trigger.connectionIds.length > 0
  );
}

/**
 * The workflow's armed triggers (#5635): the ones that run it — and may type
 * into a terminal — without the user starting it.
 */
export function armedTriggers(workflow: Workflow): AutomaticTrigger[] {
  return workflow.triggers.filter(isArmedTrigger);
}

/** The bound connections' names, the first few listed and the rest counted. */
function connectionList(ids: string[], connectionName: (id: string) => string | undefined) {
  const names = ids.map((id) => connectionName(id) ?? "Unknown connection");
  const shown = names.slice(0, MAX_SUMMARY_CONNECTIONS).join(", ");
  const rest = names.length - MAX_SUMMARY_CONNECTIONS;
  return rest > 0 ? `${shown} +${rest}` : shown;
}

/**
 * The muted second line of a workflow row (#5635): how it is launched and
 * what it targets, e.g. `On output match · pr-auto-local` or `Manual`. Never
 * a step count — the name leads and this line only says when/where it runs.
 */
export function workflowRowSummary(
  workflow: Workflow,
  connectionName: (id: string) => string | undefined
): string {
  const parts: string[] = [];
  for (const trigger of workflow.triggers) {
    if (isArmedTrigger(trigger)) {
      parts.push(
        `${triggerKindLabel(trigger.kind)} · ${connectionList(trigger.connectionIds, connectionName)}`
      );
    } else if (trigger.kind === "hotkey" && trigger.binding) {
      parts.push(`${triggerKindLabel("hotkey")} ${trigger.binding}`);
    }
  }
  return parts.length > 0 ? parts.join("; ") : triggerKindLabel("manual");
}

/** What each armed trigger watches, e.g. `on output match of prod; on connect of a, b`. */
function watchedTriggers(
  workflow: Workflow,
  connectionName: (id: string) => string | undefined
): string {
  return armedTriggers(workflow)
    .map(
      (trigger) =>
        `${triggerKindLabel(trigger.kind).toLowerCase()} of ${connectionList(
          trigger.connectionIds,
          connectionName
        )}`
    )
    .join("; ");
}

/**
 * The armed indicator's accessible description (#5635), naming what each
 * armed trigger watches, e.g. `Runs automatically: on output match of prod`.
 */
export function armedDescription(
  workflow: Workflow,
  connectionName: (id: string) => string | undefined
): string {
  return `Runs automatically: ${watchedTriggers(workflow, connectionName)}`;
}

/**
 * The indicator's accessible description while the workflow is disarmed from
 * its row (#5674): its bindings are kept but none of them fires, e.g.
 * `Disarmed, will not run automatically: on output match of prod`.
 */
export function disarmedDescription(
  workflow: Workflow,
  connectionName: (id: string) => string | undefined
): string {
  return `Disarmed, will not run automatically: ${watchedTriggers(workflow, connectionName)}`;
}
