import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { listWorkflows, getWorkflow, saveWorkflow, deleteWorkflow } from "./workflowApi";
import type { Workflow } from "@/types/workflow";

const mockedInvoke = vi.mocked(invoke);

function sampleWorkflow(): Workflow {
  return {
    id: "wf-1",
    name: "Login",
    description: "Login sequence",
    tags: ["ops"],
    steps: [{ kind: "send-command", command: "sudo -v" }],
    triggers: [{ kind: "manual" }],
    createdAt: "2026-07-24T00:00:00Z",
    updatedAt: "2026-07-24T00:00:00Z",
  };
}

describe("workflowApi", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("listWorkflows invokes correct command", async () => {
    mockedInvoke.mockResolvedValue([]);
    const result = await listWorkflows();
    expect(mockedInvoke).toHaveBeenCalledWith("list_workflows");
    expect(result).toEqual([]);
  });

  it("getWorkflow invokes correct command with id", async () => {
    const workflow = sampleWorkflow();
    mockedInvoke.mockResolvedValue(workflow);
    const result = await getWorkflow("wf-1");
    expect(mockedInvoke).toHaveBeenCalledWith("get_workflow", { workflowId: "wf-1" });
    expect(result).toEqual(workflow);
  });

  it("saveWorkflow invokes correct command with workflowDef arg", async () => {
    const workflow = sampleWorkflow();
    mockedInvoke.mockResolvedValue(workflow);
    const result = await saveWorkflow(workflow);
    expect(mockedInvoke).toHaveBeenCalledWith("save_workflow", { workflowDef: workflow });
    expect(result).toEqual(workflow);
  });

  it("deleteWorkflow invokes correct command with id", async () => {
    mockedInvoke.mockResolvedValue(undefined);
    await deleteWorkflow("wf-1");
    expect(mockedInvoke).toHaveBeenCalledWith("delete_workflow", { workflowId: "wf-1" });
  });
});
