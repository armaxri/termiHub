/**
 * Unit tests for the workflow-run bridge (#2206 reducer-removal): the region id,
 * the reliable `workflow.*` intent dispatch (the sole authoritative write path),
 * and the frontend-owned streamed-content store.
 *
 * End-to-end behaviour (dispatch driving the region, the render hook merging the
 * projected status with the streamed content) lives in
 * `appStore.workflowRun.test.ts` and `useProjectedWorkflowRun.test.tsx`.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";

import type {
  FrameHandler,
  Intent,
  IntentAck,
  SnapshotFrame,
  Subscription,
  Transport,
} from "@/services/transport";
import {
  __emitWorkflowRunViewForTest,
  appendWorkflowOutputLine,
  clearWorkflowOutputContent,
  currentWorkflowOutputContent,
  currentWorkflowRunView,
  dispatchWorkflowRunSettled,
  dispatchWorkflowRunStarted,
  dispatchWorkflowStepAdvanced,
  onWorkflowOutputContent,
  openWorkflowOutputContent,
  setWorkflowOutputProcessResult,
  setWorkflowTransportForTest,
  stopWorkflowSubscription,
  workflowRunRegion,
  type WorkflowRunOutputContent,
  type WorkflowRunViewInput,
} from "./workflowRunBridge";

/** A transport double that records dispatched intents and can be told to reject. */
class RecordingTransport implements Transport {
  dispatched: Intent[] = [];
  rejectNext = false;
  ackStatus: IntentAck["status"] = "accepted";

  async dispatch(intent: Intent): Promise<IntentAck> {
    this.dispatched.push(intent);
    if (this.rejectNext) {
      this.rejectNext = false;
      throw new Error("transport down");
    }
    return {
      intentId: intent.intentId,
      status: this.ackStatus,
      produced: [],
      ...(this.ackStatus === "rejected" ? { error: { code: "rejected", message: "nope" } } : {}),
    };
  }

  async subscribe(region: string, _onFrame: FrameHandler): Promise<Subscription> {
    return {
      snapshot: { kind: "snapshot", region, version: 0, view: { run: null, output: null } },
      unsubscribe: () => undefined,
    };
  }

  async resync(): Promise<SnapshotFrame | null> {
    return null;
  }
}

let transport: RecordingTransport;

beforeEach(() => {
  transport = new RecordingTransport();
  setWorkflowTransportForTest(transport);
});

afterEach(() => {
  stopWorkflowSubscription();
  setWorkflowTransportForTest(null);
  clearWorkflowOutputContent();
});

describe("workflowRunRegion", () => {
  it("is client-scoped, matching the Rust region id", () => {
    expect(workflowRunRegion("abc123")).toBe("workflow-run@abc123");
  });
});

describe("reliable workflow.* dispatch", () => {
  it("submits the intent as the authoritative write", async () => {
    await dispatchWorkflowRunStarted({
      runId: "r1",
      workflowId: "w1",
      workflowName: "Deploy",
      tabId: "tab-1",
      total: 3,
    });
    const started = transport.dispatched.filter((i) => i.kind === "workflow.runStarted");
    expect(started).toHaveLength(1);
    expect(started[0].payload).toMatchObject({
      runId: "r1",
      workflowId: "w1",
      tabId: "tab-1",
      total: 3,
    });
  });

  it("logs but never throws when the transport rejects (a run must not crash)", async () => {
    transport.rejectNext = true;
    await expect(
      dispatchWorkflowRunStarted({
        runId: "r1",
        workflowId: "w1",
        workflowName: "d",
        tabId: "t",
        total: 1,
      })
    ).resolves.toBeUndefined();
    expect(transport.dispatched).toHaveLength(1);
  });

  it("logs but never throws when the ack is rejected", async () => {
    transport.ackStatus = "rejected";
    await expect(
      dispatchWorkflowRunStarted({
        runId: "r1",
        workflowId: "w1",
        workflowName: "d",
        tabId: "t",
        total: 1,
      })
    ).resolves.toBeUndefined();
  });
});

describe("version guard (FES-006)", () => {
  it("applies the first snapshot, then a newer one, and drops a stale older one", () => {
    const run = (completed: number): WorkflowRunViewInput => ({
      run: {
        runId: "r1",
        workflowId: "w1",
        workflowName: "Deploy",
        tabId: "t",
        total: 3,
        completed,
      },
      output: null,
    });

    __emitWorkflowRunViewForTest(run(1), 1);
    expect(currentWorkflowRunView().run?.completed).toBe(1);

    __emitWorkflowRunViewForTest(run(2), 2);
    expect(currentWorkflowRunView().run?.completed).toBe(2);

    // A strictly older version is dropped — the newer view stays.
    __emitWorkflowRunViewForTest(run(99), 1);
    expect(currentWorkflowRunView().run?.completed).toBe(2);
  });
});

describe("frontend-owned streamed content store", () => {
  it("opens a fresh buffer keyed to the workflow, appends lines, and fans out", () => {
    const seen: (WorkflowRunOutputContent | null)[] = [];
    const off = onWorkflowOutputContent((c) => seen.push(c));

    openWorkflowOutputContent("w1");
    appendWorkflowOutputLine({ id: 0, stream: "stdout", text: "hi" });
    appendWorkflowOutputLine({ id: 1, stream: "stderr", text: "warn" });

    const content = currentWorkflowOutputContent();
    expect(content?.workflowId).toBe("w1");
    expect(content?.lines).toEqual([
      { id: 0, stream: "stdout", text: "hi" },
      { id: 1, stream: "stderr", text: "warn" },
    ]);
    // A listener was notified on open + each append.
    expect(seen).toHaveLength(3);
    off();
  });

  it("records the process exit outcome without touching the lines", () => {
    openWorkflowOutputContent("w1");
    appendWorkflowOutputLine({ id: 0, stream: "stdout", text: "done" });
    setWorkflowOutputProcessResult(2, true);
    const content = currentWorkflowOutputContent();
    expect(content?.exitCode).toBe(2);
    expect(content?.timedOut).toBe(true);
    expect(content?.lines).toHaveLength(1);
  });

  it("caps retained lines at the bound so a chatty process stays bounded", () => {
    openWorkflowOutputContent("w1");
    for (let i = 0; i < 1200; i++) {
      appendWorkflowOutputLine({ id: i, stream: "stdout", text: `line ${i}` });
    }
    const content = currentWorkflowOutputContent();
    expect(content?.lines).toHaveLength(1000);
    // The oldest were dropped; the newest are retained.
    expect(content?.lines[0].id).toBe(200);
    expect(content?.lines[999].id).toBe(1199);
  });

  it("append/setResult are no-ops when no buffer is open", () => {
    clearWorkflowOutputContent();
    appendWorkflowOutputLine({ id: 0, stream: "stdout", text: "orphan" });
    setWorkflowOutputProcessResult(0, false);
    expect(currentWorkflowOutputContent()).toBeNull();
  });

  it("clear resets the buffer and fans out once", () => {
    openWorkflowOutputContent("w1");
    const off = onWorkflowOutputContent(vi.fn());
    clearWorkflowOutputContent();
    expect(currentWorkflowOutputContent()).toBeNull();
    // A second clear is a no-op (already null) — no throw.
    clearWorkflowOutputContent();
    off();
  });
});

describe("keyed concurrent runs (#3418)", () => {
  const run = (runId: string, completed: number) => ({
    runId,
    workflowId: "w1",
    workflowName: "Deploy",
    tabId: `t-${runId}`,
    total: 3,
    completed,
  });

  it("lifts a pre-#3418 view carrying only `run` into a one-entry `runs`", () => {
    __emitWorkflowRunViewForTest({ run: run("r1", 1), output: null }, 1);
    expect(currentWorkflowRunView().runs).toEqual([run("r1", 1)]);
  });

  it("keeps every keyed run and derives `run` from the last when absent", () => {
    __emitWorkflowRunViewForTest(
      { runs: [run("r1", 1), run("r2", 2)], output: null } as unknown as WorkflowRunViewInput,
      1
    );
    expect(currentWorkflowRunView().runs).toHaveLength(2);
    expect(currentWorkflowRunView().run?.runId).toBe("r2");
  });

  it("carries the run id on progress and settle intents", async () => {
    await dispatchWorkflowStepAdvanced({ runId: "r7", workflowId: "w1", tabId: "t", completed: 2 });
    await dispatchWorkflowRunSettled("r7", "failed", "boom");
    await dispatchWorkflowRunSettled("r8", "cancelled");
    const payloads = transport.dispatched.map((i) => [i.kind, i.payload]);
    expect(payloads).toEqual([
      ["workflow.stepAdvanced", { runId: "r7", workflowId: "w1", tabId: "t", completed: 2 }],
      ["workflow.runFailed", { runId: "r7", error: "boom" }],
      ["workflow.runCancelled", { runId: "r8" }],
    ]);
  });

  it("only sends preserveOutput / label when set", async () => {
    await dispatchWorkflowRunStarted({
      runId: "r1",
      workflowId: "w1",
      workflowName: "D",
      tabId: "t",
      total: 1,
      label: "web-1",
      preserveOutput: true,
    });
    expect(transport.dispatched[0].payload).toMatchObject({ label: "web-1", preserveOutput: true });
  });

  it("drops streamed writes tagged with another run's id", () => {
    openWorkflowOutputContent("w1", "r1");
    appendWorkflowOutputLine({ id: 0, stream: "stdout", text: "mine" }, "r1");
    appendWorkflowOutputLine({ id: 1, stream: "stdout", text: "sibling" }, "r2");
    setWorkflowOutputProcessResult(9, false, "r2");
    const content = currentWorkflowOutputContent();
    expect(content?.lines.map((l) => l.text)).toEqual(["mine"]);
    expect(content?.exitCode).toBeNull();
    setWorkflowOutputProcessResult(0, false, "r1");
    expect(currentWorkflowOutputContent()?.exitCode).toBe(0);
  });
});
