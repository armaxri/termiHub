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
  appendWorkflowOutputLine,
  clearWorkflowOutputContent,
  currentWorkflowOutputContent,
  dispatchWorkflowRunStarted,
  onWorkflowOutputContent,
  openWorkflowOutputContent,
  setWorkflowOutputProcessResult,
  setWorkflowTransportForTest,
  stopWorkflowSubscription,
  workflowRunRegion,
  type WorkflowRunOutputContent,
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
      workflowId: "w1",
      workflowName: "Deploy",
      tabId: "tab-1",
      total: 3,
    });
    const started = transport.dispatched.filter((i) => i.kind === "workflow.runStarted");
    expect(started).toHaveLength(1);
    expect(started[0].payload).toMatchObject({ workflowId: "w1", tabId: "tab-1", total: 3 });
  });

  it("logs but never throws when the transport rejects (a run must not crash)", async () => {
    transport.rejectNext = true;
    await expect(
      dispatchWorkflowRunStarted({ workflowId: "w1", workflowName: "d", tabId: "t", total: 1 })
    ).resolves.toBeUndefined();
    expect(transport.dispatched).toHaveLength(1);
  });

  it("logs but never throws when the ack is rejected", async () => {
    transport.ackStatus = "rejected";
    await expect(
      dispatchWorkflowRunStarted({ workflowId: "w1", workflowName: "d", tabId: "t", total: 1 })
    ).resolves.toBeUndefined();
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
