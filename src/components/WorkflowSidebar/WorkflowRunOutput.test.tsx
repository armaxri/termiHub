import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { WorkflowRunOutput } from "./WorkflowRunOutput";
import { withTooltip } from "@/test/tooltip";
import { useAppStore, type WorkflowRunOutputState } from "@/store/appStore";
import {
  setWorkflowOutputContentForTest,
  setWorkflowRunViewForTest,
} from "@/store/workflowRunBridge";

let container: HTMLDivElement;
let root: Root;

function query(testId: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testId}"]`);
}

/** Build a run-output state, overriding only the fields a test cares about. */
function makeRun(overrides: Partial<WorkflowRunOutputState> = {}): WorkflowRunOutputState {
  return {
    workflowId: "workflow-1",
    workflowName: "Build",
    program: "make",
    args: ["build"],
    lines: [],
    status: "running",
    exitCode: null,
    timedOut: false,
    ...overrides,
  };
}

const dismissWorkflowRunOutput = vi.fn();
const cancelWorkflowRun = vi.fn();

describe("WorkflowRunOutput", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.clearAllMocks();
    // The dismiss/cancel actions remain appStore methods; the panel's live state
    // is projected (region view) + frontend-owned streamed content (bridge store).
    useAppStore.setState({ dismissWorkflowRunOutput, cancelWorkflowRun });
    setWorkflowRunViewForTest({ run: null, output: null });
    setWorkflowOutputContentForTest(null);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    setWorkflowRunViewForTest({ run: null, output: null });
    setWorkflowOutputContentForTest(null);
  });

  function render() {
    act(() => {
      root.render(withTooltip(<WorkflowRunOutput />));
    });
  }

  /** Drive the panel by splitting a run-output state into its projected status
   * seam (region view) and its frontend-owned streamed content (bridge store). */
  function setRun(run: WorkflowRunOutputState | null) {
    act(() => {
      if (!run) {
        setWorkflowRunViewForTest({ run: null, output: null });
        setWorkflowOutputContentForTest(null);
        return;
      }
      setWorkflowRunViewForTest({
        run: null,
        output: {
          workflowId: run.workflowId,
          workflowName: run.workflowName,
          program: run.program,
          args: run.args,
          status: run.status,
          error: run.error ?? null,
        },
      });
      setWorkflowOutputContentForTest({
        workflowId: run.workflowId,
        lines: run.lines,
        exitCode: run.exitCode,
        timedOut: run.timedOut,
      });
    });
  }

  it("renders nothing when there is no run output", () => {
    render();
    expect(query("workflow-run-output")).toBeNull();
  });

  it("shows the running status, command line, and a stop control while running", () => {
    render();
    setRun(makeRun());
    expect(query("workflow-run-output")).not.toBeNull();
    expect(query("workflow-run-output-status")?.getAttribute("data-status")).toBe("running");
    expect(query("workflow-run-output-command")?.textContent).toContain("make build");
    expect(query("workflow-run-output-stop")).not.toBeNull();
    expect(query("workflow-run-output-dismiss")).toBeNull();
    // No terminal outcome yet while running with no exit code.
    expect(query("workflow-run-output-outcome")).toBeNull();
  });

  it("renders streamed stdout/stderr lines incrementally as they arrive", () => {
    render();
    setRun(makeRun({ lines: [{ id: 0, stream: "stdout", text: "compiling" }] }));
    let stream = query("workflow-run-output-stream")!;
    expect(stream.querySelectorAll(".workflow-run-output__line")).toHaveLength(1);
    expect(stream.textContent).toContain("compiling");

    // A second event appends without dropping the first (incremental render).
    setRun(
      makeRun({
        lines: [
          { id: 0, stream: "stdout", text: "compiling" },
          { id: 1, stream: "stderr", text: "warning: unused" },
        ],
      })
    );
    stream = query("workflow-run-output-stream")!;
    const lines = stream.querySelectorAll(".workflow-run-output__line");
    expect(lines).toHaveLength(2);
    expect(lines[0].textContent).toContain("compiling");
    expect(lines[1].textContent).toContain("warning: unused");
    // The stderr line is tagged distinctly from stdout.
    expect(lines[0].getAttribute("data-stream")).toBe("stdout");
    expect(lines[1].getAttribute("data-stream")).toBe("stderr");
  });

  it("surfaces the exit code and a dismiss control on a completed run", () => {
    render();
    setRun(makeRun({ status: "completed", exitCode: 0 }));
    expect(query("workflow-run-output-status")?.getAttribute("data-status")).toBe("completed");
    expect(query("workflow-run-output-outcome")?.textContent).toContain("Exit code 0");
    expect(query("workflow-run-output-dismiss")).not.toBeNull();
    expect(query("workflow-run-output-stop")).toBeNull();
  });

  it("shows the failing exit code on a failed run", () => {
    render();
    setRun(makeRun({ status: "failed", exitCode: 2, error: "exited with code 2" }));
    expect(query("workflow-run-output-status")?.getAttribute("data-status")).toBe("failed");
    expect(query("workflow-run-output-outcome")?.textContent).toContain("Exit code 2");
  });

  it("shows a cancelled outcome when the run was cancelled", () => {
    render();
    setRun(makeRun({ status: "cancelled", exitCode: null }));
    expect(query("workflow-run-output-status")?.getAttribute("data-status")).toBe("cancelled");
    expect(query("workflow-run-output-outcome")?.textContent).toContain("Cancelled");
  });

  it("shows a timeout outcome when the process timed out", () => {
    render();
    setRun(makeRun({ status: "failed", exitCode: null, timedOut: true }));
    expect(query("workflow-run-output-outcome")?.textContent).toContain("Timed out");
  });

  it("stops the run when the stop control is clicked", () => {
    render();
    setRun(makeRun());
    act(() => {
      query("workflow-run-output-stop")?.click();
    });
    expect(cancelWorkflowRun).toHaveBeenCalledTimes(1);
  });

  it("dismisses the surface when the dismiss control is clicked", () => {
    render();
    setRun(makeRun({ status: "completed", exitCode: 0 }));
    act(() => {
      query("workflow-run-output-dismiss")?.click();
    });
    expect(dismissWorkflowRunOutput).toHaveBeenCalledTimes(1);
  });

  it("shows a waiting placeholder when running with no output yet", () => {
    render();
    setRun(makeRun());
    expect(query("workflow-run-output-empty")?.textContent).toContain("Waiting for output");
  });
});
