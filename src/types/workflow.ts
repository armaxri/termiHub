/**
 * Workflow data model (#1852) — the foundation of the Workflow Automation epic
 * (#1851).
 *
 * A workflow is an *authored* (not recorded) ordered list of typed steps that
 * can be launched by one or more triggers. The wire types are generated from
 * their Rust source of truth (`src-tauri/src/workflows/{config,history}.rs`) via
 * ts-rs (audit DUP-030, ts-rs rollout #3088), so the frontend cannot drift from
 * the backend's `#[serde(tag = "kind")]` kebab-case / camelCase shapes.
 */

import type { WorkflowStep } from "./generated/WorkflowStep";
import type { WorkflowStepErrorHandling } from "./generated/WorkflowStepErrorHandling";
import type { WorkflowTrigger } from "./generated/WorkflowTrigger";

export type { WorkflowStep, WorkflowStepErrorHandling, WorkflowTrigger };
export type { WorkflowRetryBackoff } from "./generated/WorkflowRetryBackoff";
export type { WorkflowStepRetry } from "./generated/WorkflowStepRetry";
export type { WorkflowLoopMode } from "./generated/WorkflowLoopMode";
export type { WorkflowComparisonOp } from "./generated/WorkflowComparisonOp";
export type { WorkflowCondition } from "./generated/WorkflowCondition";
export type { WorkflowDisconnectCause } from "./generated/WorkflowDisconnectCause";
export type { WorkflowParameterType } from "./generated/WorkflowParameterType";
export type { WorkflowParameter } from "./generated/WorkflowParameter";
export type { WorkflowRunHistoryStatus } from "./generated/WorkflowRunHistoryStatus";
export type { WorkflowRunTrigger } from "./generated/WorkflowRunTrigger";
export type { WorkflowRun } from "./generated/WorkflowRun";
export type { Workflow } from "./generated/Workflow";

/** `Omit` that distributes over each member of a union. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/**
 * The kind-specific body of a {@link WorkflowStep}, without the per-step
 * error-handling policy ({@link WorkflowStepErrorHandling}, PROD-045) that every
 * kind carries. Rust flattens the policy into each step variant, so the
 * generated step is `WorkflowStepBody & WorkflowStepErrorHandling`.
 */
export type WorkflowStepBody = DistributiveOmit<WorkflowStep, keyof WorkflowStepErrorHandling>;

/** All step discriminants. */
export type WorkflowStepKind = WorkflowStep["kind"];

/** All trigger discriminants. */
export type WorkflowTriggerKind = WorkflowTrigger["kind"];
