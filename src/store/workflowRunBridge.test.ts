/**
 * Unit tests for the workflow-run bridge flags, region id, and faithful-mirror
 * gate (#2243).
 *
 * Behavioural coverage (mirror dispatch, projected rendering, and the local
 * fallback) lives in `appStore.workflowRunCut.test.ts`, which drives the bridge
 * through the real `appStore.runWorkflow` action against an in-memory twin of the
 * Rust store.
 */

import { describe, it, expect, afterEach } from "vitest";

import {
  setWorkflowIntentsEnabled,
  setWorkflowRenderFromProjectionEnabled,
  workflowIntentsEnabled,
  workflowRenderFromProjectionEnabled,
  workflowRunMirrors,
  workflowRunRegion,
  type WorkflowRunOutputStatusSeam,
  type WorkflowRunView,
} from "./workflowRunBridge";
import type { WorkflowRunState } from "./appStore";

interface WorkflowFlagWindow {
  __TERMIHUB_WORKFLOW_INTENTS__?: boolean;
  __TERMIHUB_WORKFLOW_RENDER__?: boolean;
}

afterEach(() => {
  setWorkflowIntentsEnabled(null);
  setWorkflowRenderFromProjectionEnabled(null);
  const w = window as unknown as WorkflowFlagWindow;
  delete w.__TERMIHUB_WORKFLOW_INTENTS__;
  delete w.__TERMIHUB_WORKFLOW_RENDER__;
});

describe("workflowRunBridge flags", () => {
  it("both flags default on", () => {
    expect(workflowIntentsEnabled()).toBe(true);
    expect(workflowRenderFromProjectionEnabled()).toBe(true);
  });

  it("programmatic overrides win, and null restores the default", () => {
    setWorkflowIntentsEnabled(false);
    setWorkflowRenderFromProjectionEnabled(false);
    expect(workflowIntentsEnabled()).toBe(false);
    expect(workflowRenderFromProjectionEnabled()).toBe(false);

    setWorkflowIntentsEnabled(null);
    setWorkflowRenderFromProjectionEnabled(null);
    expect(workflowIntentsEnabled()).toBe(true);
    expect(workflowRenderFromProjectionEnabled()).toBe(true);
  });

  it("a window override flips a flag off (rollback switch)", () => {
    const w = window as unknown as WorkflowFlagWindow;
    w.__TERMIHUB_WORKFLOW_INTENTS__ = false;
    w.__TERMIHUB_WORKFLOW_RENDER__ = false;
    expect(workflowIntentsEnabled()).toBe(false);
    expect(workflowRenderFromProjectionEnabled()).toBe(false);
  });
});

describe("workflowRunRegion", () => {
  it("is client-scoped, matching the Rust region id", () => {
    expect(workflowRunRegion("abc123")).toBe("workflow-run@abc123");
  });
});

describe("workflowRunMirrors", () => {
  const run: WorkflowRunState = {
    workflowId: "w1",
    workflowName: "Deploy",
    tabId: "tab-1",
    total: 3,
    completed: 1,
  };
  const output: WorkflowRunOutputStatusSeam = {
    workflowId: "w1",
    workflowName: "Deploy",
    program: "echo",
    args: ["hi", "there"],
    status: "running",
  };

  it("is false when no view has arrived", () => {
    expect(workflowRunMirrors(undefined, run, output)).toBe(false);
  });

  it("mirrors an exact run + output match", () => {
    const view: WorkflowRunView = {
      run: { ...run },
      output: { ...output, args: ["hi", "there"], error: null },
    };
    expect(workflowRunMirrors(view, run, output)).toBe(true);
  });

  it("mirrors when both halves are absent", () => {
    expect(workflowRunMirrors({ run: null, output: null }, null, null)).toBe(true);
  });

  it("does not mirror when progress diverges (region lagging)", () => {
    const view: WorkflowRunView = { run: { ...run, completed: 0 }, output: null };
    expect(workflowRunMirrors(view, run, null)).toBe(false);
  });

  it("does not mirror when the output status diverges", () => {
    const view: WorkflowRunView = {
      run: { ...run },
      output: { ...output, status: "completed" },
    };
    expect(workflowRunMirrors(view, run, output)).toBe(false);
  });

  it("does not mirror when args diverge in order", () => {
    const view: WorkflowRunView = {
      run: { ...run },
      output: { ...output, args: ["there", "hi"] },
    };
    expect(workflowRunMirrors(view, run, output)).toBe(false);
  });

  it("treats projected null error and local undefined error as equal", () => {
    const failed: WorkflowRunOutputStatusSeam = { ...output, status: "failed" };
    const view: WorkflowRunView = {
      run: null,
      output: { ...output, status: "failed", error: null },
    };
    // local error undefined, projected error null → still a mirror.
    expect(workflowRunMirrors(view, null, failed)).toBe(true);
    // and a real error string must match.
    const withError: WorkflowRunView = {
      run: null,
      output: { ...output, status: "failed", error: "boom" },
    };
    expect(workflowRunMirrors(withError, null, { ...failed, error: "boom" })).toBe(true);
    expect(workflowRunMirrors(withError, null, failed)).toBe(false);
  });

  it("does not compare frontend-owned streamed content (lines/exitCode/timedOut)", () => {
    // The seam carries only identity + status + error; a view that matches those
    // mirrors regardless of what streamed content appStore holds alongside it.
    const view: WorkflowRunView = { run: null, output: { ...output } };
    expect(workflowRunMirrors(view, null, output)).toBe(true);
  });
});
