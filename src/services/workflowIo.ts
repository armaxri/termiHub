/**
 * Import/export of workflows as portable JSON files (#1852 foundation; the
 * file-dialog UI that drives these is #1856).
 *
 * Pure helpers: serialising workflows into a small versioned envelope,
 * validating/parsing an envelope back into workflows (declaratively, with the
 * zod schemas in {@link "@/services/workflowSchema"}, #4386), and
 * resolving id/name collisions when merging imported workflows into an existing
 * library. Mirrors {@link "@/services/macroIo"}; keeping the
 * serialise/validate/collision logic here makes it unit-testable in isolation.
 */

import type {
  Workflow,
  WorkflowParameter,
  WorkflowStep,
  WorkflowStepKind,
  WorkflowTrigger,
  WorkflowTriggerKind,
} from "@/types/workflow";
import {
  child,
  type ImportIssue,
  isNonBlankString,
  isRecord,
  parseImportEnvelope,
} from "@/services/importEnvelope";
import { newId } from "@/services/transport/ids";
import { importedWorkflowSchema } from "@/services/workflowSchema";

/**
 * Current version of the workflow export envelope. Bump only on an incompatible
 * change to the on-disk shape; the parser rejects any other version so a newer
 * file fails loudly rather than importing as a corrupt workflow.
 */
export const WORKFLOW_EXPORT_VERSION = 1;

/**
 * The stable, explicit on-disk shape for exported workflows. A versioned wrapper
 * around the workflow list — deliberately NOT the raw internal store — so the
 * file format can evolve independently of the runtime {@link Workflow} type.
 */
export interface WorkflowExportEnvelope {
  /** Envelope schema version; see {@link WORKFLOW_EXPORT_VERSION}. */
  version: number;
  /** The exported workflows. */
  workflows: Workflow[];
}

/** Suffix appended to imported workflow names that collide with an existing one. */
const COLLISION_SUFFIX = "imported";

/**
 * The outcome of importing a workflow file, surfaced to the user (#1856).
 *
 * Beyond the plain count, this makes the **security-sensitive** part explicit:
 * how many imported workflows carry a `run-local-process` step. Such steps are
 * **preserved, not stripped** on import (so #1857's run-time guard applies), but
 * they are **never auto-authorized** — the runner refuses to spawn them until the
 * user explicitly enables the step. The counts let the sidebar flag them rather
 * than silently trust an imported file.
 */
export interface WorkflowImportResult {
  /** Number of workflows merged into the library. */
  imported: number;
  /** How many imported workflows contain at least one `run-local-process` step. */
  workflowsWithLocalProcess: number;
  /** Total `run-local-process` steps across all imported workflows. */
  localProcessSteps: number;
  /**
   * Local file paths that imported `run-script` steps referenced through
   * `sourcePath` and that were **removed** on import (#4310, FEC2-001). An
   * imported file must not decide which local file a step reads, so the step
   * keeps only its visible script; the user re-picks the file to load from disk.
   */
  removedScriptSourcePaths: string[];
}

/**
 * Serialise workflows into a pretty-printed export envelope string ready to
 * write to a `.json` file. Works for a single workflow (`[workflow]`) or the
 * whole library.
 */
export function serializeWorkflows(workflows: Workflow[]): string {
  const envelope: WorkflowExportEnvelope = {
    version: WORKFLOW_EXPORT_VERSION,
    workflows,
  };
  return `${JSON.stringify(envelope, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// Human-readable error mapping for the zod import schema
// ---------------------------------------------------------------------------

/** The kind-specific fields of step kind `K` (the policy fields are shared). */
type StepFieldOf<K extends WorkflowStepKind> = Exclude<
  keyof Extract<WorkflowStep, { kind: K }>,
  "kind" | "continueOnError" | "retry"
>;

/**
 * What is wrong when a step's kind-specific field fails validation. Typed so a
 * new field on any step kind is a compile error until it has a message.
 */
const STEP_FIELD_PROBLEMS: { [K in WorkflowStepKind]: Record<StepFieldOf<K>, string> } = {
  "send-command": { command: 'is missing "command".' },
  "run-script": {
    script: 'is missing "script".',
    perLineDelayMs: "has an invalid delay.",
    sourcePath: "has an invalid sourcePath.",
  },
  "run-macro": { macroId: 'is missing "macroId".' },
  wait: { delayMs: 'has an invalid "delayMs".' },
  "run-local-process": { program: 'is missing "program".', args: 'has invalid "args".' },
  conditional: {
    condition: 'is missing "condition".',
    then: 'is missing "then".',
    else: 'has an invalid "else".',
  },
  loop: { loop: 'has an invalid "loop" mode.', body: 'has an invalid "body".' },
  "wait-for-output": {
    pattern: 'is missing "pattern".',
    isRegex: 'has an invalid "isRegex".',
    timeoutMs: 'has an invalid "timeoutMs".',
  },
};

/** The kind-specific fields of trigger kind `K`. */
type TriggerFieldOf<K extends WorkflowTriggerKind> = Exclude<
  keyof Extract<WorkflowTrigger, { kind: K }>,
  "kind"
>;

/** What is wrong when a trigger field fails validation (exhaustive, like steps). */
const TRIGGER_FIELD_PROBLEMS: { [K in WorkflowTriggerKind]: Record<TriggerFieldOf<K>, string> } = {
  manual: {},
  "on-connect": { connectionIds: 'has invalid "connectionIds".' },
  hotkey: { binding: 'is missing "binding".' },
  "on-disconnect": {
    connectionIds: 'has invalid "connectionIds".',
    when: 'has an invalid "when".',
  },
  "on-output-match": {
    connectionIds: 'has invalid "connectionIds".',
    pattern: 'is missing "pattern".',
    isRegex: 'has an invalid "isRegex".',
    cooldownMs: 'has an invalid "cooldownMs".',
    maxFiresPerSession: 'has an invalid "maxFiresPerSession".',
  },
};

/** What is wrong when a parameter field fails validation (`type` is worded separately). */
const PARAMETER_FIELD_PROBLEMS: Record<Exclude<keyof WorkflowParameter, "type">, string> = {
  name: "is missing a name.",
  label: 'has a non-string "label".',
  default: 'has an invalid "default".',
  required: 'has a non-boolean "required".',
  options: 'has invalid "options".',
};

/** Look up `field` in a problem table, falling back to a generic message. */
function problemFor(table: object, field: PropertyKey | undefined): string {
  const problem: unknown = field === undefined ? undefined : child(table, String(field));
  return typeof problem === "string" ? problem : "is malformed.";
}

/** The message for a raw entry whose `kind` is missing, non-string, or unknown. */
function describeKind(raw: unknown, at: string): string {
  if (!isRecord(raw) || typeof raw.kind !== "string") return `${at} is malformed.`;
  return `${at} has unknown kind "${raw.kind}".`;
}

/** The problem with a structured condition, given the issue path inside it. */
function conditionProblem(path: PropertyKey[]): string {
  const [field] = path;
  if (field === undefined) return 'is missing "condition".';
  if (field === "op") return "has an invalid condition operator.";
  return "has invalid condition operands.";
}

/** The problem with a loop's mode, given the issue path inside it. */
function loopModeProblem(path: PropertyKey[]): string {
  const [field, ...rest] = path;
  if (field === "count") return 'has an invalid "count".';
  if (field === "condition") return conditionProblem(rest);
  return 'has an invalid "loop" mode.';
}

/** Describe an issue inside one step at location `at` (recursing into containers). */
function describeStepIssue(raw: unknown, at: string, path: PropertyKey[]): string {
  const [field, ...rest] = path;
  if (field === undefined || field === "kind" || !isRecord(raw)) return describeKind(raw, at);
  if (field === "continueOnError") return `${at} has an invalid "continueOnError".`;
  if (field === "retry") return `${at} has an invalid "retry" policy.`;

  const kind = raw.kind as WorkflowStepKind;
  const [index, ...inner] = rest;
  const isContainer = field === "then" || field === "else" || field === "body";
  if (isContainer && typeof index === "number") {
    return describeStepIssue(child(raw[field], index), `step ${index} of ${at} ${field}`, inner);
  }
  if (kind === "conditional" && field === "condition") {
    return `${at} (${kind}) ${conditionProblem(rest)}`;
  }
  if (kind === "loop" && field === "loop") return `${at} (${kind}) ${loopModeProblem(rest)}`;
  return `${at} (${kind}) ${problemFor(STEP_FIELD_PROBLEMS[kind], field)}`;
}

/** Describe an issue inside one trigger at location `at`. */
function describeTriggerIssue(
  issue: ImportIssue,
  raw: unknown,
  at: string,
  path: PropertyKey[]
): string {
  const [field] = path;
  if (field === undefined || field === "kind" || !isRecord(raw)) return describeKind(raw, at);
  const kind = raw.kind as WorkflowTriggerKind;
  if (issue.code === "custom" && field === "pattern") {
    // The output-pattern refinement: the issue message is the bare reason.
    return `${at} (${kind}) has an unusable pattern (${issue.message}).`;
  }
  return `${at} (${kind}) ${problemFor(TRIGGER_FIELD_PROBLEMS[kind], field)}`;
}

/** Describe an issue inside one parameter at location `at`. */
function describeParameterIssue(raw: unknown, at: string, path: PropertyKey[]): string {
  const [field] = path;
  if (field === undefined || !isRecord(raw)) return `${at} is malformed.`;
  if (field === "type") return `${at} has unknown type "${String(raw.type)}".`;
  return `${at} ${problemFor(PARAMETER_FIELD_PROBLEMS, field)}`;
}

/**
 * Describe an issue inside workflow `index` as `<location> <problem>`. The
 * location names the workflow by index and — once its name is valid — by name,
 * then the offending step / trigger / parameter.
 */
function describeWorkflowIssue(
  issue: ImportIssue,
  raw: unknown,
  index: number,
  path: PropertyKey[]
): string {
  const where = `workflow at index ${index}`;
  if (!isRecord(raw)) return `${where} is not an object.`;
  const label = isNonBlankString(raw.name) ? `${where} ("${raw.name}")` : where;
  const [field, entry, ...rest] = path;
  const nested = typeof entry === "number";
  switch (field) {
    case "name":
      return `${where} is missing a name.`;
    case "steps":
      return nested
        ? describeStepIssue(child(raw.steps, entry), `step ${entry} of ${label}`, rest)
        : `${label} is missing its steps.`;
    case "triggers":
      return nested
        ? describeTriggerIssue(
            issue,
            child(raw.triggers, entry),
            `trigger ${entry} of ${label}`,
            rest
          )
        : `${label} has malformed triggers.`;
    case "parameters":
      return nested
        ? describeParameterIssue(
            child(raw.parameters, entry),
            `parameter ${entry} of ${label}`,
            rest
          )
        : `${label} has malformed parameters.`;
    case "tags":
      return `${label} has malformed tags.`;
    default:
      return `${label} is malformed.`;
  }
}

/**
 * Parse and validate an exported-workflow file, returning the workflows it
 * contains. Throws an `Error` with a human-readable, recoverable message for
 * malformed JSON, a missing/unsupported envelope version, or any malformed
 * workflow — so a bad file never corrupts the library, it just surfaces a toast.
 *
 * Validation is the declarative {@link importedWorkflowSchema}: every field of
 * every step / trigger / parameter kind is checked, unknown keys are stripped
 * (a forged extra key never survives), and absent optional keys stay absent.
 */
export function parseWorkflowEnvelope(json: string): Workflow[] {
  const workflows = parseImportEnvelope(json, {
    label: "workflow",
    version: WORKFLOW_EXPORT_VERSION,
    listKey: "workflows",
    entry: importedWorkflowSchema,
    describeEntryIssue: describeWorkflowIssue,
  });
  // Normalise to the stable key order, and keep `parameters` only when it has
  // entries so a parameter-free workflow round-trips without an empty key.
  return workflows.map(
    ({ id, name, description, tags, steps, triggers, parameters, createdAt, updatedAt }) => ({
      id,
      name,
      description,
      tags,
      steps,
      triggers,
      ...(parameters && parameters.length > 0 ? { parameters } : {}),
      createdAt,
      updatedAt,
    })
  );
}

/**
 * Count the `run-local-process` steps carried by a set of workflows, and how
 * many workflows contain at least one. Used to surface a security warning when a
 * file is imported: these steps are guarded and must be explicitly authorized
 * (#1857) before they can run, so an imported file that carries them is flagged
 * rather than silently trusted. Returns `{0, 0}` when there are none.
 */
export function summarizeLocalProcessSteps(workflows: Workflow[]): {
  workflowsWithLocalProcess: number;
  localProcessSteps: number;
} {
  let workflowsWithLocalProcess = 0;
  let localProcessSteps = 0;
  for (const workflow of workflows) {
    const count = countLocalProcessSteps(workflow.steps);
    if (count > 0) {
      workflowsWithLocalProcess += 1;
      localProcessSteps += count;
    }
  }
  return { workflowsWithLocalProcess, localProcessSteps };
}

/**
 * Count `run-local-process` steps in a step list, **descending into the
 * container step kinds** — a conditional's `then`/`else` (PROD-0044) and a
 * loop's `body` (PROD-044) — so a guarded step nested inside one is still
 * counted; otherwise an imported container could hide one from the security
 * warning.
 */
function countLocalProcessSteps(steps: WorkflowStep[]): number {
  let count = 0;
  for (const step of steps) {
    if (step.kind === "run-local-process") {
      count += 1;
    } else if (step.kind === "conditional") {
      count += countLocalProcessSteps(step.then);
      if (step.else) count += countLocalProcessSteps(step.else);
    } else if (step.kind === "loop") {
      count += countLocalProcessSteps(step.body);
    }
  }
  return count;
}

/**
 * Remove every `run-script` `sourcePath` from imported workflows (#4310,
 * FEC2-001), **descending into container steps** (a conditional's `then`/`else`,
 * a loop's `body`) so a nested step cannot hide one. A `sourcePath` makes the
 * runner read a local file and type it into the remote shell; an imported file
 * must never choose that file, so the step keeps only its visible `script` and
 * the user has to re-pick the file on this machine. Pure: returns new workflows
 * plus the removed paths (in step order) so the import can tell the user.
 */
export function stripScriptSourcePaths(workflows: Workflow[]): {
  workflows: Workflow[];
  removedPaths: string[];
} {
  const removedPaths: string[] = [];
  const stripSteps = (steps: WorkflowStep[]): WorkflowStep[] =>
    steps.map((step) => {
      switch (step.kind) {
        case "run-script": {
          if (step.sourcePath === undefined) return step;
          const { sourcePath, ...rest } = step;
          removedPaths.push(sourcePath);
          return rest;
        }
        case "conditional": {
          const next: WorkflowStep = { ...step, then: stripSteps(step.then) };
          if (step.else) next.else = stripSteps(step.else);
          return next;
        }
        case "loop":
          return { ...step, body: stripSteps(step.body) };
        default:
          return step;
      }
    });
  const stripped = workflows.map((workflow) => ({
    ...workflow,
    steps: stripSteps(workflow.steps),
  }));
  return { workflows: stripped, removedPaths };
}

/** Default fresh-id generator; mirrors the store's `generateWorkflowId`. */
function defaultGenerateId(): string {
  return newId("workflow");
}

/**
 * Given a desired name and the set of names already in use, return a unique name
 * by appending "(imported)", then "(imported 2)", … until it no longer collides.
 * Leaves the name untouched when there is no collision.
 */
function uniqueName(name: string, used: Set<string>): string {
  if (!used.has(name)) return name;
  let candidate = `${name} (${COLLISION_SUFFIX})`;
  let n = 2;
  while (used.has(candidate)) {
    candidate = `${name} (${COLLISION_SUFFIX} ${n})`;
    n += 1;
  }
  return candidate;
}

/**
 * Prepare imported workflows for merging into an existing library. Every imported
 * workflow is given a **fresh id** (so it never overwrites an existing one, even
 * when the file was exported from this same instance), has its create/update
 * timestamps cleared (the backend re-stamps them on save), and gets a
 * **deterministically de-duplicated name** — a name that already exists (in the
 * library or earlier in this same batch) is suffixed with "(imported)".
 *
 * @param imported Workflows parsed from a file (see {@link parseWorkflowEnvelope}).
 * @param existing The current library, used for name-collision detection.
 * @param generateId Injectable id generator (defaults to a crypto-based uuid).
 */
export function resolveImportCollisions(
  imported: Workflow[],
  existing: Workflow[],
  generateId: () => string = defaultGenerateId
): Workflow[] {
  const usedNames = new Set(existing.map((w) => w.name));
  return imported.map((workflow) => {
    const name = uniqueName(workflow.name, usedNames);
    usedNames.add(name);
    return {
      ...workflow,
      id: generateId(),
      name,
      // Cleared so the backend stamps authoritative timestamps on save.
      createdAt: "",
      updatedAt: "",
    };
  });
}
