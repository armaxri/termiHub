/**
 * Workflow data model (#1852) — the foundation of the Workflow Automation epic
 * (#1851).
 *
 * A workflow is an *authored* (not recorded) ordered list of typed steps that
 * can be launched by one or more triggers. This mirrors the Rust model in
 * `src-tauri/src/workflows/config.rs` byte-for-byte over the wire (the Rust enums
 * are `#[serde(tag = "kind")]` with kebab-case variant names and camelCase
 * fields), so these types are the single source of truth the store, runner, and
 * later epic children build on.
 *
 * The **complete** v1 step and trigger unions are defined here up front. Only
 * `send-command` is executed by {@link "@/services/workflowRunner"} in the
 * foundation PR; the remaining kinds are typed placeholders that later children
 * fill in (#1853 run-script/run-macro/wait, #1857 run-local-process, #1855
 * trigger dispatch).
 */

/**
 * A single, typed step of a workflow. Discriminated by {@link WorkflowStep.kind};
 * every kind additionally carries the optional per-step error-handling policy
 * ({@link WorkflowStepErrorHandling}, PROD-045).
 */
export type WorkflowStep = WorkflowStepBody & WorkflowStepErrorHandling;

/**
 * Backoff strategy between retry attempts of a failing step (PROD-045):
 * `fixed` waits `delayMs` before every retry; `exponential` doubles the wait
 * after each attempt (`delayMs`, `2×delayMs`, `4×delayMs`, …), capped by the
 * runner's maximum retry delay.
 */
export type WorkflowRetryBackoff = "fixed" | "exponential";

/**
 * A bounded retry policy for a single step (PROD-045). A failing step is
 * re-attempted up to `count` more times (so it runs at most `count + 1` times),
 * waiting `delayMs` (shaped by `backoff`) between attempts. The runner clamps
 * `count` and the delay to named safety caps so a policy can never retry
 * forever or stall a run for hours. Mirrors the Rust `WorkflowStepRetry`.
 */
export interface WorkflowStepRetry {
  /** Extra attempts after the first failure (clamped to the runner's cap). */
  count: number;
  /** Delay (ms) before the first retry; absent → retry immediately. */
  delayMs?: number;
  /** How the delay grows between attempts; absent → `fixed`. */
  backoff?: WorkflowRetryBackoff;
}

/**
 * Optional per-step error handling (PROD-045), shared by every step kind. Both
 * fields are absent on a step authored before this feature, which then behaves
 * exactly as before: no retry, and the first failure stops the run.
 */
export interface WorkflowStepErrorHandling {
  /**
   * When `true`, a failure of this step (after any retries) is recorded and the
   * run continues with the next step instead of stopping. Absent → stop.
   */
  continueOnError?: boolean;
  /** Retry this step when it fails. Absent → no retry. */
  retry?: WorkflowStepRetry;
}

/** The kind-specific shape of a {@link WorkflowStep}, without the shared policy. */
export type WorkflowStepBody =
  | {
      /** Send a single authored command line into the active session. */
      kind: "send-command";
      /** The command line to send (a trailing newline is added on execution). */
      command: string;
    }
  | {
      /** Stream a saved multi-line script's text into the session, line by line. */
      kind: "run-script";
      /** The script body (one command per line). */
      script: string;
      /** Optional delay (ms) inserted between each streamed line. */
      perLineDelayMs?: number;
      /** Optional on-disk path the script body was loaded from. */
      sourcePath?: string;
    }
  | {
      /** Replay an existing stored macro by id, reusing its own timing mode. */
      kind: "run-macro";
      /** The id of the stored macro to replay. */
      macroId: string;
    }
  | {
      /** Pause for a fixed number of milliseconds before the next step. */
      kind: "wait";
      /** How long to pause, in milliseconds. */
      delayMs: number;
    }
  | {
      /** Spawn a local helper process (guarded; not on the remote host). */
      kind: "run-local-process";
      /** The local program to spawn. */
      program: string;
      /** Arguments passed to the program. */
      args: string[];
    }
  | {
      /**
       * Branch on a structured condition (PROD-0044, slice 1). When the
       * {@link WorkflowCondition} holds, the runner recurses into {@link then};
       * otherwise into {@link else} (a no-op if `else` is absent — a false
       * condition with no `else` never fails the run). `then`/`else` are
       * ordinary step lists, so conditionals nest; the runner bounds nesting
       * depth to prevent authoring loops / stack blowups.
       */
      kind: "conditional";
      /** The structured comparison that selects the branch. */
      condition: WorkflowCondition;
      /** Steps run when the condition holds. */
      then: WorkflowStep[];
      /** Steps run when the condition is false. Omitted → false is a no-op. */
      else?: WorkflowStep[];
    }
  | {
      /**
       * Repeat a `body` of steps either a fixed number of times or while a
       * structured condition holds (PROD-044). {@link WorkflowLoopMode} selects
       * which; both are bounded by the runner's max-iteration safety cap so a
       * loop can never run forever. `body` is an ordinary step list, so loops
       * nest (bounded by the runner). The runner exposes a reserved
       * `${iteration}` variable (0-based) to the body and the while-condition.
       */
      kind: "loop";
      /** How the loop is bounded: a fixed count, or a while-condition. */
      loop: WorkflowLoopMode;
      /** Steps run each iteration. */
      body: WorkflowStep[];
    }
  | {
      /**
       * Pause the run until the target session's terminal output matches
       * {@link pattern}, or {@link timeoutMs} elapses (PROD-044). The match is a
       * literal substring by default (the safer choice); set {@link isRegex} to
       * treat the pattern as a regular expression. A named default timeout
       * applies when `timeoutMs` is absent so the step can never hang forever.
       */
      kind: "wait-for-output";
      /** The pattern matched against the session's terminal output. */
      pattern: string;
      /** When `true`, `pattern` is a regular expression; otherwise a substring. */
      isRegex?: boolean;
      /** Max time (ms) to wait before the step times out (default applies if absent). */
      timeoutMs?: number;
    };

/**
 * How a `loop` {@link WorkflowStep} is bounded (PROD-044). Either a fixed
 * iteration `count`, or a structured `while` condition re-evaluated before each
 * iteration. Both are bounded by the runner's max-iteration safety cap so a
 * loop can never run forever. Discriminated by `kind`; mirrors the Rust
 * `WorkflowLoopMode` byte-for-byte over the wire (lowercase variant tags).
 */
export type WorkflowLoopMode =
  | {
      /** Repeat the body exactly `count` times (clamped to the safety cap). */
      kind: "count";
      /** The fixed number of iterations. */
      count: number;
    }
  | {
      /** Repeat the body while `condition` holds, bounded by the safety cap. */
      kind: "while";
      /** The structured comparison re-evaluated before each iteration. */
      condition: WorkflowCondition;
    };

/** The discriminant literal of a {@link WorkflowStep}. */
export type WorkflowStepKind = WorkflowStep["kind"];

/**
 * The comparison operator of a {@link WorkflowCondition} (PROD-0044). `eq`/`ne`
 * are string (in)equality; `gt`/`lt`/`gte`/`lte` compare numerically when both
 * operands parse as finite numbers and lexicographically otherwise; `contains`
 * is substring containment (`left` contains `right`). Serialised lowercase to
 * match the Rust `WorkflowComparisonOp` enum byte-for-byte over the wire.
 */
export type WorkflowComparisonOp = "eq" | "ne" | "gt" | "lt" | "gte" | "lte" | "contains";

/**
 * A structured comparator evaluated by the workflow runner (PROD-0044, slice 1).
 *
 * `left` and `right` are plain strings that may reference declared parameters as
 * `${name}` — they go through the same interpolation pass as a step's text
 * fields (PROD-0040) before the comparison, so a condition can branch on a
 * run-time parameter value. This is a **structured** comparator by design: there
 * is deliberately no bespoke expression-string parser (a maintainer decision
 * default for slice 1). Mirrors the Rust `WorkflowCondition` byte-for-byte.
 */
export interface WorkflowCondition {
  /** The left-hand operand (may reference `${param}`). */
  left: string;
  /** The comparison operator. */
  op: WorkflowComparisonOp;
  /** The right-hand operand (may reference `${param}`). */
  right: string;
}

/** A trigger that launches a workflow. Discriminated by {@link WorkflowTrigger.kind}. */
export type WorkflowTrigger =
  | {
      /** Run from the palette, the Workflow sidebar, or a toolbar button. */
      kind: "manual";
    }
  | {
      /** Fire when a session opens for one of the named connections. */
      kind: "on-connect";
      /** Connection ids this trigger is bound to. */
      connectionIds: string[];
    }
  | {
      /** Fire when a user-assigned keybinding is pressed while a session is focused. */
      kind: "hotkey";
      /** The keybinding string (e.g. `Ctrl+Alt+H`). */
      binding: string;
    };

/** The discriminant literal of a {@link WorkflowTrigger}. */
export type WorkflowTriggerKind = WorkflowTrigger["kind"];

/** The value type of a {@link WorkflowParameter}. */
export type WorkflowParameterType = "string" | "number" | "boolean" | "enum";

/**
 * A named parameter a workflow declares (PROD-0040). Parameter references of the
 * form `${name}` in a step's text fields (`send-command.command`,
 * `run-script.script`, and `run-local-process.program`/`args`) are substituted
 * with the value collected at run time. A literal `${` is written `$${`. Only
 * declared parameter names are substituted; an unknown `${x}` is left verbatim.
 *
 * Mirrors the Rust `WorkflowParameter` in
 * `src-tauri/src/workflows/config.rs` byte-for-byte over the wire (camelCase
 * fields; `type` is the wire key for {@link WorkflowParameter.type}). The whole
 * concept is additive and backward-compatible: a workflow with no `parameters`
 * key behaves and serialises exactly as before.
 */
export interface WorkflowParameter {
  /** The reference name used in `${name}` interpolations. */
  name: string;
  /** Optional human-friendly label shown in the run-time prompt (defaults to `name`). */
  label?: string;
  /** The value type, which selects the prompt control and coercion. */
  type: WorkflowParameterType;
  /** Optional default value, pre-filled in the run-time prompt. */
  default?: string | number | boolean;
  /** When `true`, the prompt requires a non-empty value before the run proceeds. */
  required?: boolean;
  /** For `type: "enum"`, the selectable string options. */
  options?: string[];
}

/**
 * The terminal state a workflow run ended in. Mirrors the runner's
 * {@link "@/services/workflowRunner".WorkflowRunStatus} and the Rust
 * `WorkflowRunStatus` enum.
 */
export type WorkflowRunHistoryStatus = "completed" | "cancelled" | "failed";

/** What launched a run. Mirrors the Rust `WorkflowRunTrigger` enum. */
export type WorkflowRunTrigger = "manual" | "on-connect" | "hotkey" | "scheduled";

/**
 * A persisted, **metadata-only** record of a finished workflow run (PROD-0046).
 * Mirrors the Rust `WorkflowRun` in `src-tauri/src/workflows/history.rs`
 * byte-for-byte over the wire (camelCase fields, string-valued enums). The run's
 * terminal output is deliberately **not** stored — only the outcome, timing, and
 * provenance needed to browse recent runs.
 */
export interface WorkflowRun {
  /** Unique identifier for this run record. */
  id: string;
  /** The id of the workflow that was run. */
  workflowId: string;
  /** The workflow's name at run time (survives a later rename/deletion). */
  workflowName: string;
  /** RFC 3339 timestamp of when the run started. */
  startedAt: string;
  /** RFC 3339 timestamp of when the run reached its terminal state. */
  endedAt: string;
  /** The terminal state the run ended in. */
  status: WorkflowRunHistoryStatus;
  /** Number of steps that completed successfully before the run ended. */
  stepsCompleted: number;
  /** Total number of steps in the workflow. */
  total: number;
  /** For a failed run: the 0-based index of the step that failed. */
  failedStepIndex?: number;
  /** For a failed run: a human-readable failure reason. */
  error?: string;
  /**
   * Number of steps that failed but were tolerated because they were marked
   * `continueOnError` (PROD-045). Absent when no step failure was tolerated.
   */
  continuedFailures?: number;
  /** The terminal tab the run targeted, when known. */
  tabId?: string;
  /** What launched the run. */
  triggeredBy: WorkflowRunTrigger;
}

/**
 * An authored, ordered list of typed steps launched by zero or more triggers.
 * Mirrors the shipped {@link "@/types/macro".Macro} shape but with a
 * discriminated step list and a trigger list.
 */
export interface Workflow {
  /** Unique workflow identifier. */
  id: string;
  /** User-friendly name for this workflow. */
  name: string;
  /** Optional free-text description. */
  description?: string;
  /** Tags for grouping/filtering in the manager UI. */
  tags: string[];
  /** The ordered steps that make up this workflow. */
  steps: WorkflowStep[];
  /** The triggers that can launch this workflow. */
  triggers: WorkflowTrigger[];
  /**
   * Optional declared parameters (PROD-0040) interpolated into step text fields
   * via `${name}`. Absent/empty on a workflow that uses no parameters, which
   * then behaves and serialises byte-identically to before this feature.
   */
  parameters?: WorkflowParameter[];
  /** RFC 3339 timestamp of when the workflow was first created. */
  createdAt: string;
  /** RFC 3339 timestamp of the workflow's last update. */
  updatedAt: string;
}
