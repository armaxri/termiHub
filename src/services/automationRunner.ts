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

/** Every automation id a step list references, depth first, in step order. */
function referencedAutomations(steps: readonly RunnableStep[]): string[] {
  const ids: string[] = [];
  const visit = (list: readonly RunnableStep[]): void => {
    for (const step of list) {
      switch (step.kind) {
        case "run-automation":
          ids.push(step.automationId);
          break;
        case "conditional":
          visit(step.then);
          visit(step.else ?? []);
          break;
        case "loop":
          visit(step.body);
          break;
        default:
          break;
      }
    }
  };
  visit(steps);
  return ids;
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
 * `run-automation` cycle anywhere below it fails the run before any step runs,
 * with `failedStepIndex` naming the top-level step that leads into it.
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
        return await handle.done;
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
