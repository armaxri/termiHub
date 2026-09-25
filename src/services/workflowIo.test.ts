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
