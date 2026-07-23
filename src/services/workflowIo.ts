/**
 * Import/export of workflows as portable JSON files (#1852 foundation; the
 * file-dialog UI that drives these is #1856).
 *
 * Pure, dependency-free helpers: serialising workflows into a small versioned
 * envelope, validating/parsing an envelope back into workflows (including the
 * discriminated {@link WorkflowStep} / {@link WorkflowTrigger} unions), and
 * resolving id/name collisions when merging imported workflows into an existing
 * library. Mirrors {@link "@/services/macroIo"}; keeping the
 * serialise/validate/collision logic here makes it unit-testable in isolation.
 */

import type {
  Workflow,
  WorkflowStep,
  WorkflowStepKind,
  WorkflowTrigger,
  WorkflowTriggerKind,
} from "@/types/workflow";

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

/** All valid step-kind discriminants. */
const STEP_KINDS: readonly WorkflowStepKind[] = [
  "send-command",
  "run-script",
  "run-macro",
  "wait",
  "run-local-process",
];

/** All valid trigger-kind discriminants. */
const TRIGGER_KINDS: readonly WorkflowTriggerKind[] = ["manual", "on-connect", "hotkey"];

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

/** Type guard: a JSON value is a non-null, non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validate one raw step, throwing a clear error that names the offending step. */
function validateStep(raw: unknown, where: string, stepIndex: number): WorkflowStep {
  const at = `step ${stepIndex} of ${where}`;
  if (!isRecord(raw) || typeof raw.kind !== "string") {
    throw new Error(`Invalid workflow file: ${at} is malformed.`);
  }
  const kind = raw.kind as WorkflowStepKind;
  if (!STEP_KINDS.includes(kind)) {
    throw new Error(`Invalid workflow file: ${at} has unknown kind "${raw.kind}".`);
  }

  switch (kind) {
    case "send-command":
      if (typeof raw.command !== "string") {
        throw new Error(`Invalid workflow file: ${at} (send-command) is missing "command".`);
      }
      return { kind, command: raw.command };
    case "run-script": {
      if (typeof raw.script !== "string") {
        throw new Error(`Invalid workflow file: ${at} (run-script) is missing "script".`);
      }
      const step: WorkflowStep = { kind, script: raw.script };
      if (raw.perLineDelayMs !== undefined) {
        if (typeof raw.perLineDelayMs !== "number" || raw.perLineDelayMs < 0) {
          throw new Error(`Invalid workflow file: ${at} (run-script) has an invalid delay.`);
        }
        step.perLineDelayMs = raw.perLineDelayMs;
      }
      if (raw.sourcePath !== undefined) {
        if (typeof raw.sourcePath !== "string") {
          throw new Error(`Invalid workflow file: ${at} (run-script) has an invalid sourcePath.`);
        }
        step.sourcePath = raw.sourcePath;
      }
      return step;
    }
    case "run-macro":
      if (typeof raw.macroId !== "string") {
        throw new Error(`Invalid workflow file: ${at} (run-macro) is missing "macroId".`);
      }
      return { kind, macroId: raw.macroId };
    case "wait":
      if (typeof raw.delayMs !== "number" || !Number.isFinite(raw.delayMs) || raw.delayMs < 0) {
        throw new Error(`Invalid workflow file: ${at} (wait) has an invalid "delayMs".`);
      }
      return { kind, delayMs: raw.delayMs };
    case "run-local-process": {
      if (typeof raw.program !== "string") {
        throw new Error(`Invalid workflow file: ${at} (run-local-process) is missing "program".`);
      }
      if (!Array.isArray(raw.args) || raw.args.some((a) => typeof a !== "string")) {
        throw new Error(`Invalid workflow file: ${at} (run-local-process) has invalid "args".`);
      }
      return { kind, program: raw.program, args: raw.args as string[] };
    }
    default: {
      const _exhaustive: never = kind;
      throw new Error(`Invalid workflow file: ${at} has unknown kind ${String(_exhaustive)}.`);
    }
  }
}

/** Validate one raw trigger, throwing a clear error when a field is malformed. */
function validateTrigger(raw: unknown, where: string, triggerIndex: number): WorkflowTrigger {
  const at = `trigger ${triggerIndex} of ${where}`;
  if (!isRecord(raw) || typeof raw.kind !== "string") {
    throw new Error(`Invalid workflow file: ${at} is malformed.`);
  }
  const kind = raw.kind as WorkflowTriggerKind;
  if (!TRIGGER_KINDS.includes(kind)) {
    throw new Error(`Invalid workflow file: ${at} has unknown kind "${raw.kind}".`);
  }

  switch (kind) {
    case "manual":
      return { kind };
    case "on-connect":
      if (
        !Array.isArray(raw.connectionIds) ||
        raw.connectionIds.some((c) => typeof c !== "string")
      ) {
        throw new Error(`Invalid workflow file: ${at} (on-connect) has invalid "connectionIds".`);
      }
      return { kind, connectionIds: raw.connectionIds as string[] };
    case "hotkey":
      if (typeof raw.binding !== "string") {
        throw new Error(`Invalid workflow file: ${at} (hotkey) is missing "binding".`);
      }
      return { kind, binding: raw.binding };
    default: {
      const _exhaustive: never = kind;
      throw new Error(`Invalid workflow file: ${at} has unknown kind ${String(_exhaustive)}.`);
    }
  }
}

/**
 * Validate one raw workflow entry from an imported file, throwing a clear error
 * that names the offending workflow (by index). Returns a normalised
 * {@link Workflow} — tolerant of a missing `description`/`tags`/`id`/timestamps
 * since the importer re-stamps those, but strict about the load-bearing `name`,
 * `steps`, and `triggers`.
 */
function validateWorkflow(raw: unknown, index: number): Workflow {
  const where = `workflow at index ${index}`;
  if (!isRecord(raw)) {
    throw new Error(`Invalid workflow file: ${where} is not an object.`);
  }
  if (typeof raw.name !== "string" || raw.name.trim() === "") {
    throw new Error(`Invalid workflow file: ${where} is missing a name.`);
  }
  if (!Array.isArray(raw.steps)) {
    throw new Error(`Invalid workflow file: ${where} ("${raw.name}") is missing its steps.`);
  }

  const label = `${where} ("${raw.name}")`;
  const steps = raw.steps.map((step, i) => validateStep(step, label, i));

  let triggers: WorkflowTrigger[] = [];
  if (raw.triggers !== undefined) {
    if (!Array.isArray(raw.triggers)) {
      throw new Error(`Invalid workflow file: ${label} has malformed triggers.`);
    }
    triggers = raw.triggers.map((trigger, i) => validateTrigger(trigger, label, i));
  }

  let tags: string[] = [];
  if (raw.tags !== undefined) {
    if (!Array.isArray(raw.tags) || raw.tags.some((tag) => typeof tag !== "string")) {
      throw new Error(`Invalid workflow file: ${label} has malformed tags.`);
    }
    tags = raw.tags as string[];
  }

  return {
    id: typeof raw.id === "string" ? raw.id : "",
    name: raw.name,
    description: typeof raw.description === "string" ? raw.description : undefined,
    tags,
    steps,
    triggers,
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : "",
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : "",
  };
}

/**
 * Parse and validate an exported-workflow file, returning the workflows it
 * contains. Throws an `Error` with a human-readable, recoverable message for
 * malformed JSON, a missing/unsupported envelope version, or any malformed
 * workflow — so a bad file never corrupts the library, it just surfaces a toast.
 */
export function parseWorkflowEnvelope(json: string): Workflow[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("Invalid workflow file: the file is not valid JSON.");
  }

  if (!isRecord(parsed)) {
    throw new Error("Invalid workflow file: expected a workflow export object.");
  }
  if (parsed.version !== WORKFLOW_EXPORT_VERSION) {
    throw new Error(
      `Unsupported workflow file version: ${String(parsed.version)} (expected ${WORKFLOW_EXPORT_VERSION}).`
    );
  }
  if (!Array.isArray(parsed.workflows)) {
    throw new Error('Invalid workflow file: missing "workflows" array.');
  }

  return parsed.workflows.map((workflow, index) => validateWorkflow(workflow, index));
}

/** Default fresh-id generator; mirrors the store's `generateWorkflowId`. */
function defaultGenerateId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") {
    return `workflow-${c.randomUUID()}`;
  }
  return `workflow-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
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
