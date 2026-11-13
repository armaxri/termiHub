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
    // One empty-state wording with the macro history (R-081, #5680).
    expect(query("workflow-history-empty")?.textContent).toBe("No runs yet.");
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

  it("keeps the run metadata on one truncating line (R-082, #5680)", () => {
    render([run({ id: "r-local", targetLabel: "pr-auto-local-with-a-long-identifier" })]);
    const meta = query("workflow-run-meta-r-local")!;
    expect(meta.classList.contains("ui-truncate")).toBe(true);
    expect(meta.classList.contains("workflow-history__meta")).toBe(true);
    expect(meta.contains(query("workflow-run-target-r-local"))).toBe(true);
  });

  it("names the target terminal so runs on different terminals differ (#5635)", () => {
    render([
      run({ id: "r-local", tabId: "tab-1", targetLabel: "pr-auto-local" }),
      run({ id: "r-ssh", tabId: "tab-2", targetLabel: "pr-auto-ssh" }),
      run({ id: "r-old", tabId: "tab-3" }),
    ]);
    expect(query("workflow-run-target-r-local")?.textContent).toBe("pr-auto-local");
    expect(query("workflow-run-target-r-ssh")?.textContent).toBe("pr-auto-ssh");
    expect(query("workflow-run-r-local")?.textContent).not.toBe(
      query("workflow-run-r-ssh")?.textContent
    );
    // Older records carry no label: no target is shown (never a raw tab id).
    expect(query("workflow-run-target-r-old")).toBeNull();
    expect(query("workflow-run-r-old")?.textContent).not.toContain("tab-3");
  });

  it("notes tolerated continue-on-error failures on a run (PROD-045)", () => {
    render([run({ id: "r-soft", continuedFailures: 2 }), run({ id: "r-clean" })]);
    expect(query("workflow-run-tolerated-r-soft")?.textContent).toContain("2 tolerated failures");
    expect(query("workflow-run-tolerated-r-clean")).toBeNull();
  });

  it("labels the Clear history action with visible text (#5719)", () => {
    render([run()]);
    const clear = query("workflow-history-clear") as HTMLButtonElement;
    expect(clear.disabled).toBe(false);
    expect(clear.textContent).toContain("Clear…");
    expect(clear.getAttribute("aria-label")).toBe("Clear history");
  });

  it("asks for confirmation before clearing the history (#5719)", async () => {
    render([run()]);
    await act(async () => {
      query("workflow-history-clear")!.click();
    });
    expect(clearWorkflowRunHistory).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Clear workflow run history?");
    const confirm = document.querySelector<HTMLButtonElement>(
      '[data-testid="workflow-history-clear-confirm-confirm"]'
    );
    expect(confirm).not.toBeNull();
    await act(async () => {
      confirm!.click();
    });
    expect(clearWorkflowRunHistory).toHaveBeenCalledTimes(1);
  });

  it("keeps the history when the confirmation is cancelled (#5719)", async () => {
    render([run()]);
    await act(async () => {
      query("workflow-history-clear")!.click();
    });
    await act(async () => {
      document
        .querySelector<HTMLButtonElement>('[data-testid="workflow-history-clear-confirm-cancel"]')!
        .click();
    });
    expect(clearWorkflowRunHistory).not.toHaveBeenCalled();
    expect(
      document.querySelector('[data-testid="workflow-history-clear-confirm-confirm"]')
    ).toBeNull();
  });
});
