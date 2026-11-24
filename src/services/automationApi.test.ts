import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import {
  clearAutomationRunHistory,
  deleteAutomation,
  getAutomation,
  listAutomationRuns,
  listAutomations,
  recordAutomationRun,
  saveAutomation,
} from "./automationApi";
import type { Automation } from "@/types/generated/Automation";
import type { AutomationRun } from "@/types/generated/AutomationRun";

const mockedInvoke = vi.mocked(invoke);

const automation: Automation = {
  id: "a-1",
  name: "Deploy",
  tags: [],
  steps: [{ kind: "send-command", command: "make deploy" }],
  triggers: [],
  createdAt: "",
  updatedAt: "",
};

const run: AutomationRun = {
  id: "r-1",
  automationId: "a-1",
  automationName: "Deploy",
  startedAt: "2026-11-24T10:00:00Z",
  endedAt: "2026-11-24T10:00:01Z",
  status: "completed",
  stepsCompleted: 1,
  total: 1,
  origin: "manual",
};

describe("automationApi (#5818, slice 4)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("invokes the library commands with their argument keys", async () => {
    mockedInvoke.mockResolvedValue([automation]);
    expect(await listAutomations()).toEqual([automation]);
    expect(mockedInvoke).toHaveBeenLastCalledWith("list_automations");

    mockedInvoke.mockResolvedValue(automation);
    expect(await getAutomation("a-1")).toEqual(automation);
    expect(mockedInvoke).toHaveBeenLastCalledWith("get_automation", { automationId: "a-1" });

    expect(await saveAutomation(automation)).toEqual(automation);
    expect(mockedInvoke).toHaveBeenLastCalledWith("save_automation", { automation });

    mockedInvoke.mockResolvedValue(undefined);
    await deleteAutomation("a-1");
    expect(mockedInvoke).toHaveBeenLastCalledWith("delete_automation", { automationId: "a-1" });
  });

  it("invokes the run-history commands with their argument keys", async () => {
    mockedInvoke.mockResolvedValue([run]);
    expect(await listAutomationRuns()).toEqual([run]);
    expect(mockedInvoke).toHaveBeenLastCalledWith("list_automation_runs");

    expect(await recordAutomationRun(run)).toEqual([run]);
    expect(mockedInvoke).toHaveBeenLastCalledWith("record_automation_run", { run });

    mockedInvoke.mockResolvedValue([]);
    await clearAutomationRunHistory(["r-1"]);
    expect(mockedInvoke).toHaveBeenLastCalledWith("clear_automation_run_history", {
      runIds: ["r-1"],
    });
    await clearAutomationRunHistory();
    expect(mockedInvoke).toHaveBeenLastCalledWith("clear_automation_run_history", {
      runIds: undefined,
    });
  });
});
