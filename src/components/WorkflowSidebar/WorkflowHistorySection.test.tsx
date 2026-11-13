import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { WorkflowHistorySection } from "./WorkflowHistorySection";
import { withTooltip } from "@/test/tooltip";
import { useAppStore } from "@/store/appStore";
import type { WorkflowRun } from "@/types/workflow";

function run(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: "run-1",
    workflowId: "w1",
    workflowName: "Bootstrap",
    startedAt: "2026-09-20T00:00:00Z",
    endedAt: "2026-09-20T00:00:03Z",
    status: "completed",
    stepsCompleted: 2,
    total: 2,
    triggeredBy: "manual",
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;
let loadWorkflowRuns: ReturnType<typeof vi.fn<() => Promise<void>>>;
let clearWorkflowRunHistory: ReturnType<typeof vi.fn<() => Promise<void>>>;

function query(testId: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${testId}"]`);
}

function render(runs: WorkflowRun[]) {
  useAppStore.setState({ workflowRuns: runs, loadWorkflowRuns, clearWorkflowRunHistory });
  act(() => {
    root.render(withTooltip(<WorkflowHistorySection />));
  });
}

describe("WorkflowHistorySection (PROD-0046)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    loadWorkflowRuns = vi.fn<() => Promise<void>>(() => Promise.resolve());
    clearWorkflowRunHistory = vi.fn<() => Promise<void>>(() => Promise.resolve());
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    useAppStore.setState(useAppStore.getInitialState());
    vi.clearAllMocks();
  });

  it("loads the run history on mount", () => {
    render([]);
    expect(loadWorkflowRuns).toHaveBeenCalledTimes(1);
  });

  it("shows the empty state and disables Clear when there are no runs", () => {
    render([]);
    expect(query("workflow-history-empty")).not.toBeNull();
    expect(query("workflow-history-list")).toBeNull();
    expect((query("workflow-history-clear") as HTMLButtonElement)?.disabled).toBe(true);
  });

  it("renders a row per run with name, step progress and status", () => {
    render([
      run({ id: "r-ok", workflowName: "Deploy", stepsCompleted: 3, total: 3, status: "completed" }),
      run({
        id: "r-bad",
        workflowName: "Migrate",
        stepsCompleted: 1,
        total: 4,
        status: "failed",
        failedStepIndex: 1,
        error: "boom",
      }),
    ]);

    expect(query("workflow-run-r-ok")).not.toBeNull();
    expect(query("workflow-run-r-bad")).not.toBeNull();
    expect(query("workflow-run-r-ok")?.textContent).toContain("Deploy");
    // A run that finished every step shows no redundant "3/3"; a run that
    // stopped early notes how far it got, after the name (#5519).
    expect(query("workflow-run-r-ok")?.textContent).not.toContain("3/3");
    expect(query("workflow-run-progress-r-ok")).toBeNull();
    expect(query("workflow-run-r-bad")?.textContent).toContain("Migrate");
    expect(query("workflow-run-progress-r-bad")?.textContent).toContain("1/4 steps");
    expect(
      query("workflow-run-r-bad")
        ?.querySelector(".sidebar-list-item__header")
        ?.textContent?.includes("1/4")
    ).toBe(false);
    // The trigger provenance is surfaced in the row detail, as a readable label
    // rather than the raw trigger id (#5529).
    expect(query("workflow-run-r-ok")?.textContent).toContain("Manual");
  });

  it("notes tolerated continue-on-error failures on a run (PROD-045)", () => {
    render([run({ id: "r-soft", continuedFailures: 2 }), run({ id: "r-clean" })]);
    expect(query("workflow-run-tolerated-r-soft")?.textContent).toContain("2 tolerated failures");
    expect(query("workflow-run-tolerated-r-clean")).toBeNull();
  });

  it("clears the history via the Clear action", () => {
    render([run()]);
    const clear = query("workflow-history-clear") as HTMLButtonElement;
    expect(clear.disabled).toBe(false);
    act(() => clear.click());
    expect(clearWorkflowRunHistory).toHaveBeenCalledTimes(1);
  });
});
