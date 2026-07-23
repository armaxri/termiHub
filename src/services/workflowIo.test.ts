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
});
