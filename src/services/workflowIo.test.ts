/**
 * Tests for workflow import/export serialisation (#1852).
 *
 * Covers the round-trip (serialise → parse), strict validation of the
 * discriminated step/trigger unions and the envelope version, and the
 * fresh-id + name-dedupe collision resolution used when merging an imported
 * file into an existing library.
 */
import { describe, it, expect } from "vitest";
import {
  serializeWorkflows,
  parseWorkflowEnvelope,
  resolveImportCollisions,
  summarizeLocalProcessSteps,
  stripScriptSourcePaths,
  WORKFLOW_EXPORT_VERSION,
} from "./workflowIo";
import type { Workflow } from "@/types/workflow";

function sampleWorkflow(overrides: Partial<Workflow> = {}): Workflow {
  return {
    id: "wf-1",
    name: "Login",
    description: "Login sequence",
    tags: ["ops"],
    steps: [
      { kind: "send-command", command: "sudo -v" },
      { kind: "run-script", script: "a\nb", perLineDelayMs: 50 },
      { kind: "run-macro", macroId: "m-1" },
      { kind: "wait", delayMs: 500 },
      { kind: "run-local-process", program: "echo", args: ["done"] },
    ],
    triggers: [
      { kind: "manual" },
      { kind: "on-connect", connectionIds: ["prod-web-1"] },
      { kind: "hotkey", binding: "Ctrl+Alt+H" },
      { kind: "on-disconnect", connectionIds: ["prod-web-1"], when: "user-close" },
      {
        kind: "on-output-match",
        connectionIds: ["prod-web-1"],
        pattern: "ERROR \\d+",
        isRegex: true,
        cooldownMs: 5000,
        maxFiresPerSession: 3,
      },
    ],
    createdAt: "2026-07-24T00:00:00Z",
    updatedAt: "2026-07-24T00:00:00Z",
    ...overrides,
  };
}

describe("serializeWorkflows / parseWorkflowEnvelope", () => {
  it("round-trips a workflow with every step and trigger kind", () => {
    const wf = sampleWorkflow();
    const json = serializeWorkflows([wf]);
    expect(json.endsWith("\n")).toBe(true);

    const parsed = parseWorkflowEnvelope(json);
    expect(parsed).toEqual([wf]);
  });

  it("writes the current envelope version", () => {
    const json = serializeWorkflows([sampleWorkflow()]);
    expect(JSON.parse(json).version).toBe(WORKFLOW_EXPORT_VERSION);
  });

  it("rejects non-JSON input", () => {
    expect(() => parseWorkflowEnvelope("not json {")).toThrow(/not valid JSON/);
  });

  it("rejects an unsupported version", () => {
    const json = JSON.stringify({ version: 999, workflows: [] });
    expect(() => parseWorkflowEnvelope(json)).toThrow(/Unsupported workflow file version/);
  });

  it("rejects a missing workflows array", () => {
    const json = JSON.stringify({ version: WORKFLOW_EXPORT_VERSION });
    expect(() => parseWorkflowEnvelope(json)).toThrow(/missing "workflows" array/);
  });

  it("rejects a workflow with no name", () => {
    const json = JSON.stringify({
      version: WORKFLOW_EXPORT_VERSION,
      workflows: [{ steps: [] }],
    });
    expect(() => parseWorkflowEnvelope(json)).toThrow(/missing a name/);
  });

  it("rejects a step with an unknown kind", () => {
    const json = JSON.stringify({
      version: WORKFLOW_EXPORT_VERSION,
      workflows: [{ name: "X", steps: [{ kind: "teleport" }] }],
    });
    expect(() => parseWorkflowEnvelope(json)).toThrow(/unknown kind "teleport"/);
  });

  it("rejects a send-command missing its command", () => {
    const json = JSON.stringify({
      version: WORKFLOW_EXPORT_VERSION,
      workflows: [{ name: "X", steps: [{ kind: "send-command" }] }],
    });
    expect(() => parseWorkflowEnvelope(json)).toThrow(/missing "command"/);
  });

  it("rejects a wait with a negative delay", () => {
    const json = JSON.stringify({
      version: WORKFLOW_EXPORT_VERSION,
      workflows: [{ name: "X", steps: [{ kind: "wait", delayMs: -5 }] }],
    });
    expect(() => parseWorkflowEnvelope(json)).toThrow(/invalid "delayMs"/);
  });

  it("rejects an on-connect trigger with malformed connectionIds", () => {
    const json = JSON.stringify({
      version: WORKFLOW_EXPORT_VERSION,
      workflows: [
        { name: "X", steps: [], triggers: [{ kind: "on-connect", connectionIds: [42] }] },
      ],
    });
    expect(() => parseWorkflowEnvelope(json)).toThrow(/invalid "connectionIds"/);
  });

  it("rejects an on-disconnect trigger with an unknown cause", () => {
    const json = JSON.stringify({
      version: WORKFLOW_EXPORT_VERSION,
      workflows: [
        {
          name: "X",
          steps: [],
          triggers: [{ kind: "on-disconnect", connectionIds: [], when: "sometimes" }],
        },
      ],
    });
    expect(() => parseWorkflowEnvelope(json)).toThrow(/invalid "when"/);
  });

  it("rejects an on-output-match trigger with an invalid or unsafe regex", () => {
    const envelope = (pattern: string) =>
      JSON.stringify({
        version: WORKFLOW_EXPORT_VERSION,
        workflows: [
          {
            name: "X",
            steps: [],
            triggers: [{ kind: "on-output-match", connectionIds: [], pattern, isRegex: true }],
          },
        ],
      });
    expect(() => parseWorkflowEnvelope(envelope("(["))).toThrow(
      /unusable pattern \(invalid-regex\)/
    );
    expect(() => parseWorkflowEnvelope(envelope("(a+)+"))).toThrow(
      /unusable pattern \(unsafe-regex\)/
    );
  });

  it("rejects an on-output-match trigger with a negative cooldown", () => {
    const json = JSON.stringify({
      version: WORKFLOW_EXPORT_VERSION,
      workflows: [
        {
          name: "X",
          steps: [],
          triggers: [{ kind: "on-output-match", connectionIds: [], pattern: "x", cooldownMs: -1 }],
        },
      ],
    });
    expect(() => parseWorkflowEnvelope(json)).toThrow(/invalid "cooldownMs"/);
  });

  it("tolerates absent optional collections (triggers/tags/timestamps)", () => {
    const json = JSON.stringify({
      version: WORKFLOW_EXPORT_VERSION,
      workflows: [{ name: "Bare", steps: [{ kind: "send-command", command: "ls" }] }],
    });
    const parsed = parseWorkflowEnvelope(json);
    expect(parsed[0]).toMatchObject({
      name: "Bare",
      id: "",
      tags: [],
      triggers: [],
      createdAt: "",
      updatedAt: "",
    });
  });
});

describe("resolveImportCollisions", () => {
  let counter = 0;
  const genId = (): string => `gen-${(counter += 1)}`;

  it("gives each imported workflow a fresh id and clears timestamps", () => {
    counter = 0;
    const imported = [sampleWorkflow({ id: "old", createdAt: "x", updatedAt: "y" })];
    const [result] = resolveImportCollisions(imported, [], genId);

    expect(result.id).toBe("gen-1");
    expect(result.createdAt).toBe("");
    expect(result.updatedAt).toBe("");
  });

  it("de-duplicates a name that collides with the existing library", () => {
    counter = 0;
    const existing = [sampleWorkflow({ name: "Login" })];
    const imported = [sampleWorkflow({ name: "Login" })];
    const [result] = resolveImportCollisions(imported, existing, genId);

    expect(result.name).toBe("Login (imported)");
  });

  it("de-duplicates names that collide within the same batch", () => {
    counter = 0;
    const imported = [sampleWorkflow({ name: "Deploy" }), sampleWorkflow({ name: "Deploy" })];
    const results = resolveImportCollisions(imported, [], genId);

    expect(results.map((w) => w.name)).toEqual(["Deploy", "Deploy (imported)"]);
  });

  it("leaves a non-colliding name untouched", () => {
    counter = 0;
    const [result] = resolveImportCollisions([sampleWorkflow({ name: "Unique" })], [], genId);
    expect(result.name).toBe("Unique");
  });
});

describe("summarizeLocalProcessSteps", () => {
  it("reports zero for workflows with no local-process steps", () => {
    const wf = sampleWorkflow({ steps: [{ kind: "send-command", command: "ls" }] });
    expect(summarizeLocalProcessSteps([wf])).toEqual({
      workflowsWithLocalProcess: 0,
      localProcessSteps: 0,
    });
  });

  it("counts local-process steps and the workflows carrying them", () => {
    const withLocal = sampleWorkflow({
      name: "danger",
      steps: [
        { kind: "send-command", command: "ls" },
        { kind: "run-local-process", program: "echo", args: ["a"] },
        { kind: "run-local-process", program: "rm", args: ["-rf", "/"] },
      ],
    });
    const clean = sampleWorkflow({ name: "safe", steps: [{ kind: "wait", delayMs: 10 }] });

    expect(summarizeLocalProcessSteps([withLocal, clean])).toEqual({
      workflowsWithLocalProcess: 1,
      localProcessSteps: 2,
    });
  });

  it("descends into conditional branches so a nested local-process is still counted", () => {
    const wf = sampleWorkflow({
      name: "hidden",
      steps: [
        {
          kind: "conditional",
          condition: { left: "${env}", op: "eq", right: "prod" },
          then: [{ kind: "run-local-process", program: "deploy", args: [] }],
          else: [{ kind: "run-local-process", program: "rollback", args: [] }],
        },
      ],
    });
    expect(summarizeLocalProcessSteps([wf])).toEqual({
      workflowsWithLocalProcess: 1,
      localProcessSteps: 2,
    });
  });

  it("descends into a loop body so a nested local-process is still counted", () => {
    const wf = sampleWorkflow({
      name: "looped",
      steps: [
        {
          kind: "loop",
          loop: { kind: "count", count: 3 },
          body: [{ kind: "run-local-process", program: "poll", args: [] }],
        },
      ],
    });
    expect(summarizeLocalProcessSteps([wf])).toEqual({
      workflowsWithLocalProcess: 1,
      localProcessSteps: 1,
    });
  });
});

describe("parseWorkflowEnvelope conditional steps (PROD-0044)", () => {
  it("round-trips a conditional with a nested branch and an else", () => {
    const wf = sampleWorkflow({
      name: "cond",
      steps: [
        {
          kind: "conditional",
          condition: { left: "${env}", op: "contains", right: "prod" },
          then: [
            { kind: "send-command", command: "deploy" },
            {
              kind: "conditional",
              condition: { left: "1", op: "lt", right: "2" },
              then: [{ kind: "wait", delayMs: 5 }],
            },
          ],
          else: [{ kind: "send-command", command: "skip" }],
        },
      ],
    });
    const parsed = parseWorkflowEnvelope(serializeWorkflows([wf]));
    expect(parsed).toEqual([wf]);
  });

  it("rejects a conditional with an invalid operator", () => {
    const json = JSON.stringify({
      version: WORKFLOW_EXPORT_VERSION,
      workflows: [
        {
          name: "bad",
          steps: [
            {
              kind: "conditional",
              condition: { left: "a", op: "matches", right: "b" },
              then: [],
            },
          ],
        },
      ],
    });
    expect(() => parseWorkflowEnvelope(json)).toThrow(/invalid condition operator/);
  });

  it("rejects a conditional missing its then array", () => {
    const json = JSON.stringify({
      version: WORKFLOW_EXPORT_VERSION,
      workflows: [
        {
          name: "bad",
          steps: [{ kind: "conditional", condition: { left: "a", op: "eq", right: "b" } }],
        },
      ],
    });
    expect(() => parseWorkflowEnvelope(json)).toThrow(/missing "then"/);
  });
});

describe("parseWorkflowEnvelope loop and wait-for-output steps (PROD-044)", () => {
  it("round-trips a count loop and a while loop with bodies", () => {
    const wf = sampleWorkflow({
      name: "loops",
      steps: [
        {
          kind: "loop",
          loop: { kind: "count", count: 3 },
          body: [{ kind: "send-command", command: "echo ${iteration}" }],
        },
        {
          kind: "loop",
          loop: { kind: "while", condition: { left: "${iteration}", op: "lt", right: "5" } },
          body: [{ kind: "wait", delayMs: 10 }],
        },
      ],
    });
    const parsed = parseWorkflowEnvelope(serializeWorkflows([wf]));
    expect(parsed).toEqual([wf]);
  });

  it("round-trips a wait-for-output step with and without optional fields", () => {
    const wf = sampleWorkflow({
      name: "waits",
      steps: [
        { kind: "wait-for-output", pattern: "login:" },
        { kind: "wait-for-output", pattern: "\\d+", isRegex: true, timeoutMs: 5000 },
      ],
    });
    const parsed = parseWorkflowEnvelope(serializeWorkflows([wf]));
    expect(parsed).toEqual([wf]);
  });

  it("rejects a loop with an invalid mode", () => {
    const json = JSON.stringify({
      version: WORKFLOW_EXPORT_VERSION,
      workflows: [{ name: "bad", steps: [{ kind: "loop", loop: { kind: "forever" } }] }],
    });
    expect(() => parseWorkflowEnvelope(json)).toThrow(/invalid "loop" mode/);
  });

  it("rejects a count loop with a negative count", () => {
    const json = JSON.stringify({
      version: WORKFLOW_EXPORT_VERSION,
      workflows: [{ name: "bad", steps: [{ kind: "loop", loop: { kind: "count", count: -1 } }] }],
    });
    expect(() => parseWorkflowEnvelope(json)).toThrow(/invalid "count"/);
  });

  it("rejects a wait-for-output step missing its pattern", () => {
    const json = JSON.stringify({
      version: WORKFLOW_EXPORT_VERSION,
      workflows: [{ name: "bad", steps: [{ kind: "wait-for-output" }] }],
    });
    expect(() => parseWorkflowEnvelope(json)).toThrow(/missing "pattern"/);
  });
});

describe("parseWorkflowEnvelope step error handling (PROD-045)", () => {
  const envelopeWith = (step: unknown): string =>
    JSON.stringify({ version: WORKFLOW_EXPORT_VERSION, workflows: [{ name: "X", steps: [step] }] });

  it("round-trips continueOnError and a retry policy, including nested steps", () => {
    const wf = sampleWorkflow({
      steps: [
        {
          kind: "send-command",
          command: "flaky",
          continueOnError: true,
          retry: { count: 3, delayMs: 250, backoff: "exponential" },
        },
        {
          kind: "loop",
          loop: { kind: "count", count: 2 },
          body: [{ kind: "wait", delayMs: 10, retry: { count: 1 } }],
        },
      ],
    });
    const [parsed] = parseWorkflowEnvelope(serializeWorkflows([wf]));
    expect(parsed.steps).toEqual(wf.steps);
  });

  it("does not add error-handling keys to a step that has none", () => {
    const [parsed] = parseWorkflowEnvelope(envelopeWith({ kind: "send-command", command: "ls" }));
    expect(parsed.steps[0]).toEqual({ kind: "send-command", command: "ls" });
  });

  it("rejects a non-boolean continueOnError", () => {
    expect(() =>
      parseWorkflowEnvelope(
        envelopeWith({ kind: "send-command", command: "ls", continueOnError: "yes" })
      )
    ).toThrow(/invalid "continueOnError"/);
  });

  it.each([
    [{ count: -1 }],
    [{ count: 1.5 }],
    [{ count: 2, delayMs: -10 }],
    [{ count: 2, backoff: "linear" }],
    ["3"],
  ])("rejects a malformed retry policy %j", (retry) => {
    expect(() =>
      parseWorkflowEnvelope(envelopeWith({ kind: "send-command", command: "ls", retry }))
    ).toThrow(/invalid "retry" policy/);
  });
});

/** Wrap raw (unvalidated) workflow objects in a current-version envelope. */
function rawEnvelope(...workflows: unknown[]): string {
  return JSON.stringify({ version: WORKFLOW_EXPORT_VERSION, workflows });
}

/** A single raw workflow carrying the given raw steps. */
function rawStepsEnvelope(...steps: unknown[]): string {
  return rawEnvelope({ name: "X", steps });
}

describe("stripScriptSourcePaths (#4310, FEC2-001)", () => {
  it("removes sourcePath from imported run-script steps and reports each removed path", () => {
    const parsed = parseWorkflowEnvelope(
      rawStepsEnvelope(
        { kind: "run-script", script: "echo harmless", sourcePath: "~/.ssh/id_ed25519" },
        { kind: "run-script", script: "uptime" }
      )
    );
    const { workflows, removedPaths } = stripScriptSourcePaths(parsed);

    expect(workflows[0].steps).toEqual([
      { kind: "run-script", script: "echo harmless" },
      { kind: "run-script", script: "uptime" },
    ]);
    expect(removedPaths).toEqual(["~/.ssh/id_ed25519"]);
  });

  it("strips sourcePath nested inside conditional branches and loop bodies", () => {
    const parsed = parseWorkflowEnvelope(
      rawStepsEnvelope(
        {
          kind: "conditional",
          condition: { left: "a", op: "eq", right: "a" },
          then: [{ kind: "run-script", script: "t", sourcePath: "/then.sh" }],
          else: [{ kind: "run-script", script: "e", sourcePath: "/else.sh" }],
        },
        {
          kind: "loop",
          loop: { kind: "count", count: 2 },
          body: [{ kind: "run-script", script: "b", sourcePath: "/body.sh" }],
        }
      )
    );
    const { workflows, removedPaths } = stripScriptSourcePaths(parsed);

    expect(JSON.stringify(workflows)).not.toContain("sourcePath");
    expect(removedPaths).toEqual(["/then.sh", "/else.sh", "/body.sh"]);
  });

  it("reports nothing and keeps steps intact when no step carries a sourcePath", () => {
    const wf = sampleWorkflow();
    const { workflows, removedPaths } = stripScriptSourcePaths([wf]);
    expect(workflows).toEqual([wf]);
    expect(removedPaths).toEqual([]);
  });

  it("does not mutate the input workflows", () => {
    const parsed = parseWorkflowEnvelope(
      rawStepsEnvelope({ kind: "run-script", script: "s", sourcePath: "/x.sh" })
    );
    stripScriptSourcePaths(parsed);
    expect(parsed[0].steps[0]).toEqual({ kind: "run-script", script: "s", sourcePath: "/x.sh" });
  });

  it("ignores a forged 'user-chosen' marker in the imported JSON", () => {
    const parsed = parseWorkflowEnvelope(
      rawStepsEnvelope({
        kind: "run-script",
        script: "s",
        sourcePath: "/home/u/.aws/credentials",
        sourcePathConfirmed: true,
        userChosen: true,
        trusted: true,
      })
    );
    // The validator only copies known fields, so a forged marker never survives…
    expect(parsed[0].steps[0]).toEqual({
      kind: "run-script",
      script: "s",
      sourcePath: "/home/u/.aws/credentials",
    });
    // …and the import strip removes the path itself regardless.
    const { workflows } = stripScriptSourcePaths(parsed);
    expect(workflows[0].steps[0]).toEqual({ kind: "run-script", script: "s" });
  });
});

describe("parseWorkflowEnvelope run-script / wait / run-local-process rejections (TFE2-005)", () => {
  it("rejects a run-script missing its script", () => {
    expect(() => parseWorkflowEnvelope(rawStepsEnvelope({ kind: "run-script" }))).toThrow(
      'Invalid workflow file: step 0 of workflow at index 0 ("X") (run-script) is missing "script".'
    );
  });

  it.each([[-1], ["50"]])("rejects a run-script with an invalid per-line delay %j", (delay) => {
    expect(() =>
      parseWorkflowEnvelope(
        rawStepsEnvelope({ kind: "run-script", script: "a", perLineDelayMs: delay })
      )
    ).toThrow(
      'Invalid workflow file: step 0 of workflow at index 0 ("X") (run-script) has an invalid delay.'
    );
  });

  it("rejects a run-script with a non-string sourcePath", () => {
    expect(() =>
      parseWorkflowEnvelope(rawStepsEnvelope({ kind: "run-script", script: "a", sourcePath: 7 }))
    ).toThrow(
      'Invalid workflow file: step 0 of workflow at index 0 ("X") (run-script) has an invalid sourcePath.'
    );
  });

  it.each([[-5], ["100"], [Number.POSITIVE_INFINITY]])(
    "rejects a wait with an invalid delayMs %j",
    (delayMs) => {
      // JSON.stringify turns Infinity into null, which is also not a number.
      expect(() => parseWorkflowEnvelope(rawStepsEnvelope({ kind: "wait", delayMs }))).toThrow(
        'Invalid workflow file: step 0 of workflow at index 0 ("X") (wait) has an invalid "delayMs".'
      );
    }
  );

  it("rejects a run-local-process missing its program", () => {
    expect(() =>
      parseWorkflowEnvelope(rawStepsEnvelope({ kind: "run-local-process", args: [] }))
    ).toThrow(
      'Invalid workflow file: step 0 of workflow at index 0 ("X") (run-local-process) is missing "program".'
    );
  });

  it.each([
    ["non-array args", "--flag"],
    ["missing args", undefined],
    ["non-string args", ["ok", 3]],
  ])("rejects a run-local-process with %s", (_label, args) => {
    expect(() =>
      parseWorkflowEnvelope(rawStepsEnvelope({ kind: "run-local-process", program: "echo", args }))
    ).toThrow(
      'Invalid workflow file: step 0 of workflow at index 0 ("X") (run-local-process) has invalid "args".'
    );
  });
});

describe("parseWorkflowEnvelope parameters (PROD-0040, TFE2-005)", () => {
  it("round-trips a parameter of each type, preserving label/default/required/options", () => {
    const wf = sampleWorkflow({
      parameters: [
        { name: "host", type: "string", label: "Host", default: "web-1", required: true },
        { name: "port", type: "number", default: 22 },
        { name: "dryRun", type: "boolean", default: false, required: false },
        { name: "env", type: "enum", options: ["dev", "prod"], default: "dev" },
      ],
    });
    const [parsed] = parseWorkflowEnvelope(serializeWorkflows([wf]));
    expect(parsed).toEqual(wf);
  });

  it("does not add an empty parameters key for a parameter-free workflow", () => {
    const [fromEmpty] = parseWorkflowEnvelope(
      rawEnvelope({ name: "X", steps: [], parameters: [] })
    );
    const [fromAbsent] = parseWorkflowEnvelope(rawEnvelope({ name: "X", steps: [] }));
    expect("parameters" in fromEmpty).toBe(false);
    expect("parameters" in fromAbsent).toBe(false);
  });

  it("does not add absent optional keys to a minimal parameter", () => {
    const [parsed] = parseWorkflowEnvelope(
      rawEnvelope({ name: "X", steps: [], parameters: [{ name: "p", type: "string" }] })
    );
    expect(parsed.parameters).toEqual([{ name: "p", type: "string" }]);
  });

  it("rejects non-array parameters", () => {
    expect(() =>
      parseWorkflowEnvelope(rawEnvelope({ name: "X", steps: [], parameters: { name: "p" } }))
    ).toThrow('Invalid workflow file: workflow at index 0 ("X") has malformed parameters.');
  });

  const at = 'Invalid workflow file: parameter 0 of workflow at index 0 ("X")';
  it.each([
    ["a non-object parameter", "p", `${at} is malformed.`],
    ["a missing name", { type: "string" }, `${at} is missing a name.`],
    ["a blank name", { name: "  ", type: "string" }, `${at} is missing a name.`],
    ["an unknown type", { name: "p", type: "date" }, `${at} has unknown type "date".`],
    ["a missing type", { name: "p" }, `${at} has unknown type "undefined".`],
    [
      "a non-string label",
      { name: "p", type: "string", label: 1 },
      `${at} has a non-string "label".`,
    ],
    [
      "an object default",
      { name: "p", type: "string", default: { x: 1 } },
      `${at} has an invalid "default".`,
    ],
    [
      "a non-boolean required",
      { name: "p", type: "string", required: "yes" },
      `${at} has a non-boolean "required".`,
    ],
    [
      "non-array options",
      { name: "p", type: "enum", options: "a,b" },
      `${at} has invalid "options".`,
    ],
    [
      "non-string options",
      { name: "p", type: "enum", options: ["a", 2] },
      `${at} has invalid "options".`,
    ],
  ])("rejects %s", (_label, param, message) => {
    expect(() =>
      parseWorkflowEnvelope(rawEnvelope({ name: "X", steps: [], parameters: [param] }))
    ).toThrow(message);
  });
});
