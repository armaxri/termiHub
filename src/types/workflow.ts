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

/** A single, typed step of a workflow. Discriminated by {@link WorkflowStep.kind}. */
export type WorkflowStep =
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
    };

/** The discriminant literal of a {@link WorkflowStep}. */
export type WorkflowStepKind = WorkflowStep["kind"];

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
  /** RFC 3339 timestamp of when the workflow was first created. */
  createdAt: string;
  /** RFC 3339 timestamp of the workflow's last update. */
  updatedAt: string;
}
