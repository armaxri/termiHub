/**
 * Zod schemas for the workflow domain model (#4386, LIBFE2-007).
 *
 * One declarative description of {@link WorkflowStep}, {@link WorkflowTrigger},
 * {@link WorkflowParameter} and {@link Workflow}, used to validate **untrusted**
 * imported workflow files (`services/workflowIo.ts`) and shared with the
 * editor's step-policy schema (`workflowStepPolicySchema.ts`).
 *
 * The schemas carry **no user-facing messages**: the import layer maps each zod
 * issue (by its path and the offending value) to its own human-readable error,
 * so the editor can reuse the same shapes with its own wording.
 *
 * ## Strictness
 *
 * - Every field of every step / trigger / parameter kind is type-checked.
 * - **Unknown keys are stripped** (zod's default object mode), exactly as the
 *   hand-written validators did by copying only the known fields: a forged
 *   extra key (for example a fake "already confirmed" marker) never survives an
 *   import, and a file written by a newer build that adds a key still imports.
 * - Numbers are finite (zod 4 rejects `Infinity`/`NaN`), which JSON cannot
 *   express anyway.
 *
 * ## Drift guard
 *
 * Each object schema is checked at compile time to infer **exactly** the
 * generated TypeScript type of its kind (see `AssertExact` below). Adding a
 * field — optional or not — to a step, trigger, parameter or the workflow in
 * the Rust model regenerates the TypeScript type and fails `tsc` here until the
 * schema covers it, so a new field can no longer be silently dropped on import.
 */
import { z } from "zod";

import { validateOutputPattern } from "@/services/workflowOutputTriggers";
import type {
  Workflow,
  WorkflowCondition,
  WorkflowLoopMode,
  WorkflowParameter,
  WorkflowStep,
  WorkflowStepRetry,
  WorkflowTrigger,
} from "@/types/workflow";

// ---------------------------------------------------------------------------
// Compile-time exactness check
// ---------------------------------------------------------------------------

/** `true` only when `A` and `B` are the identical type (not merely assignable). */
type Exact<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

/**
 * Compiles only when `T` is `true`. Used as `const _x: AssertExact<…> = true`
 * so a schema whose inferred output drifts from the generated type is a `tsc`
 * error rather than a silent import bug.
 */
type AssertExact<A, B> = Exact<A, B> extends true ? true : never;

/** The variant of `U` whose `kind` is `K`. */
type KindOf<U, K> = Extract<U, { kind: K }>;

// ---------------------------------------------------------------------------
// Shared building blocks
// ---------------------------------------------------------------------------

/** A finite, non-negative number (delays, timeouts, counts, cooldowns). */
const nonNegative = () => z.number().min(0);

/** The retry backoff modes (PROD-045). */
export const workflowRetryBackoffSchema = z.enum(["fixed", "exponential"]);

/**
 * The bare retry-policy shape (field types only, no bounds). The editor builds
 * on this and adds its own user-facing bounds; the import schema below
 * tightens it to the runner's structural invariants.
 */
export const workflowStepRetryShape = {
  count: z.number(),
  delayMs: z.number().optional(),
  backoff: workflowRetryBackoffSchema.optional(),
};

/**
 * A step's retry policy as accepted from a file: a whole, non-negative retry
 * count and a non-negative delay. Values above the runner's safety caps are
 * accepted here — the runner clamps them at run time.
 */
export const workflowStepRetrySchema = z.object({
  ...workflowStepRetryShape,
  count: z.number().int().min(0),
  delayMs: nonNegative().optional(),
});
const _retryExact: AssertExact<z.output<typeof workflowStepRetrySchema>, WorkflowStepRetry> = true;

/** The error-handling fields every step kind carries (PROD-045). */
const stepPolicyShape = {
  continueOnError: z.boolean().optional(),
  retry: workflowStepRetrySchema.optional(),
};

/**
 * A structured condition (PROD-0044). `right` precedes `op` so a file with bad
 * operands reports that before a bad operator, as the hand-written check did.
 */
export const workflowConditionSchema = z.object({
  left: z.string(),
  right: z.string(),
  op: z.enum(["eq", "ne", "gt", "lt", "gte", "lte", "contains"]),
});
const _conditionExact: AssertExact<
  z.output<typeof workflowConditionSchema>,
  WorkflowCondition
> = true;

/** A loop's mode: a fixed `count` or a `while` condition (PROD-044). */
export const workflowLoopModeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("count"), count: nonNegative() }),
  z.object({ kind: z.literal("while"), condition: workflowConditionSchema }),
]);
const _loopExact: AssertExact<z.output<typeof workflowLoopModeSchema>, WorkflowLoopMode> = true;

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

/** A nested step list (conditional branches, loop body) — recursive. */
const nestedSteps = () => z.array(z.lazy(() => workflowStepSchema));

const sendCommandStep = z.object({
  kind: z.literal("send-command"),
  command: z.string(),
  ...stepPolicyShape,
});
const runScriptStep = z.object({
  kind: z.literal("run-script"),
  script: z.string(),
  perLineDelayMs: nonNegative().optional(),
  sourcePath: z.string().optional(),
  ...stepPolicyShape,
});
const runMacroStep = z.object({
  kind: z.literal("run-macro"),
  macroId: z.string(),
  ...stepPolicyShape,
});
const waitStep = z.object({
  kind: z.literal("wait"),
  delayMs: nonNegative(),
  ...stepPolicyShape,
});
const runLocalProcessStep = z.object({
  kind: z.literal("run-local-process"),
  program: z.string(),
  args: z.array(z.string()),
  ...stepPolicyShape,
});
const conditionalStep = z.object({
  kind: z.literal("conditional"),
  condition: workflowConditionSchema,
  then: nestedSteps(),
  else: nestedSteps().optional(),
  ...stepPolicyShape,
});
const loopStep = z.object({
  kind: z.literal("loop"),
  loop: workflowLoopModeSchema,
  // A missing body imports as an empty loop, as before.
  body: nestedSteps().default([]),
  ...stepPolicyShape,
});
const waitForOutputStep = z.object({
  kind: z.literal("wait-for-output"),
  pattern: z.string(),
  isRegex: z.boolean().optional(),
  timeoutMs: nonNegative().optional(),
  ...stepPolicyShape,
});

/* Each step kind's schema must infer exactly its generated type (drift guard). */
type StepOut<S extends z.ZodType> = z.output<S>;
const _sendCommandExact: AssertExact<
  StepOut<typeof sendCommandStep>,
  KindOf<WorkflowStep, "send-command">
> = true;
const _runScriptExact: AssertExact<
  StepOut<typeof runScriptStep>,
  KindOf<WorkflowStep, "run-script">
> = true;
const _runMacroExact: AssertExact<
  StepOut<typeof runMacroStep>,
  KindOf<WorkflowStep, "run-macro">
> = true;
const _waitExact: AssertExact<StepOut<typeof waitStep>, KindOf<WorkflowStep, "wait">> = true;
const _runLocalProcessExact: AssertExact<
  StepOut<typeof runLocalProcessStep>,
  KindOf<WorkflowStep, "run-local-process">
> = true;
const _conditionalExact: AssertExact<
  StepOut<typeof conditionalStep>,
  KindOf<WorkflowStep, "conditional">
> = true;
const _loopStepExact: AssertExact<StepOut<typeof loopStep>, KindOf<WorkflowStep, "loop">> = true;
const _waitForOutputExact: AssertExact<
  StepOut<typeof waitForOutputStep>,
  KindOf<WorkflowStep, "wait-for-output">
> = true;

const stepOptions = [
  sendCommandStep,
  runScriptStep,
  runMacroStep,
  waitStep,
  runLocalProcessStep,
  conditionalStep,
  loopStep,
  waitForOutputStep,
] as const;

/* Every step kind has a schema, and no schema exists for a kind that does not. */
const _stepKindsExact: AssertExact<
  z.output<(typeof stepOptions)[number]>["kind"],
  WorkflowStep["kind"]
> = true;

/** One workflow step — a discriminated union on `kind`, recursive via containers. */
export const workflowStepSchema: z.ZodType<WorkflowStep> = z.discriminatedUnion(
  "kind",
  stepOptions
);

// ---------------------------------------------------------------------------
// Triggers
// ---------------------------------------------------------------------------

const connectionIds = () => z.array(z.string());

const manualTrigger = z.object({ kind: z.literal("manual") });
const onConnectTrigger = z.object({
  kind: z.literal("on-connect"),
  connectionIds: connectionIds(),
});
const hotkeyTrigger = z.object({ kind: z.literal("hotkey"), binding: z.string() });
const onDisconnectTrigger = z.object({
  kind: z.literal("on-disconnect"),
  connectionIds: connectionIds(),
  when: z.enum(["drop", "user-close", "any"]).optional(),
});
const onOutputMatchTrigger = z
  .object({
    kind: z.literal("on-output-match"),
    connectionIds: connectionIds(),
    pattern: z.string(),
    isRegex: z.boolean().optional(),
    cooldownMs: nonNegative().optional(),
    maxFiresPerSession: nonNegative().optional(),
  })
  .superRefine((trigger, ctx) => {
    // An invalid or unbounded pattern is rejected here, never stored. The
    // issue message is the bare reason; the import layer words the error.
    const reason = validateOutputPattern(trigger.pattern, trigger.isRegex);
    if (reason) ctx.addIssue({ code: "custom", path: ["pattern"], message: reason });
  });

const _manualExact: AssertExact<
  z.output<typeof manualTrigger>,
  KindOf<WorkflowTrigger, "manual">
> = true;
const _onConnectExact: AssertExact<
  z.output<typeof onConnectTrigger>,
  KindOf<WorkflowTrigger, "on-connect">
> = true;
const _hotkeyExact: AssertExact<
  z.output<typeof hotkeyTrigger>,
  KindOf<WorkflowTrigger, "hotkey">
> = true;
const _onDisconnectExact: AssertExact<
  z.output<typeof onDisconnectTrigger>,
  KindOf<WorkflowTrigger, "on-disconnect">
> = true;
const _onOutputMatchExact: AssertExact<
  z.output<typeof onOutputMatchTrigger>,
  KindOf<WorkflowTrigger, "on-output-match">
> = true;

const triggerOptions = [
  manualTrigger,
  onConnectTrigger,
  hotkeyTrigger,
  onDisconnectTrigger,
  onOutputMatchTrigger,
] as const;

const _triggerKindsExact: AssertExact<
  z.output<(typeof triggerOptions)[number]>["kind"],
  WorkflowTrigger["kind"]
> = true;

/** One workflow trigger — a discriminated union on `kind`. */
export const workflowTriggerSchema = z.discriminatedUnion("kind", triggerOptions);

// ---------------------------------------------------------------------------
// Parameters and the workflow itself
// ---------------------------------------------------------------------------

/** A string with at least one non-whitespace character (names). */
const nonBlank = () => z.string().refine((s) => s.trim() !== "");

/** One declared workflow parameter (PROD-0040). */
export const workflowParameterSchema = z.object({
  name: nonBlank(),
  type: z.enum(["string", "number", "boolean", "enum"]),
  label: z.string().optional(),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  required: z.boolean().optional(),
  options: z.array(z.string()).optional(),
});
const _parameterExact: AssertExact<
  z.output<typeof workflowParameterSchema>,
  WorkflowParameter
> = true;

/**
 * One workflow as read from an imported file. Tolerant of a missing or
 * non-string `id`/`description`/timestamps (the importer re-stamps those) and of
 * missing `tags`/`triggers`/`parameters`, but strict about the load-bearing
 * `name`, `steps`, `triggers`, `tags` and `parameters` when present. Key order
 * is the order errors are reported in.
 */
export const importedWorkflowSchema = z.object({
  name: nonBlank(),
  steps: z.array(workflowStepSchema),
  triggers: z.array(workflowTriggerSchema).default([]),
  tags: z.array(z.string()).default([]),
  parameters: z.array(workflowParameterSchema).optional(),
  id: z.string().catch(""),
  description: z.string().optional().catch(undefined),
  createdAt: z.string().catch(""),
  updatedAt: z.string().catch(""),
});
const _workflowExact: AssertExact<z.output<typeof importedWorkflowSchema>, Workflow> = true;

/* Reference the compile-time guards so `noUnusedLocals`/eslint stay quiet. */
void [
  _retryExact,
  _conditionExact,
  _loopExact,
  _sendCommandExact,
  _runScriptExact,
  _runMacroExact,
  _waitExact,
  _runLocalProcessExact,
  _conditionalExact,
  _loopStepExact,
  _waitForOutputExact,
  _stepKindsExact,
  _manualExact,
  _onConnectExact,
  _hotkeyExact,
  _onDisconnectExact,
  _onOutputMatchExact,
  _triggerKindsExact,
  _parameterExact,
  _workflowExact,
];
