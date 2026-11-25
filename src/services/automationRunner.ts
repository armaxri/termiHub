/**
 * Automation run engine (#5818, slice 3 of the Automations merge).
 *
 * An automation runs on the **same engine** as a workflow: this module adds no
 * scheduler of its own. {@link runAutomation} hands the automation's steps to
 * {@link "@/services/workflowRunner".runWorkflow}, which executes the two
 * automation-only step kinds (`type-keys`, `run-automation`) next to every
 * workflow step kind. What this module adds:
 *
 * - **A pre-flight cycle check.** Before a single key is typed,
 *   {@link findAutomationCycle} walks the `run-automation` references reachable
 *   from the automation (including inside conditionals and loops). A cycle fails
 *   the run at once with the path, instead of typing half of it and failing
 *   mid-way. The runner's own call-chain guard and depth cap stay as the backstop
 *   (an automation edited while the run is going, or a long chain).
 * - **Independent per-target runs.** {@link runAutomationOnTargets} runs one
 *   automation on several terminals as independent runs, at most
 *   `WORKFLOW_FANOUT_CONCURRENCY` (8) at once, or one after another. This
 *   replaces the lock-step macro fan-out for automations (concept risk R3): a
 *   target that fails or drops ends only its own run.
 *
 * Input reaches terminals only through the `send` seam the caller binds to each
 * target, which is the same `send_input` injector macros use today. Local, SSH,
 * serial, telnet and agent-hosted sessions therefore all work without any
 * protocol change.
 */
import { clampFanoutConcurrency, runWithConcurrency } from "@/store/slices/workflowFanout";
import {
  describeAutomationCycle,
  runWorkflow,
  type RunnableStep,
  type WorkflowParamValues,
  type WorkflowRunHandle,
  type WorkflowRunHooks,
  type WorkflowRunnerDeps,
  type WorkflowRunResult,
} from "@/services/workflowRunner";
import type { Automation } from "@/types/generated/Automation";

/** A `run-automation` cycle found before a run starts. */
export interface AutomationCycle {
  /** The automation ids of the cycle, starting and ending with the same id. */
  path: string[];
  /** The 0-based index of the root automation's top-level step that leads into it. */
  stepIndex: number;
}

/** Visit every step, nested ones included, depth first, in step order. */
function visitSteps(steps: readonly RunnableStep[], visit: (step: RunnableStep) => void): void {
  for (const step of steps) {
    visit(step);
    if (step.kind === "conditional") {
      visitSteps(step.then, visit);
      visitSteps(step.else ?? [], visit);
    } else if (step.kind === "loop") {
      visitSteps(step.body, visit);
    }
  }
}

/** Every automation id a step list references, depth first, in step order. */
export function referencedAutomations(steps: readonly RunnableStep[]): string[] {
  const ids: string[] = [];
  visitSteps(steps, (step) => {
    if (step.kind === "run-automation") ids.push(step.automationId);
  });
  return ids;
}

/**
 * Whether running `root` can reach a `run-local-process` step: its own, one
 * nested in a conditional branch or a loop, or one of an automation it calls
 * (#5818). Every branch counts. Each automation is visited once, so a cycle
 * ends the walk; missing automations are skipped. A **pure** helper.
 */
export function reachesLocalProcess(
  root: Automation,
  resolve: (id: string) => Automation | undefined
): boolean {
  const seen = new Set<string>([root.id]);
  const queue: Automation[] = [root];
  for (let next = queue.pop(); next; next = queue.pop()) {
    let found = false;
    visitSteps(next.steps, (step) => {
      if (step.kind === "run-local-process") found = true;
    });
    if (found) return true;
    for (const id of referencedAutomations(next.steps)) {
      if (seen.has(id)) continue;
      seen.add(id);
      const called = resolve(id);
      if (called) queue.push(called);
    }
  }
  return false;
}

/** Every step kind the runner executes; one it misses fails to compile. */
const RUNNABLE_KIND_MAP: Record<RunnableStep["kind"], true> = {
  "type-keys": true,
  "send-command": true,
  "run-script": true,
  "run-automation": true,
  wait: true,
  "run-local-process": true,
  conditional: true,
  loop: true,
  "wait-for-output": true,
};
/** A set: `in` would also find what every object inherits. */
const RUNNABLE_KINDS: ReadonlySet<string> = new Set(Object.keys(RUNNABLE_KIND_MAP));

/** A step of a kind this build does not know, found before a run starts. */
export interface UnknownStepFound {
  /** The unknown kind. */
  kind: string;
  /** The name of the automation that holds it. */
  automation: string;
  /** The 0-based index of the root automation's top-level step that leads to it. */
  stepIndex: number;
}

/**
 * Find a step of an unknown kind that running `root` could reach (#6009): a
 * newer termiHub wrote it, and this one can neither run nor skip it. Nested
 * steps and called automations count, whichever branch they sit in; each
 * automation is visited once. A **pure** helper.
 */
function findUnknownStep(
  root: Automation,
  resolve: (id: string) => Automation | undefined
): UnknownStepFound | null {
  for (const [stepIndex, top] of root.steps.entries()) {
    const seen = new Set<string>([root.id]);
    const queue: { name: string; steps: readonly RunnableStep[] }[] = [
      { name: root.name, steps: [top] },
    ];
    for (let next = queue.pop(); next; next = queue.pop()) {
      let kind: string | undefined;
      visitSteps(next.steps, (step) => {
        if (!RUNNABLE_KINDS.has(step.kind)) kind ??= step.kind;
      });
      if (kind !== undefined) return { kind, automation: next.name, stepIndex };
      for (const id of referencedAutomations(next.steps)) {
        if (seen.has(id)) continue;
        seen.add(id);
        const called = resolve(id);
        if (called) queue.push(called);
      }
    }
  }
  return null;
}

/**
 * Find a `run-automation` cycle reachable from `root` (#5818), or `null` when
 * there is none. Every reference counts, whichever conditional branch it sits
 * in: a cycle that only one branch reaches is still an authoring error, and the
 * run must not depend on which way a condition goes. Missing automations are
 * skipped here (the runner fails the step that calls one). A **pure** helper.
 */
export function findAutomationCycle(
  root: Automation,
  resolve: (id: string) => Automation | undefined
): AutomationCycle | null {
  // Ids proven to reach no cycle, so a diamond-shaped graph is walked once.
  const clean = new Set<string>();
  const walk = (id: string, chain: string[]): string[] | null => {
    if (chain.includes(id)) return [...chain.slice(chain.indexOf(id)), id];
    if (clean.has(id)) return null;
    const automation = resolve(id);
    if (!automation) return null;
    const next = [...chain, id];
    for (const ref of referencedAutomations(automation.steps)) {
      const cycle = walk(ref, next);
      if (cycle) return cycle;
    }
    clean.add(id);
    return null;
  };

  for (let i = 0; i < root.steps.length; i++) {
    for (const ref of referencedAutomations([root.steps[i]])) {
      const path = walk(ref, [root.id]);
      if (path) return { path, stepIndex: i };
    }
  }
  return null;
}

/** A run that failed before it started, as a handle. */
function failedHandle(result: WorkflowRunResult): WorkflowRunHandle {
  return { done: Promise.resolve(result), cancel: () => {} };
}

/**
 * Run one automation against the target `deps` is bound to (#5818). The
 * automation's own id seeds the call chain, so it cannot call itself. A
 * `run-automation` cycle or a step of an unknown kind anywhere below it fails
 * the run before any step runs, with `failedStepIndex` naming the top-level step that leads into it.
 */
export function runAutomation(
  automation: Automation,
  deps: WorkflowRunnerDeps,
  hooks?: WorkflowRunHooks,
  paramValues?: WorkflowParamValues
): WorkflowRunHandle {
  const lookup = deps.resolveAutomation ?? (() => undefined);
  const cycle = findAutomationCycle(automation, lookup);
  if (cycle) {
    return failedHandle({
      status: "failed",
      stepsCompleted: 0,
      failedStepIndex: cycle.stepIndex,
      error: `automation calls itself: ${describeAutomationCycle(cycle.path, deps)}`,
    });
  }
  const unknown = findUnknownStep(automation, lookup);
  if (unknown) {
    return failedHandle({
      status: "failed",
      stepsCompleted: 0,
      failedStepIndex: unknown.stepIndex,
      error:
        `"${unknown.automation}" has a step this version of termiHub does not know ` +
        `("${unknown.kind}"), so nothing was run. Update termiHub to run it.`,
    });
  }
  return runWorkflow(automation.steps, deps, hooks, paramValues, {
    callChain: [automation.id],
  });
}

/** Options of a run on several targets. */
export interface AutomationFanoutOptions {
  /**
   * Run the targets at the same time (the default), at most
   * `WORKFLOW_FANOUT_CONCURRENCY` (8) at once. `false` runs them one after
   * another.
   */
  parallel?: boolean;
  /** Parameter values, asked once and shared by every target. */
  paramValues?: WorkflowParamValues;
  /** Hooks for one target's run; called with the target's index. */
  hooksFor?: (index: number) => WorkflowRunHooks | undefined;
  /** Called when a target's run starts, with its index. */
  onTargetStart?: (index: number) => void;
  /**
   * Called when one target's run ends, with its index and result, as soon as
   * it ends (not when the slowest target ends).
   */
  onTargetEnd?: (index: number, result: WorkflowRunResult) => void;
}

/** A run of one automation on several targets. */
export interface AutomationFanoutHandle {
  /**
   * Resolves once every started run has ended, with each target's result by
   * index. A target that never started (the fan-out was stopped first) has
   * `undefined`.
   */
  done: Promise<(WorkflowRunResult | undefined)[]>;
  /** Cancel one target's run; a no-op when it has not started or has ended. */
  cancel: (index: number) => void;
  /** Cancel every running target and start no queued one ("Stop all"). */
  cancelAll: () => void;
}

/**
 * Run `automation` on each of `targets` as an independent run (#5818).
 * `depsFor` binds the runner's seams to one target (its `send` seam is that
 * terminal's input injector). Each target has its own cancel, retries and
 * outcome: one failing or dropping target does not stop the others.
 */
export function runAutomationOnTargets<T>(
  automation: Automation,
  targets: readonly T[],
  depsFor: (target: T, index: number) => WorkflowRunnerDeps,
  options: AutomationFanoutOptions = {}
): AutomationFanoutHandle {
  const handles = new Map<number, WorkflowRunHandle>();
  let stopped = false;
  const limit = options.parallel === false ? 1 : clampFanoutConcurrency(undefined);

  const done = runWithConcurrency(
    targets,
    limit,
    async (target, index) => {
      const handle = runAutomation(
        automation,
        depsFor(target, index),
        options.hooksFor?.(index),
        options.paramValues
      );
      handles.set(index, handle);
      options.onTargetStart?.(index);
      try {
        const result = await handle.done;
        options.onTargetEnd?.(index, result);
        return result;
      } finally {
        handles.delete(index);
      }
    },
    () => stopped
  );

  return {
    done,
    cancel: (index) => handles.get(index)?.cancel(),
    cancelAll: () => {
      stopped = true;
      for (const handle of handles.values()) handle.cancel();
    },
  };
}
