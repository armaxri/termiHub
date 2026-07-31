/**
 * Workflow-run render + mutation cut (#2243, part of #2206 / #2152 / #2139) —
 * cut-vs-local parity.
 *
 * The cut routes the run transitions (`runStarted` / `stepAdvanced` /
 * `outputOpened` / `runCompleted` / `runCancelled` / `runFailed` / `dismissOutput`)
 * through the `workflow.*` intents so the backend `WorkflowRunStore` becomes
 * authoritative, while the local `appStore` reducers stay in place as the render
 * source and the resilience / rollback fallback (removal is a later step).
 *
 * These tests prove the cut is parity-safe: with the intents flag **on**, the
 * intents dispatched by `runWorkflow` — applied by a faithful in-memory port of the
 * Rust store (mirroring `workflow_projection/store.rs`) — reconstruct the
 * `workflow-run@<clientId>` region whose `run` + `output` status seam match the
 * local `appStore` slice at every settle. With both flags **off**, no intents are
 * dispatched — the instant rollback path the flip relies on. The streamed
 * `lines` / `exitCode` / `timedOut` stay frontend and are never sent.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { LeafPanel, TerminalTab } from "@/types/terminal";
import type { Workflow, WorkflowStep } from "@/types/workflow";

vi.mock("@/services/storage", () => ({
  loadConnections: vi.fn(() =>
    Promise.resolve({ connections: [], folders: [], agents: [], externalErrors: [] })
  ),
  persistConnection: vi.fn(() => Promise.resolve()),
  removeConnection: vi.fn(() => Promise.resolve()),
  persistFolder: vi.fn(() => Promise.resolve()),
  removeFolder: vi.fn(() => Promise.resolve()),
  getSettings: vi.fn(() =>
    Promise.resolve({
      version: "1",
      externalConnectionFiles: [],
      powerMonitoringEnabled: true,
      fileBrowserEnabled: true,
    })
  ),
  saveSettings: vi.fn(() => Promise.resolve()),
  moveConnectionToFile: vi.fn(() => Promise.resolve()),
  reloadExternalConnections: vi.fn(() => Promise.resolve([])),
  getRecoveryWarnings: vi.fn(() => Promise.resolve([])),
}));

vi.mock("@/themes", () => ({
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(() => vi.fn()),
}));

vi.mock("@/services/workflowApi", () => ({
  listWorkflows: vi.fn(() => Promise.resolve([])),
  getWorkflow: vi.fn(),
  saveWorkflow: vi.fn((w: Workflow) => Promise.resolve(w)),
  deleteWorkflow: vi.fn(() => Promise.resolve()),
}));

const invokeRunLocalProcess = vi.fn((_args: { program: string; args: string[] }) =>
  Promise.resolve({ exitCode: 0 as number | null, timedOut: false, cancelled: false })
);
const cancelLocalProcess = vi.fn((_runId: string) => Promise.resolve(true));
const subscribeLocalProcessOutput = vi.fn((_runId: string, _onChunk: unknown) =>
  Promise.resolve(() => undefined)
);
vi.mock("@/services/localProcessApi", () => ({
  invokeRunLocalProcess: (args: { program: string; args: string[] }) => invokeRunLocalProcess(args),
  cancelLocalProcess: (runId: string) => cancelLocalProcess(runId),
  subscribeLocalProcessOutput: (runId: string, onChunk: unknown) =>
    subscribeLocalProcessOutput(runId, onChunk),
}));

import { useAppStore } from "./appStore";
import {
  setWorkflowIntentsEnabled,
  setWorkflowRenderFromProjectionEnabled,
  setWorkflowTransportForTest,
} from "./workflowRunBridge";
import { registerTerminalInputInjector } from "@/services/macroPlayback";
import { toast } from "@/components/ui";
import type {
  FrameHandler,
  Intent,
  IntentAck,
  ProjectionFrame,
  SnapshotFrame,
  Subscription,
  Transport,
} from "@/services/transport";

// ── In-memory twin of the Rust WorkflowRunStore (client-scoped) ────────────────

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
interface ClientState {
  run: Run | null;
  output: Output | null;
}
interface RegionView {
  run: Run | null;
  output: Output | null;
}

/** A transport double that applies `workflow.*` intents with the same semantics as
 * the Rust `WorkflowRunStore`, keyed by `clientId`, fanning the client's region
 * snapshot to subscribers on every mutation. */
class WorkflowStoreTransport implements Transport {
  dispatched: Intent[] = [];
  private clients = new Map<string, ClientState>();
  private version = 0;
  private handlers = new Map<string, FrameHandler[]>();

  async dispatch(intent: Intent): Promise<IntentAck> {
    this.dispatched.push(intent);
    this.apply(intent);
    this.version += 1;
    this.fan(intent.clientId);
    return {
      intentId: intent.intentId,
      status: "accepted",
      produced: [{ region: this.region(intent.clientId), version: this.version }],
    };
  }

  private state(clientId: string): ClientState {
    let s = this.clients.get(clientId);
    if (!s) {
      s = { run: null, output: null };
      this.clients.set(clientId, s);
    }
    return s;
  }

  private apply(intent: Intent): void {
    const p = intent.payload as Record<string, unknown>;
    const s = this.state(intent.clientId);
    switch (intent.kind) {
      case "workflow.runStarted": {
        s.run = {
          workflowId: p.workflowId as string,
          workflowName: p.workflowName as string,
          tabId: p.tabId as string,
          total: p.total as number,
          completed: 0,
        };
        s.output = null;
        break;
      }
      case "workflow.stepAdvanced": {
        if (
          s.run &&
          s.run.workflowId === (p.workflowId as string) &&
          s.run.tabId === (p.tabId as string)
        ) {
          s.run.completed = p.completed as number;
        }
        break;
      }
      case "workflow.outputOpened": {
        s.output = {
          workflowId: p.workflowId as string,
          workflowName: p.workflowName as string,
          program: p.program as string,
          args: ((p.args as string[] | undefined) ?? []).slice(),
          status: "running",
          error: null,
        };
        break;
      }
      case "workflow.runCompleted":
        this.finishRun(s, "completed", null);
        break;
      case "workflow.runCancelled":
        this.finishRun(s, "cancelled", null);
        break;
      case "workflow.runFailed":
        this.finishRun(s, "failed", (p.error as string | undefined) ?? null);
        break;
      case "workflow.dismissOutput":
        s.output = null;
        break;
      default:
        break;
    }
  }

  private finishRun(
    s: ClientState,
    outcome: "completed" | "cancelled" | "failed",
    error: string | null
  ): void {
    if (s.run === null) return; // no active run → leave the panel as-is
    s.run = null;
    if (s.output) {
      s.output.status = outcome;
      s.output.error = outcome === "failed" ? error : null;
    }
  }

  regionView(clientId: string): RegionView {
    const s = this.state(clientId);
    return structuredClone({ run: s.run, output: s.output });
  }

  /** The single client's region view (there is one per-session client id). */
  onlyRegionView(): RegionView {
    const [clientId] = [...this.clients.keys()];
    return this.regionView(clientId ?? "");
  }

  kinds(): string[] {
    return this.dispatched.map((i) => i.kind);
  }

  private region(clientId: string): string {
    return `workflow-run@${clientId}`;
  }

  async subscribe(region: string, onFrame: FrameHandler): Promise<Subscription> {
    const list = this.handlers.get(region) ?? [];
    list.push(onFrame);
    this.handlers.set(region, list);
    const clientId = region.slice("workflow-run@".length);
    return {
      snapshot: this.snapshot(region, clientId),
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

  private snapshot(region: string, clientId: string): SnapshotFrame {
    return { kind: "snapshot", region, version: this.version, view: this.regionView(clientId) };
  }

  private fan(clientId: string): void {
    const region = this.region(clientId);
    const frame: ProjectionFrame = this.snapshot(region, clientId);
    for (const h of this.handlers.get(region) ?? []) h(frame);
  }
}

let transport: WorkflowStoreTransport;

const workflow = (id: string, steps: WorkflowStep[]): Workflow => ({
  id,
  name: `Workflow ${id}`,
  description: "",
  tags: [],
  steps,
  triggers: [{ kind: "manual" }],
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
});

const cmd = (command: string): WorkflowStep => ({ kind: "send-command", command });
const lp = (program: string, args: string[]): WorkflowStep => ({
  kind: "run-local-process",
  program,
  args,
});

/** Seed an active, connected terminal tab so a run has a valid target. */
function seedConnectedTerminal(tabId = "tab-active", sessionId: string | null = "sess-1") {
  const tab: TerminalTab = {
    id: tabId,
    sessionId,
    title: "term",
    connectionType: "local",
    contentType: "terminal",
    config: { type: "local", config: {} },
    panelId: "leaf-1",
    isActive: true,
  };
  const leaf: LeafPanel = { type: "leaf", id: "leaf-1", tabs: [tab], activeTabId: tabId };
  useAppStore.setState({ rootPanel: leaf, activePanelId: "leaf-1", terminalExitedTabs: {} });
}

/** The `workflow-run` region view that appStore's slice currently projects to —
 * the local baseline the cut must reproduce. Streamed content is excluded. */
function appStoreView(): RegionView {
  const s = useAppStore.getState();
  return {
    run: s.workflowRun
      ? {
          workflowId: s.workflowRun.workflowId,
          workflowName: s.workflowRun.workflowName,
          tabId: s.workflowRun.tabId,
          total: s.workflowRun.total,
          completed: s.workflowRun.completed,
        }
      : null,
    output: s.workflowRunOutput
      ? {
          workflowId: s.workflowRunOutput.workflowId,
          workflowName: s.workflowRunOutput.workflowName,
          program: s.workflowRunOutput.program,
          args: s.workflowRunOutput.args,
          status: s.workflowRunOutput.status,
          error: s.workflowRunOutput.error ?? null,
        }
      : null,
  };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState());
  vi.clearAllMocks();
  transport = new WorkflowStoreTransport();
  setWorkflowTransportForTest(transport);
  setWorkflowIntentsEnabled(true);
  setWorkflowRenderFromProjectionEnabled(true);
  registerTerminalInputInjector(async () => true);
  vi.spyOn(toast, "error");
  vi.spyOn(toast, "info");
  vi.spyOn(toast, "success");
  vi.spyOn(toast, "loading");
});

afterEach(() => {
  registerTerminalInputInjector(null);
  setWorkflowTransportForTest(null);
  setWorkflowIntentsEnabled(null);
  setWorkflowRenderFromProjectionEnabled(null);
  vi.restoreAllMocks();
});

describe("workflow-run cut — mutation parity (intents on)", () => {
  it("a send-command run reconstructs the region matching appStore at settle", async () => {
    seedConnectedTerminal();
    useAppStore.setState({
      workflows: [workflow("w1", [cmd("a"), cmd("b"), cmd("c")])],
    });

    await useAppStore.getState().runWorkflow("w1");
    await flush();

    // appStore cleared the run; the store settled the run to null too.
    expect(appStoreView()).toEqual({ run: null, output: null });
    expect(transport.onlyRegionView()).toEqual(appStoreView());
    // The full transition sequence was mirrored (start → 3 steps → completed).
    expect(transport.kinds()).toEqual([
      "workflow.runStarted",
      "workflow.stepAdvanced",
      "workflow.stepAdvanced",
      "workflow.stepAdvanced",
      "workflow.runCompleted",
    ]);
  });

  it("mid-run, the projected run progress mirrors appStore step by step", async () => {
    // Gate the injector so the run is genuinely in flight between steps.
    let markStarted!: () => void;
    const started = new Promise<void>((r) => (markStarted = r));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let call = 0;
    registerTerminalInputInjector(async () => {
      call += 1;
      if (call === 1) {
        markStarted();
        await gate;
      }
      return true;
    });
    seedConnectedTerminal();
    useAppStore.setState({ workflows: [workflow("w1", [cmd("a"), cmd("b")])] });

    const done = useAppStore.getState().runWorkflow("w1");
    await started;
    await flush();

    // The run is active; the region mirrors appStore's in-flight progress.
    expect(appStoreView().run).not.toBeNull();
    expect(transport.onlyRegionView()).toEqual(appStoreView());

    release();
    await done;
    await flush();
    expect(transport.onlyRegionView()).toEqual(appStoreView());
  });

  it("a run-local-process run mirrors the output-panel status seam (not the stream)", async () => {
    seedConnectedTerminal();
    useAppStore.setState({
      workflows: [workflow("w1", [lp("echo", ["hi"])])],
      settings: {
        ...useAppStore.getState().settings,
        workflowLocalProcessEnabled: true,
        workflowLocalProcessAllowlist: ["echo"],
      },
    });

    await useAppStore.getState().runWorkflow("w1");
    await flush();

    // The panel persists after the run with its terminal status; the region's
    // output status seam matches appStore's (identity + status), and the run is
    // cleared. The streamed lines/exitCode/timedOut are never sent.
    const view = transport.onlyRegionView();
    expect(view.run).toBeNull();
    expect(view.output).not.toBeNull();
    expect(view.output?.status).toBe("completed");
    expect(view).toEqual(appStoreView());
    expect(transport.kinds()).toContain("workflow.outputOpened");
    expect(transport.kinds()).toContain("workflow.runCompleted");
  });

  it("a failed run stamps the panel error onto the projected output", async () => {
    seedConnectedTerminal();
    // A local process that reports a non-zero exit fails the step → run fails.
    invokeRunLocalProcess.mockResolvedValueOnce({ exitCode: 1, timedOut: false, cancelled: false });
    useAppStore.setState({
      workflows: [workflow("w1", [lp("boom", [])])],
      settings: {
        ...useAppStore.getState().settings,
        workflowLocalProcessEnabled: true,
        workflowLocalProcessAllowlist: ["boom"],
      },
    });

    await useAppStore.getState().runWorkflow("w1");
    await flush();

    const view = transport.onlyRegionView();
    expect(view.output?.status).toBe("failed");
    // Whatever error appStore stamped, the region carries the same one.
    expect(view).toEqual(appStoreView());
    expect(transport.kinds()).toContain("workflow.runFailed");
  });

  it("dismissing the output panel mirrors dismissOutput and clears the region", async () => {
    seedConnectedTerminal();
    useAppStore.setState({
      workflows: [workflow("w1", [lp("echo", ["hi"])])],
      settings: {
        ...useAppStore.getState().settings,
        workflowLocalProcessEnabled: true,
        workflowLocalProcessAllowlist: ["echo"],
      },
    });
    await useAppStore.getState().runWorkflow("w1");
    await flush();
    expect(transport.onlyRegionView().output).not.toBeNull();

    useAppStore.getState().dismissWorkflowRunOutput();
    await flush();

    expect(useAppStore.getState().workflowRunOutput).toBeNull();
    expect(transport.onlyRegionView().output).toBeNull();
    expect(transport.kinds()).toContain("workflow.dismissOutput");
  });
});

describe("workflow-run cut — rollback (both flags off)", () => {
  it("dispatches no intents when render + intents are off; appStore still drives", async () => {
    setWorkflowIntentsEnabled(false);
    setWorkflowRenderFromProjectionEnabled(false);
    seedConnectedTerminal();
    useAppStore.setState({ workflows: [workflow("w1", [cmd("a"), cmd("b")])] });

    await useAppStore.getState().runWorkflow("w1");
    await flush();

    expect(transport.dispatched).toEqual([]);
    // The local reducer path still ran to completion.
    expect(useAppStore.getState().workflowRun).toBeNull();
    expect(toast.success).toHaveBeenCalled();
  });

  it("render on but intents off still populates the region (render independence)", async () => {
    setWorkflowIntentsEnabled(false);
    setWorkflowRenderFromProjectionEnabled(true);
    seedConnectedTerminal();
    useAppStore.setState({ workflows: [workflow("w1", [cmd("a")])] });

    await useAppStore.getState().runWorkflow("w1");
    await flush();

    // The mirror intents are dispatched to keep the render region populated even
    // with the mutation flag off, and the region matches appStore.
    expect(transport.kinds().length).toBeGreaterThan(0);
    expect(transport.onlyRegionView()).toEqual(appStoreView());
  });
});
