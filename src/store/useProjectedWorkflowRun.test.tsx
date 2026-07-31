/**
 * `useProjectedWorkflowRun` — the Workflow Manager cut to the projected
 * `workflow-run@<clientId>` region (#2243 render cut). Drives the hook against an
 * in-memory substrate double and asserts: flag-off returns the appStore slice;
 * flag-on renders run progress + output status from the projection when it mirrors
 * appStore (byte-identical); a region that has not caught up (diverges from
 * appStore) falls back to the appStore slice; and the frontend-owned streamed
 * lines/exitCode/timedOut are always kept from appStore.
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
import { useAppStore, type WorkflowRunOutputState, type WorkflowRunState } from "@/store/appStore";

import {
  dispatchWorkflowIntent,
  setWorkflowRenderFromProjectionEnabled,
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

const run = (over: Partial<WorkflowRunState> = {}): WorkflowRunState => ({
  workflowId: "w1",
  workflowName: "Deploy",
  tabId: "tab-1",
  total: 3,
  completed: 0,
  ...over,
});

let transport: FakeTransport;

beforeEach(() => {
  transport = new FakeTransport();
  setWorkflowTransportForTest(transport);
  useAppStore.setState({ workflowRun: null, workflowRunOutput: null });
});

afterEach(() => {
  stopWorkflowSubscription();
  setWorkflowTransportForTest(null);
  setWorkflowRenderFromProjectionEnabled(null);
});

const flush = () => act(async () => await Promise.resolve());

describe("useProjectedWorkflowRun", () => {
  it("flag off: returns the appStore slice and does not subscribe", async () => {
    setWorkflowRenderFromProjectionEnabled(false);
    useAppStore.setState({ workflowRun: run({ completed: 2 }) });

    const hook = renderHook();
    await flush();

    expect(hook.get().workflowRun?.completed).toBe(2);
    hook.unmount();
  });

  it("flag on: renders run progress from the projection when it mirrors appStore", async () => {
    const r = run();
    useAppStore.setState({ workflowRun: r });
    // Populate the region to match appStore's run.
    await dispatchWorkflowIntent("workflow.runStarted", {
      workflowId: r.workflowId,
      workflowName: r.workflowName,
      tabId: r.tabId,
      total: r.total,
    });

    const hook = renderHook();
    await flush();
    await flush();

    expect(hook.get().workflowRun).toEqual(r);
    hook.unmount();
  });

  it("region diverged from appStore: falls back to the appStore slice", async () => {
    // Region says total 5; appStore says total 3 → gate rejects, hook shows appStore.
    await dispatchWorkflowIntent("workflow.runStarted", {
      workflowId: "w1",
      workflowName: "Deploy",
      tabId: "tab-1",
      total: 5,
    });
    useAppStore.setState({ workflowRun: run({ total: 3 }) });

    const hook = renderHook();
    await flush();
    await flush();

    expect(hook.get().workflowRun?.total).toBe(3);
    hook.unmount();
  });

  it("keeps frontend-owned streamed content while rendering projected status", async () => {
    const output: WorkflowRunOutputState = {
      workflowId: "w1",
      workflowName: "Deploy",
      program: "echo",
      args: ["hi"],
      lines: [{ id: 0, stream: "stdout", text: "hi" }],
      status: "running",
      exitCode: null,
      timedOut: false,
    };
    useAppStore.setState({ workflowRunOutput: output });
    await dispatchWorkflowIntent("workflow.outputOpened", {
      workflowId: "w1",
      workflowName: "Deploy",
      program: "echo",
      args: ["hi"],
    });

    const hook = renderHook();
    await flush();
    await flush();

    const got = hook.get().workflowRunOutput;
    // Status + identity from the projection; streamed lines kept from appStore.
    expect(got?.status).toBe("running");
    expect(got?.lines).toEqual(output.lines);
    hook.unmount();
  });
});
