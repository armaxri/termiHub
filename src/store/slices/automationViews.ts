/**
 * Thin adapters between the single automation store and the two legacy views
 * (#5818, slice 4). The store holds `Automation`s and `AutomationRun`s only; the
 * Macros and Workflows sidebars, editors, palette entries and history panels
 * keep reading `Macro` / `Workflow` / `MacroRun` / `WorkflowRun` objects, which
 * these **pure** functions derive from it, and write back through them.
 *
 * Which view an automation shows in: an automation with only `type-keys` steps,
 * no triggers and no parameters is a macro; everything else is a workflow. An
 * automation with no steps follows its `legacy` provenance (a macro only when
 * it came from `macros.json`). Every automation shows in exactly one view.
 *
 * A run belongs to the Macros history when it carries `targetCount` (macro
 * playbacks always record it, migrated macro runs too) and to the Workflows
 * history otherwise.
 */
import type { Automation } from "@/types/generated/Automation";
import type { AutomationRun } from "@/types/generated/AutomationRun";
import type { AutomationRunOrigin } from "@/types/generated/AutomationRunOrigin";
import type { AutomationStep } from "@/types/generated/AutomationStep";
import type { Macro, MacroRun, MacroRunOrigin, MacroStep } from "@/types/macro";
import type { Workflow, WorkflowRun, WorkflowRunTrigger, WorkflowStep } from "@/types/workflow";

type TypeKeysStep = Extract<AutomationStep, { kind: "type-keys" }>;

/** Whether `automation` shows in the Macros view (see the module docs). */
export function isMacroShaped(automation: Automation): boolean {
  if (automation.triggers.length > 0 || (automation.parameters?.length ?? 0) > 0) return false;
  if (automation.steps.length === 0) return automation.legacy?.from === "macro";
  return automation.steps.every(
    (step) => step.kind === "type-keys" && !step.continueOnError && !step.retry
  );
}

/** The recorded chunks of every `type-keys` step, in order. */
function chunksOf(automation: Automation): MacroStep[] {
  return automation.steps.flatMap((step) =>
    step.kind === "type-keys" ? step.chunks.map(({ data, delayMs }) => ({ data, delayMs })) : []
  );
}

/** The macro view of a macro-shaped automation. */
export function automationToMacro(automation: Automation): Macro {
  return {
    id: automation.id,
    name: automation.name,
    description: automation.description,
    tags: automation.tags,
    steps: chunksOf(automation),
    createdAt: automation.createdAt,
    updatedAt: automation.updatedAt,
  };
}

function sameChunks(a: MacroStep[], b: MacroStep[]): boolean {
  return (
    a.length === b.length && a.every((c, i) => c.data === b[i].data && c.delayMs === b[i].delayMs)
  );
}

/**
 * The automation a macro view saves as. Untouched chunks keep the stored step
 * list as it is; edited chunks become one `type-keys` step that keeps the
 * stored step's saved timing (new macros type as recorded).
 */
export function macroToAutomation(macro: Macro, existing?: Automation): Automation {
  let steps: AutomationStep[];
  if (existing && sameChunks(chunksOf(existing), macro.steps)) {
    steps = existing.steps;
  } else if (macro.steps.length === 0) {
    steps = [];
  } else {
    const prior = existing?.steps.find((s): s is TypeKeysStep => s.kind === "type-keys");
    const step: TypeKeysStep = {
      kind: "type-keys",
      chunks: macro.steps.map(({ data, delayMs }) => ({ data, delayMs })),
      timing: prior?.timing ?? "recorded",
      recorded: prior?.recorded ?? true,
    };
    if (prior?.fixedDelayMs !== undefined) step.fixedDelayMs = prior.fixedDelayMs;
    steps = [step];
  }
  const automation: Automation = {
    id: macro.id,
    name: macro.name,
    description: macro.description,
    tags: macro.tags,
    steps,
    triggers: [],
    createdAt: macro.createdAt,
    updatedAt: macro.updatedAt,
  };
  if (existing?.legacy) automation.legacy = existing.legacy;
  return automation;
}

/** A step in the workflow view: `run-automation` reads as `run-macro`. */
function toWorkflowStep(step: AutomationStep): WorkflowStep {
  switch (step.kind) {
    case "run-automation": {
      const { automationId, kind: _kind, ...rest } = step;
      return { ...rest, kind: "run-macro", macroId: automationId };
    }
    case "conditional": {
      const { else: otherwise, ...rest } = step;
      const view: WorkflowStep = { ...rest, then: step.then.map(toWorkflowStep) };
      return otherwise ? { ...view, else: otherwise.map(toWorkflowStep) } : view;
    }
    case "loop":
      return { ...step, body: step.body.map(toWorkflowStep) };
    case "type-keys":
      // Not editable in the workflow view (slice 7 adds the editor); carried
      // through opaquely so an edit of the other steps keeps it.
      return step as unknown as WorkflowStep;
    default:
      return step;
  }
}

/** A workflow-view step saved back: `run-macro` becomes `run-automation`. */
function toAutomationStep(step: WorkflowStep): AutomationStep {
  switch (step.kind) {
    case "run-macro": {
      const { macroId, kind: _kind, ...rest } = step;
      return { ...rest, kind: "run-automation", automationId: macroId };
    }
    case "conditional": {
      const { else: otherwise, ...rest } = step;
      const saved: AutomationStep = { ...rest, then: step.then.map(toAutomationStep) };
      return otherwise ? { ...saved, else: otherwise.map(toAutomationStep) } : saved;
    }
    case "loop":
      return { ...step, body: step.body.map(toAutomationStep) };
    default:
      return step as AutomationStep;
  }
}

/**
 * The workflow view of an automation. Every automation can be run by hand, so
 * the view always carries the `manual` trigger (the chip shows on).
 */
export function automationToWorkflow(automation: Automation): Workflow {
  const workflow: Workflow = {
    id: automation.id,
    name: automation.name,
    description: automation.description,
    tags: automation.tags,
    steps: automation.steps.map(toWorkflowStep),
    triggers: [{ kind: "manual" }, ...automation.triggers],
    parameters: automation.parameters ?? [],
    createdAt: automation.createdAt,
    updatedAt: automation.updatedAt,
  };
  if (automation.triggersEnabled === false) workflow.triggersEnabled = false;
  return workflow;
}

/** The automation a workflow view saves as (`manual` has no automation kind). */
export function workflowToAutomation(workflow: Workflow, existing?: Automation): Automation {
  const automation: Automation = {
    id: workflow.id,
    name: workflow.name,
    description: workflow.description,
    tags: workflow.tags,
    steps: workflow.steps.map(toAutomationStep),
    triggers: workflow.triggers.flatMap((t) => (t.kind === "manual" ? [] : [t])),
    createdAt: workflow.createdAt,
    updatedAt: workflow.updatedAt,
  };
  if (workflow.parameters?.length) automation.parameters = workflow.parameters;
  if (workflow.triggersEnabled === false) automation.triggersEnabled = false;
  if (existing?.legacy) automation.legacy = existing.legacy;
  return automation;
}

/** The two library views of the store, in store order. */
export function libraryViews(automations: readonly Automation[]): {
  macros: Macro[];
  workflows: Workflow[];
} {
  const macros: Macro[] = [];
  const workflows: Workflow[] = [];
  for (const automation of automations) {
    if (isMacroShaped(automation)) macros.push(automationToMacro(automation));
    else workflows.push(automationToWorkflow(automation));
  }
  return { macros, workflows };
}

/** Whether a run shows in the Macros history (see the module docs). */
export function isMacroRun(run: AutomationRun): boolean {
  return run.targetCount !== undefined && run.targetCount !== null;
}

const MACRO_ORIGIN: Partial<Record<AutomationRunOrigin, MacroRunOrigin>> = {
  manual: "manual",
  palette: "palette",
  scheduled: "scheduled",
  "run-by-automation": "workflow-step",
};

/** The macro-history view of a run. */
export function automationRunToMacroRun(run: AutomationRun): MacroRun {
  const labels = run.targetLabels?.length
    ? run.targetLabels
    : run.targetLabel
      ? [run.targetLabel]
      : undefined;
  const view: MacroRun = {
    id: run.id,
    macroId: run.automationId,
    macroName: run.automationName,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    status: run.status === "failed" ? "error" : run.status,
    stepsPlayed: run.stepsCompleted,
    totalSteps: run.total,
    targetCount: run.targetCount ?? labels?.length ?? 1,
    origin: MACRO_ORIGIN[run.origin] ?? "manual",
  };
  if (labels) view.targetLabels = labels;
  if (run.error) view.error = run.error;
  return view;
}

const WORKFLOW_TRIGGER: Partial<Record<AutomationRunOrigin, WorkflowRunTrigger>> = {
  manual: "manual",
  hotkey: "hotkey",
  scheduled: "scheduled",
  "on-connect": "on-connect",
  "on-disconnect": "on-disconnect",
  "on-output-match": "on-output-match",
};

/** The workflow-history view of a run. */
export function automationRunToWorkflowRun(run: AutomationRun): WorkflowRun {
  const view: WorkflowRun = {
    id: run.id,
    workflowId: run.automationId,
    workflowName: run.automationName,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    status: run.status,
    stepsCompleted: run.stepsCompleted,
    total: run.total,
    triggeredBy: WORKFLOW_TRIGGER[run.origin] ?? "manual",
  };
  if (run.failedStepIndex !== undefined) view.failedStepIndex = run.failedStepIndex;
  if (run.error) view.error = run.error;
  if (run.continuedFailures !== undefined) view.continuedFailures = run.continuedFailures;
  if (run.tabId) view.tabId = run.tabId;
  if (run.targetLabel) view.targetLabel = run.targetLabel;
  return view;
}

/** The two history views of the store, newest first like the store. */
export function runViews(runs: readonly AutomationRun[]): {
  macroRuns: MacroRun[];
  workflowRuns: WorkflowRun[];
} {
  const macroRuns: MacroRun[] = [];
  const workflowRuns: WorkflowRun[] = [];
  for (const run of runs) {
    if (isMacroRun(run)) macroRuns.push(automationRunToMacroRun(run));
    else workflowRuns.push(automationRunToWorkflowRun(run));
  }
  return { macroRuns, workflowRuns };
}

const FROM_MACRO_ORIGIN: Record<MacroRunOrigin, AutomationRunOrigin> = {
  manual: "manual",
  palette: "palette",
  scheduled: "scheduled",
  "workflow-step": "run-by-automation",
};

/** A finished macro playback as an automation run (mirrors the Rust migration). */
export function macroRunToAutomationRun(run: MacroRun): AutomationRun {
  const record: AutomationRun = {
    id: run.id,
    automationId: run.macroId,
    automationName: run.macroName,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    status: run.status === "error" ? "failed" : run.status,
    stepsCompleted: run.stepsPlayed,
    total: run.totalSteps,
    targetCount: run.targetCount,
    origin: FROM_MACRO_ORIGIN[run.origin],
  };
  const labels = run.targetLabels ?? [];
  if (labels.length > 0) record.targetLabels = labels;
  if (labels.length === 1) record.targetLabel = labels[0];
  if (run.error) record.error = run.error;
  return record;
}

/** A finished workflow run as an automation run (mirrors the Rust migration). */
export function workflowRunToAutomationRun(run: WorkflowRun): AutomationRun {
  const record: AutomationRun = {
    id: run.id,
    automationId: run.workflowId,
    automationName: run.workflowName,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    status: run.status,
    stepsCompleted: run.stepsCompleted,
    total: run.total,
    origin: run.triggeredBy,
  };
  if (run.failedStepIndex !== undefined) record.failedStepIndex = run.failedStepIndex;
  if (run.error) record.error = run.error;
  if (run.continuedFailures !== undefined) record.continuedFailures = run.continuedFailures;
  if (run.tabId) record.tabId = run.tabId;
  if (run.targetLabel) record.targetLabel = run.targetLabel;
  return record;
}
