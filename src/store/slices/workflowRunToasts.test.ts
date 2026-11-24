/**
 * Repeated workflow runs collapse into one visible outcome toast (#5675): a
 * clean outcome replaces the previous clean outcome, a failure is never
 * replaced, and a run that restarts on an id is never dismissed by another.
 * A clean single-target run raises no toast at all (#5859).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  toast: {
    success: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    loading: vi.fn(),
    dismiss: vi.fn(),
  },
}));

vi.mock("@/components/ui", () => ({ toast: mocks.toast }));

import { toastRunOutcome } from "./workflowRunOnTarget";
import { toastFanoutSummary } from "./workflowFanout";
import { claimWorkflowRunToast, resetWorkflowRunToasts } from "./workflowRunToasts";

const OK = { status: "completed", stepsCompleted: 3 } as const;
const FAILED = { status: "failed", stepsCompleted: 1, error: "nope" } as const;
const CANCELLED = { status: "cancelled", stepsCompleted: 1 } as const;

describe("workflow run outcome toasts (#5675)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetWorkflowRunToasts();
  });

  it("raises no success toast for a clean single-target run (#5859)", () => {
    toastRunOutcome("deploy", OK, 3, "workflow-run-w1-t1");
    // The terminal output and the run history show it; its loading toast goes.
    expect(mocks.toast.success).not.toHaveBeenCalled();
    expect(mocks.toast.dismiss.mock.calls).toEqual([["workflow-run-w1-t1"]]);
  });

  it("replaces the previous run's canceled toast with the next one", () => {
    toastRunOutcome("deploy", CANCELLED, 3, "workflow-run-w1-t1");
    toastRunOutcome("cleanup", CANCELLED, 3, "workflow-run-w2-t1");
    toastRunOutcome("deploy", CANCELLED, 3, "workflow-run-w1-t2");
    expect(mocks.toast.info).toHaveBeenCalledTimes(3);
    expect(mocks.toast.dismiss.mock.calls).toEqual([
      ["workflow-run-w1-t1"],
      ["workflow-run-w2-t1"],
    ]);
  });

  it("reuses the toast in place when the same workflow reruns on the same tab", () => {
    toastRunOutcome("deploy", CANCELLED, 3, "workflow-run-w1-t1");
    claimWorkflowRunToast("workflow-run-w1-t1");
    toastRunOutcome("deploy", CANCELLED, 3, "workflow-run-w1-t1");
    expect(mocks.toast.info.mock.calls.map(([, opts]) => opts.id)).toEqual([
      "workflow-run-w1-t1",
      "workflow-run-w1-t1",
    ]);
    expect(mocks.toast.dismiss).not.toHaveBeenCalled();
  });

  it("never dismisses a failure for a later outcome", () => {
    toastRunOutcome("deploy", FAILED, 3, "workflow-run-w1-t1");
    toastRunOutcome("cleanup", CANCELLED, 3, "workflow-run-w2-t1");
    toastRunOutcome("cleanup", CANCELLED, 3, "workflow-run-w2-t2");
    expect(mocks.toast.error).toHaveBeenCalledTimes(1);
    expect(mocks.toast.dismiss.mock.calls).toEqual([["workflow-run-w2-t1"]]);
  });

  it("does not dismiss a run that restarted on the last outcome's id", () => {
    toastRunOutcome("deploy", CANCELLED, 3, "workflow-run-w1-t1");
    // The same workflow runs again on that tab: its loading toast takes the id.
    claimWorkflowRunToast("workflow-run-w1-t1");
    toastRunOutcome("cleanup", CANCELLED, 3, "workflow-run-w2-t1");
    expect(mocks.toast.dismiss).not.toHaveBeenCalled();
  });

  it("collapses a clean fan-out summary with a single run's outcome", () => {
    toastRunOutcome("deploy", CANCELLED, 3, "workflow-run-w1-t1");
    toastFanoutSummary(
      "deploy",
      [
        { title: "a", result: OK },
        { title: "b", result: OK },
      ],
      2,
      0,
      "workflow-run-w1-fanout"
    );
    expect(mocks.toast.dismiss.mock.calls).toEqual([["workflow-run-w1-t1"]]);
  });

  it("keeps a failed fan-out summary", () => {
    toastFanoutSummary("deploy", [{ title: "a", result: FAILED }], 1, 0, "workflow-run-w1-fanout");
    toastRunOutcome("cleanup", CANCELLED, 3, "workflow-run-w2-t1");
    expect(mocks.toast.dismiss).not.toHaveBeenCalled();
  });
});
