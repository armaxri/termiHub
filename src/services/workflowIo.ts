/**
 * Validated reading of the entries of an automations file (#1852, #4386, #5818):
 * the `workflows` list older builds exported and today's `automations` list have
 * the same fields, so one schema ({@link "@/services/workflowSchema"}) and one set
 * of messages serve both. `automationFileIo.ts` puts the lists together.
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
import { importedWorkflowSchema } from "@/services/workflowSchema";

/** The version of every automations file so far, in any of its formats. */
export const WORKFLOW_EXPORT_VERSION = 1;

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
const STEP_FIELD_PROBLEMS: { [K in WorkflowStepKind]: Record<StepFieldOf<K>, string> } & {
  "type-keys": Record<"chunks" | "timing" | "fixedDelayMs" | "recorded", string>;
  "run-automation": Record<"automationId", string>;
} = {
  "run-automation": { automationId: 'is missing "automationId".' },
  "type-keys": {
    chunks: 'has invalid "chunks".',
    timing: 'has an invalid "timing".',
    fixedDelayMs: 'has an invalid "fixedDelayMs".',
    recorded: 'has an invalid "recorded".',
  },
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
 * Describe an issue inside entry `index` as `<location> <problem>`. The
 * location names the entry by index and — once its name is valid — by name,
 * then the offending step / trigger / parameter.
 */
function describeEntryIssue(
  noun: string,
  issue: ImportIssue,
  raw: unknown,
  index: number,
  path: PropertyKey[]
): string {
  const where = `${noun} at index ${index}`;
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

/** The lists that hold step-by-step entries, and what one entry is called. */
const ENTRY_NOUN = { automations: "automation", workflows: "workflow" } as const;

/**
 * Parse and validate one list of an exported file. Throws an `Error` with a
 * human-readable, recoverable message for malformed JSON, a missing or
 * unsupported envelope version, or any malformed entry — so a bad file never
 * corrupts the library, it just surfaces a toast.
 *
 * Every field of every step / trigger / parameter kind is checked; the result
 * holds the known fields only, and absent optional keys stay absent.
 */
export function parseStepEntries(json: string, listKey: keyof typeof ENTRY_NOUN): Workflow[] {
  const noun = ENTRY_NOUN[listKey];
  const entries = parseImportEnvelope(json, {
    label: noun,
    version: WORKFLOW_EXPORT_VERSION,
    listKey,
    entry: importedWorkflowSchema,
    describeEntryIssue: (issue, raw, index, path) =>
      describeEntryIssue(noun, issue, raw, index, path),
  });
  // `parameters` only when it has entries, so a parameter-free entry does not
  // gain an empty key; `triggersEnabled` only when it disarms (#5674).
  return entries.map(({ parameters, triggersEnabled, ...entry }) => ({
    ...entry,
    ...(parameters && parameters.length > 0 ? { parameters } : {}),
    ...(triggersEnabled === false ? { triggersEnabled } : {}),
  }));
}
