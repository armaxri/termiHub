/**
 * Regression tests for the zod-based workflow import validation (#4386,
 * LIBFE2-007).
 *
 * - **No dropped optional fields:** the maximal fixtures below are typed with
 *   `Required<…>` per step / trigger kind, so a new field on any kind is a
 *   compile error here until the fixture carries it — and the round-trip then
 *   proves the import schema keeps it.
 * - **Malformed input of every kind** is rejected with the exact,
 *   human-readable message the hand-written validators produced (one
 *   documented improvement: a loop's `while` condition is now tagged `(loop)`,
 *   not `(conditional)`).
 * - **Unknown keys are stripped** at every level, as before.
 */
import { describe, expect, it } from "vitest";

import type {
  Workflow,
  WorkflowParameter,
  WorkflowStep,
  WorkflowStepKind,
  WorkflowTrigger,
  WorkflowTriggerKind,
} from "@/types/workflow";
import { parseWorkflowEnvelope, serializeWorkflows, WORKFLOW_EXPORT_VERSION } from "./workflowIo";

/** Every field of a union variant, optional ones included. */
type Maximal<U, K> = Required<Extract<U, { kind: K }>>;

const FULL_RETRY = { count: 2, delayMs: 100, backoff: "exponential" } as const;

/** One step per kind with EVERY field set (compile-time exhaustive). */
const MAXIMAL_STEPS: { [K in WorkflowStepKind]: Maximal<WorkflowStep, K> } = {
  "send-command": {
    kind: "send-command",
    command: "ls",
    continueOnError: true,
    retry: FULL_RETRY,
  },
  "run-script": {
    kind: "run-script",
    script: "a\nb",
    perLineDelayMs: 25,
    sourcePath: "/tmp/s.sh",
    continueOnError: false,
    retry: FULL_RETRY,
  },
  "run-macro": { kind: "run-macro", macroId: "m-1", continueOnError: true, retry: FULL_RETRY },
  wait: { kind: "wait", delayMs: 10, continueOnError: true, retry: FULL_RETRY },
  "run-local-process": {
    kind: "run-local-process",
    program: "echo",
    args: ["hi"],
    continueOnError: true,
    retry: FULL_RETRY,
  },
  conditional: {
    kind: "conditional",
    condition: { left: "{{a}}", op: "contains", right: "b" },
    then: [{ kind: "send-command", command: "yes" }],
    else: [{ kind: "send-command", command: "no", retry: { count: 1 } }],
    continueOnError: true,
    retry: FULL_RETRY,
  },
  loop: {
    kind: "loop",
    loop: { kind: "while", condition: { left: "1", op: "lt", right: "3" } },
    body: [{ kind: "wait", delayMs: 1, continueOnError: true }],
    continueOnError: true,
    retry: FULL_RETRY,
  },
  "wait-for-output": {
    kind: "wait-for-output",
    pattern: "\\$ $",
    isRegex: true,
    timeoutMs: 5000,
    continueOnError: true,
    retry: FULL_RETRY,
  },
};

/** One trigger per kind with EVERY field set (compile-time exhaustive). */
const MAXIMAL_TRIGGERS: { [K in WorkflowTriggerKind]: Maximal<WorkflowTrigger, K> } = {
  manual: { kind: "manual" },
  "on-connect": { kind: "on-connect", connectionIds: ["c-1"] },
  hotkey: { kind: "hotkey", binding: "Ctrl+Alt+K" },
  "on-disconnect": { kind: "on-disconnect", connectionIds: ["c-1"], when: "drop" },
  "on-output-match": {
    kind: "on-output-match",
    connectionIds: ["c-1"],
    pattern: "ERROR",
    isRegex: false,
    cooldownMs: 1000,
    maxFiresPerSession: 4,
  },
};

const MAXIMAL_PARAMETER: Required<WorkflowParameter> = {
  name: "env",
  label: "Environment",
  type: "enum",
  default: "dev",
  required: true,
  options: ["dev", "prod"],
};

const MAXIMAL_WORKFLOW: Required<Workflow> = {
  id: "wf-1",
  name: "Everything",
  description: "every field",
  tags: ["a", "b"],
  steps: Object.values(MAXIMAL_STEPS),
  triggers: Object.values(MAXIMAL_TRIGGERS),
  parameters: [MAXIMAL_PARAMETER],
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-02T00:00:00Z",
};

/** Wrap raw (unvalidated) workflow objects in a current-version envelope. */
function rawEnvelope(...workflows: unknown[]): string {
  return JSON.stringify({ version: WORKFLOW_EXPORT_VERSION, workflows });
}

/** A raw workflow named "X" with the given raw steps / triggers / parameters. */
function rawWorkflow(fields: Record<string, unknown>): string {
  return rawEnvelope({ name: "X", steps: [], ...fields });
}

describe("workflow import keeps every field (no dropped optional fields)", () => {
  it("round-trips a workflow with every optional field of every kind set", () => {
    const [parsed] = parseWorkflowEnvelope(serializeWorkflows([MAXIMAL_WORKFLOW]));
    expect(parsed).toEqual(MAXIMAL_WORKFLOW);
  });

  it.each(Object.values(MAXIMAL_STEPS))("keeps every field of a $kind step", (step) => {
    const [parsed] = parseWorkflowEnvelope(rawWorkflow({ steps: [step] }));
    expect(parsed.steps[0]).toStrictEqual(step);
  });

  it.each(Object.values(MAXIMAL_TRIGGERS))("keeps every field of a $kind trigger", (trigger) => {
    const [parsed] = parseWorkflowEnvelope(rawWorkflow({ triggers: [trigger] }));
    expect(parsed.triggers[0]).toStrictEqual(trigger);
  });

  it("keeps every optional field of a nested step inside a loop inside a conditional", () => {
    const inner = MAXIMAL_STEPS["wait-for-output"];
    const step = {
      kind: "conditional",
      condition: { left: "a", op: "eq", right: "a" },
      then: [{ kind: "loop", loop: { kind: "count", count: 1 }, body: [inner] }],
    };
    const [parsed] = parseWorkflowEnvelope(rawWorkflow({ steps: [step] }));
    expect(parsed.steps[0]).toStrictEqual(step);
  });

  it("does not add absent optional keys", () => {
    const [parsed] = parseWorkflowEnvelope(
      rawWorkflow({
        steps: [{ kind: "run-script", script: "s" }],
        triggers: [{ kind: "on-disconnect", connectionIds: [] }],
      })
    );
    expect(parsed.steps[0]).toStrictEqual({ kind: "run-script", script: "s" });
    expect(parsed.triggers[0]).toStrictEqual({ kind: "on-disconnect", connectionIds: [] });
  });

  it("defaults a missing loop body to an empty list", () => {
    const [parsed] = parseWorkflowEnvelope(
      rawWorkflow({ steps: [{ kind: "loop", loop: { kind: "count", count: 2 } }] })
    );
    expect(parsed.steps[0]).toStrictEqual({
      kind: "loop",
      loop: { kind: "count", count: 2 },
      body: [],
    });
  });

  it("tolerates missing or non-string id, description, tags and timestamps", () => {
    const [parsed] = parseWorkflowEnvelope(
      rawEnvelope({ name: "X", steps: [], id: 4, description: false, createdAt: null })
    );
    expect(parsed).toEqual({
      id: "",
      name: "X",
      description: undefined,
      tags: [],
      steps: [],
      triggers: [],
      createdAt: "",
      updatedAt: "",
    });
  });
});

describe("workflow import strips unknown keys at every level", () => {
  it("drops unknown keys on the workflow, steps, nested steps, triggers and parameters", () => {
    const [parsed] = parseWorkflowEnvelope(
      JSON.stringify({
        version: WORKFLOW_EXPORT_VERSION,
        extra: true,
        workflows: [
          {
            name: "X",
            trusted: true,
            steps: [
              {
                kind: "loop",
                loop: { kind: "count", count: 1, extra: 1 },
                body: [{ kind: "send-command", command: "ls", authorized: true }],
                extra: 1,
              },
              {
                kind: "send-command",
                command: "x",
                retry: { count: 1, extra: 1 },
              },
            ],
            triggers: [{ kind: "manual", connectionIds: ["c"] }],
            parameters: [{ name: "p", type: "string", secret: true }],
          },
        ],
      })
    );
    expect(parsed).not.toHaveProperty("trusted");
    expect(parsed.steps).toStrictEqual([
      {
        kind: "loop",
        loop: { kind: "count", count: 1 },
        body: [{ kind: "send-command", command: "ls" }],
      },
      { kind: "send-command", command: "x", retry: { count: 1 } },
    ]);
    expect(parsed.triggers).toStrictEqual([{ kind: "manual" }]);
    expect(parsed.parameters).toStrictEqual([{ name: "p", type: "string" }]);
  });
});

const W = 'Invalid workflow file: workflow at index 0 ("X")';
const S0 = `Invalid workflow file: step 0 of workflow at index 0 ("X")`;
const T0 = `Invalid workflow file: trigger 0 of workflow at index 0 ("X")`;

describe("workflow import rejects a malformed step of every kind", () => {
  it.each<[string, unknown, string]>([
    ["a non-object step", 5, `${S0} is malformed.`],
    ["a step without kind", { command: "x" }, `${S0} is malformed.`],
    ["a non-string kind", { kind: 3 }, `${S0} is malformed.`],
    ["an unknown kind", { kind: "teleport" }, `${S0} has unknown kind "teleport".`],
    [
      "send-command: no command",
      { kind: "send-command" },
      `${S0} (send-command) is missing "command".`,
    ],
    [
      "run-script: bad script",
      { kind: "run-script", script: 1 },
      `${S0} (run-script) is missing "script".`,
    ],
    [
      "run-macro: no macroId",
      { kind: "run-macro", macroId: 7 },
      `${S0} (run-macro) is missing "macroId".`,
    ],
    ["wait: bad delayMs", { kind: "wait", delayMs: "1" }, `${S0} (wait) has an invalid "delayMs".`],
    [
      "run-local-process: bad program",
      { kind: "run-local-process", program: null, args: [] },
      `${S0} (run-local-process) is missing "program".`,
    ],
    [
      "conditional: bad then",
      { kind: "conditional", condition: { left: "a", op: "eq", right: "b" }, then: {} },
      `${S0} (conditional) is missing "then".`,
    ],
    [
      "conditional: bad else",
      { kind: "conditional", condition: { left: "a", op: "eq", right: "b" }, then: [], else: 1 },
      `${S0} (conditional) has an invalid "else".`,
    ],
    [
      "conditional: bad operands",
      { kind: "conditional", condition: { left: 1, op: "eq", right: "b" }, then: [] },
      `${S0} (conditional) has invalid condition operands.`,
    ],
    [
      "loop: bad body",
      { kind: "loop", loop: { kind: "count", count: 1 }, body: "x" },
      `${S0} (loop) has an invalid "body".`,
    ],
    [
      "loop: unknown mode",
      { kind: "loop", loop: { kind: "forever" } },
      `${S0} (loop) has an invalid "loop" mode.`,
    ],
    [
      "loop: negative count",
      { kind: "loop", loop: { kind: "count", count: -1 } },
      `${S0} (loop) has an invalid "count".`,
    ],
    [
      // Documented improvement (#4386): this was tagged "(conditional)".
      "loop: bad while condition",
      { kind: "loop", loop: { kind: "while", condition: { left: "a", op: "is", right: "b" } } },
      `${S0} (loop) has an invalid condition operator.`,
    ],
    [
      "wait-for-output: bad isRegex",
      { kind: "wait-for-output", pattern: "x", isRegex: "yes" },
      `${S0} (wait-for-output) has an invalid "isRegex".`,
    ],
    [
      "wait-for-output: negative timeoutMs",
      { kind: "wait-for-output", pattern: "x", timeoutMs: -1 },
      `${S0} (wait-for-output) has an invalid "timeoutMs".`,
    ],
    [
      "a non-object retry",
      { kind: "wait", delayMs: 1, retry: [] },
      `${S0} has an invalid "retry" policy.`,
    ],
  ])("rejects %s", (_label, step, message) => {
    expect(() => parseWorkflowEnvelope(rawWorkflow({ steps: [step] }))).toThrow(message);
  });

  it.each<[string, string]>([
    ["then", `step 0 of workflow at index 0 ("X") then`],
    ["else", `step 0 of workflow at index 0 ("X") else`],
  ])("names a malformed step nested in a conditional's %s branch", (branch, at) => {
    const step = {
      kind: "conditional",
      condition: { left: "a", op: "eq", right: "b" },
      then: [],
      [branch]: [
        { kind: "send-command", command: "ok" },
        { kind: "wait", delayMs: -1 },
      ],
    };
    expect(() => parseWorkflowEnvelope(rawWorkflow({ steps: [step] }))).toThrow(
      `Invalid workflow file: step 1 of ${at} (wait) has an invalid "delayMs".`
    );
  });

  it("names a malformed step nested two levels deep", () => {
    const step = {
      kind: "loop",
      loop: { kind: "count", count: 1 },
      body: [{ kind: "loop", loop: { kind: "count", count: 1 }, body: [{ kind: "nope" }] }],
    };
    expect(() => parseWorkflowEnvelope(rawWorkflow({ steps: [step] }))).toThrow(
      'Invalid workflow file: step 0 of step 0 of step 0 of workflow at index 0 ("X") body body ' +
        'has unknown kind "nope".'
    );
  });
});

describe("workflow import rejects a malformed trigger of every kind", () => {
  it.each<[string, unknown, string]>([
    ["a non-object trigger", "manual", `${T0} is malformed.`],
    ["an unknown kind", { kind: "cron" }, `${T0} has unknown kind "cron".`],
    [
      "on-connect: missing connectionIds",
      { kind: "on-connect" },
      `${T0} (on-connect) has invalid "connectionIds".`,
    ],
    ["hotkey: no binding", { kind: "hotkey" }, `${T0} (hotkey) is missing "binding".`],
    [
      "on-disconnect: bad connectionIds",
      { kind: "on-disconnect", connectionIds: "c" },
      `${T0} (on-disconnect) has invalid "connectionIds".`,
    ],
    [
      "on-output-match: no pattern",
      { kind: "on-output-match", connectionIds: [] },
      `${T0} (on-output-match) is missing "pattern".`,
    ],
    [
      "on-output-match: bad isRegex",
      { kind: "on-output-match", connectionIds: [], pattern: "x", isRegex: 1 },
      `${T0} (on-output-match) has an invalid "isRegex".`,
    ],
    [
      "on-output-match: negative maxFiresPerSession",
      { kind: "on-output-match", connectionIds: [], pattern: "x", maxFiresPerSession: -2 },
      `${T0} (on-output-match) has an invalid "maxFiresPerSession".`,
    ],
  ])("rejects %s", (_label, trigger, message) => {
    expect(() => parseWorkflowEnvelope(rawWorkflow({ triggers: [trigger] }))).toThrow(message);
  });
});

describe("workflow import rejects a malformed workflow or envelope", () => {
  it.each<[string, string, string]>([
    ["a non-object payload", "[]", "Invalid workflow file: expected a workflow export object."],
    [
      "a missing version",
      JSON.stringify({ workflows: [] }),
      "Unsupported workflow file version: undefined (expected 1).",
    ],
    [
      "a non-array workflows",
      JSON.stringify({ version: 1, workflows: {} }),
      'Invalid workflow file: missing "workflows" array.',
    ],
    [
      "a non-object workflow",
      rawEnvelope(3),
      "Invalid workflow file: workflow at index 0 is not an object.",
    ],
    [
      "a blank name",
      rawEnvelope({ name: " ", steps: [] }),
      "Invalid workflow file: workflow at index 0 is missing a name.",
    ],
    ["missing steps", rawEnvelope({ name: "X" }), `${W} is missing its steps.`],
    ["non-array triggers", rawWorkflow({ triggers: {} }), `${W} has malformed triggers.`],
    ["a non-string tag", rawWorkflow({ tags: ["a", 1] }), `${W} has malformed tags.`],
  ])("rejects %s", (_label, json, message) => {
    expect(() => parseWorkflowEnvelope(json)).toThrow(message);
  });

  it("names the second workflow when only it is malformed", () => {
    expect(() =>
      parseWorkflowEnvelope(rawEnvelope({ name: "A", steps: [] }, { name: "B", steps: [{}] }))
    ).toThrow('Invalid workflow file: step 0 of workflow at index 1 ("B") is malformed.');
  });
});
