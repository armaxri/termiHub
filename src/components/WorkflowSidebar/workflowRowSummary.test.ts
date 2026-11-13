import { describe, it, expect } from "vitest";
import type { Workflow, WorkflowTrigger } from "@/types/workflow";
import { armedDescription, armedTriggers, workflowRowSummary } from "./workflowRowSummary";

function workflow(triggers: WorkflowTrigger[]): Workflow {
  return {
    id: "w1",
    name: "Deploy",
    tags: [],
    steps: [],
    triggers,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

const NAMES: Record<string, string> = { a: "alpha", b: "beta", c: "gamma" };
const name = (id: string): string | undefined => NAMES[id];

describe("workflowRowSummary (#5635)", () => {
  it("is 'Manual' with no automatic or hotkey trigger", () => {
    expect(workflowRowSummary(workflow([{ kind: "manual" }]), name)).toBe("Manual");
    expect(workflowRowSummary(workflow([]), name)).toBe("Manual");
  });

  it("lists the first connections and counts the rest", () => {
    const w = workflow([{ kind: "on-disconnect", connectionIds: ["a", "b", "c"] }]);
    expect(workflowRowSummary(w, name)).toBe("On disconnect · alpha, beta +1");
  });

  it("joins several triggers and marks unknown connections", () => {
    const w = workflow([
      { kind: "on-connect", connectionIds: ["zzz"] },
      { kind: "hotkey", binding: "Ctrl+Alt+D" },
    ]);
    expect(workflowRowSummary(w, name)).toBe("On connect · Unknown connection; Hotkey Ctrl+Alt+D");
  });

  it("treats only connection-bound automatic triggers as armed", () => {
    expect(armedTriggers(workflow([{ kind: "hotkey", binding: "X" }]))).toHaveLength(0);
    expect(armedTriggers(workflow([{ kind: "on-connect", connectionIds: [] }]))).toHaveLength(0);
    const w = workflow([{ kind: "on-output-match", connectionIds: ["a"], pattern: "x" }]);
    expect(armedTriggers(w)).toHaveLength(1);
    expect(armedDescription(w, name)).toBe("Runs automatically: on output match of alpha");
  });
});
