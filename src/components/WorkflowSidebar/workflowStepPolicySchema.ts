/**
 * Client-side validation for a workflow step's error-handling policy (PROD-045):
 * `continueOnError` and the bounded `retry` policy. The editor AND-s
 * {@link workflowStepsPolicyValid} into its Save gate and shows
 * {@link stepPolicyErrors} inline, so a policy outside the runner's safety caps
 * can never be saved from the UI. (The runner clamps regardless — this is UX
 * feedback, not the safety boundary.)
 */
import { z } from "zod";

import { MAX_RETRY_DELAY_MS, MAX_STEP_RETRIES } from "@/services/workflowRunner";
import type { WorkflowStep, WorkflowStepRetry } from "@/types/workflow";

/** The retry policy a freshly enabled "Retry on failure" toggle starts with. */
export const DEFAULT_STEP_RETRY: WorkflowStepRetry = { count: 3, delayMs: 1000, backoff: "fixed" };

/**
 * Schema for a step's error-handling fields. Shape checks come from the object
 * schema; the bounds (whole number of retries in `[1, MAX_STEP_RETRIES]`, delay
 * in `[0, MAX_RETRY_DELAY_MS]`) are enforced in `superRefine` so each violation
 * carries a user-facing message.
 */
export const workflowStepPolicySchema = z
  .object({
    continueOnError: z.boolean().optional(),
    retry: z
      .object({
        count: z.number(),
        delayMs: z.number().optional(),
        backoff: z.enum(["fixed", "exponential"]).optional(),
      })
      .optional(),
  })
  .superRefine((policy, ctx) => {
    const retry = policy.retry;
    if (!retry) return;
    if (!Number.isInteger(retry.count) || retry.count < 1 || retry.count > MAX_STEP_RETRIES) {
      ctx.addIssue({
        code: "custom",
        path: ["retry", "count"],
        message: `Retries must be a whole number from 1 to ${MAX_STEP_RETRIES}.`,
      });
    }
    if (
      retry.delayMs !== undefined &&
      (!Number.isFinite(retry.delayMs) || retry.delayMs < 0 || retry.delayMs > MAX_RETRY_DELAY_MS)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["retry", "delayMs"],
        message: `Retry delay must be between 0 and ${MAX_RETRY_DELAY_MS} ms.`,
      });
    }
  });

/** Validation messages for a step's own policy, keyed by the offending field. */
export interface StepPolicyErrors {
  /** Message for the retry count, when invalid. */
  count?: string;
  /** Message for the retry delay, when invalid. */
  delayMs?: string;
  /** Message for any other (shape) problem, when invalid. */
  other?: string;
}

/** Validate `step`'s own policy; an empty object means it is valid. */
export function stepPolicyErrors(step: WorkflowStep): StepPolicyErrors {
  const result = workflowStepPolicySchema.safeParse({
    continueOnError: step.continueOnError,
    retry: step.retry,
  });
  if (result.success) return {};
  const errors: StepPolicyErrors = {};
  for (const issue of result.error.issues) {
    const field = issue.path[issue.path.length - 1];
    const key = field === "count" || field === "delayMs" ? field : "other";
    errors[key] ??= issue.message;
  }
  return errors;
}

/** `true` when `step`'s own policy (not its nested steps) is valid. */
export function stepPolicyValid(step: WorkflowStep): boolean {
  return Object.keys(stepPolicyErrors(step)).length === 0;
}

/** The nested step lists a step owns (conditional branches, loop body). */
function childSteps(step: WorkflowStep): WorkflowStep[] {
  switch (step.kind) {
    case "conditional":
      return [...step.then, ...(step.else ?? [])];
    case "loop":
      return step.body;
    default:
      return [];
  }
}

/** `true` when every step (recursively, including nested steps) has a valid policy. */
export function workflowStepsPolicyValid(steps: WorkflowStep[]): boolean {
  return steps.every((step) => stepPolicyValid(step) && workflowStepsPolicyValid(childSteps(step)));
}
