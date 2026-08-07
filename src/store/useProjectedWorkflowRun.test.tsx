/**
 * `useProjectedWorkflowRun` — the Workflow Manager reading the authoritative
 * `workflow-run@<clientId>` region (#2206 reducer-removal). Drives the hook
 * against an in-memory substrate double and asserts: an empty region renders
 * nothing; a dispatched `workflow.runStarted` surfaces the run progress; the
 * output panel merges the projected identity/status with the bridge's
 * frontend-owned streamed content; and there is no appStore involvement.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  FrameHandler,
  Intent,
  IntentAck,
  ProjectionFrame,
  SnapshotFrame,
  Subscription,
  Transport,
} from "@/services/transport";

import {
  dispatchWorkflowIntent,
  setWorkflowOutputContentForTest,
  setWorkflowTransportForTest,
  stopWorkflowSubscription,
} from "./workflowRunBridge";
import { useProjectedWorkflowRun, type ProjectedWorkflowRunSlice } from "./useProjectedWorkflowRun";

vi.mock("@/services/storage", () => ({
  loadConnections: vi.fn(() =>
    Promise.resolve({ connections: [], folders: [], agents: [], externalErrors: [] })
  ),
  getSettings: vi.fn(() =>
    Promise.resolve({ version: "1", externalConnectionFiles: [], powerMonitoringEnabled: true })
  ),
  saveSettings: vi.fn(() => Promise.resolve()),
  getRecoveryWarnings: vi.fn(() => Promise.resolve([])),
}));
vi.mock("@/themes", () => ({ applyTheme: vi.fn(), onThemeChange: vi.fn(() => vi.fn()) }));

interface Run {
  workflowId: string;
  workflowName: string;
  tabId: string;
  total: number;
  completed: number;
}
interface Output {
  workflowId: string;
  workflowName: string;
  program: string;
  args: string[];
  status: "running" | "completed" | "cancelled" | "failed";
  error: string | null;
}
interface View {
  run: Run | null;
  output: Output | null;
}

/** In-memory substrate double applying the `workflow.*` intents this test uses. */
class FakeTransport implements Transport {
  dispatched: Intent[] = [];
  private view: View = { run: null, output: null };
  private version = 0;
  private handlers = new Map<string, FrameHandler[]>();

  async dispatch(intent: Intent): Promise<IntentAck> {
    this.dispatched.push(intent);
    const p = intent.payload as Record<string, unknown>;
    if (intent.kind === "workflow.runStarted") {
      this.view = {
        run: {
          workflowId: p.workflowId as string,
          workflowName: p.workflowName as string,
          tabId: p.tabId as string,
          total: p.total as number,
          completed: 0,
        },
        output: null,
      };
    } else if (intent.kind === "workflow.outputOpened") {
      this.view = {
        ...this.view,
        output: {
          workflowId: p.workflowId as string,
          workflowName: p.workflowName as string,
          program: p.program as string,
          args: ((p.args as string[] | undefined) ?? []).slice(),
          status: "running",
          error: null,
        },
      };
    }
    this.version += 1;
    this.fan(`workflow-run@${intent.clientId}`);
    return {
      intentId: intent.intentId,
      status: "accepted",
      produced: [{ region: `workflow-run@${intent.clientId}`, version: this.version }],
    };
  }

  async subscribe(region: string, onFrame: FrameHandler): Promise<Subscription> {
    const list = this.handlers.get(region) ?? [];
    list.push(onFrame);
    this.handlers.set(region, list);
    return {
      snapshot: this.snapshot(region),
      unsubscribe: () => {
        this.handlers.set(
          region,
          (this.handlers.get(region) ?? []).filter((h) => h !== onFrame)
        );
      },
    };
  }

  async resync(): Promise<SnapshotFrame | null> {
    return null;
  }

  private snapshot(region: string): SnapshotFrame {
    return { kind: "snapshot", region, version: this.version, view: structuredClone(this.view) };
  }

  private fan(region: string): void {
    const frame: ProjectionFrame = this.snapshot(region);
    for (const h of this.handlers.get(region) ?? []) h(frame);
  }
}

function renderHook(): { get: () => ProjectedWorkflowRunSlice; unmount: () => void } {
  const container = document.createElement("div");
  const root: Root = createRoot(container);
  let latest: ProjectedWorkflowRunSlice = { workflowRun: null, workflowRunOutput: null };
  function Probe() {
    latest = useProjectedWorkflowRun();
    return null;
  }
  act(() => root.render(<Probe />));
  return { get: () => latest, unmount: () => act(() => root.unmount()) };
}

let transport: FakeTransport;

beforeEach(() => {
  transport = new FakeTransport();
  setWorkflowTransportForTest(transport);
});

afterEach(() => {
  stopWorkflowSubscription();
  setWorkflowTransportForTest(null);
});

const flush = () => act(async () => await Promise.resolve());

describe("useProjectedWorkflowRun", () => {
  it("renders nothing when the region is empty", async () => {
    const hook = renderHook();
    await flush();
    expect(hook.get()).toEqual({ workflowRun: null, workflowRunOutput: null });
    hook.unmount();
  });

  it("renders run progress from the projected region after runStarted", async () => {
    const hook = renderHook();
    await flush();
    await dispatchWorkflowIntent("workflow.runStarted", {
      workflowId: "w1",
      workflowName: "Deploy",
      tabId: "tab-1",
      total: 3,
    });
    await flush();

    expect(hook.get().workflowRun).toEqual({
      workflowId: "w1",
      workflowName: "Deploy",
      tabId: "tab-1",
      total: 3,
      completed: 0,
    });
    hook.unmount();
  });

  it("merges the projected output status with the frontend-owned streamed content", async () => {
    const hook = renderHook();
    await flush();
    await dispatchWorkflowIntent("workflow.outputOpened", {
      workflowId: "w1",
      workflowName: "Deploy",
      program: "echo",
      args: ["hi"],
    });
    await flush();
    act(() => {
      setWorkflowOutputContentForTest({
        workflowId: "w1",
        lines: [{ id: 0, stream: "stdout", text: "hi" }],
        exitCode: 0,
        timedOut: false,
      });
    });
    await flush();

    const got = hook.get().workflowRunOutput;
    // Identity + status from the projection; streamed content from the bridge.
    expect(got?.status).toBe("running");
    expect(got?.program).toBe("echo");
    expect(got?.lines).toEqual([{ id: 0, stream: "stdout", text: "hi" }]);
    expect(got?.exitCode).toBe(0);
    hook.unmount();
  });

  it("shows an empty stream until the content buffer opens (panel gated on projection)", async () => {
    const hook = renderHook();
    await flush();
    await dispatchWorkflowIntent("workflow.outputOpened", {
      workflowId: "w1",
      workflowName: "Deploy",
      program: "echo",
      args: ["hi"],
    });
    await flush();

    // The projected panel is present; streamed content has not arrived yet.
    const got = hook.get().workflowRunOutput;
    expect(got).not.toBeNull();
    expect(got?.lines).toEqual([]);
    expect(got?.exitCode).toBeNull();
    hook.unmount();
  });

  it("ignores streamed content whose workflow id does not match the projected panel", async () => {
    const hook = renderHook();
    await flush();
    await dispatchWorkflowIntent("workflow.outputOpened", {
      workflowId: "w1",
      workflowName: "Deploy",
      program: "echo",
      args: ["hi"],
    });
    await flush();
    act(() => {
      setWorkflowOutputContentForTest({
        workflowId: "other",
        lines: [{ id: 0, stream: "stdout", text: "stale" }],
        exitCode: 9,
        timedOut: true,
      });
    });
    await flush();

    const got = hook.get().workflowRunOutput;
    expect(got?.lines).toEqual([]);
    expect(got?.exitCode).toBeNull();
    expect(got?.timedOut).toBe(false);
    hook.unmount();
  });
});
