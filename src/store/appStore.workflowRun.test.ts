/**
 * Tests for the workflow *run* Zustand slice (#1852) — the epic foundation's
 * end-to-end path.
 *
 * Pins `runWorkflow` / `cancelWorkflowRun`: an authored `send-command` workflow
 * run against a connected terminal streams each command (with a trailing
 * newline) through the registered `send_input` injector in order, live progress
 * is tracked and cleared, a run can be cancelled, and the guards (missing
 * workflow, empty workflow, no connected terminal, exited terminal) surface a
 * recoverable toast instead of injecting. Also covers the CRUD + import actions.
 * The injector, terminal, and backend are mocked so no real session is needed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { LeafPanel, TerminalTab } from "@/types/terminal";
import type { Workflow, WorkflowStep } from "@/types/workflow";
import type { Macro } from "@/types/macro";

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

const savedWorkflows: Workflow[] = [];
vi.mock("@/services/workflowApi", () => ({
  listWorkflows: vi.fn(() => Promise.resolve([...savedWorkflows])),
  getWorkflow: vi.fn(),
  saveWorkflow: vi.fn((w: Workflow) => {
    savedWorkflows.push(w);
    return Promise.resolve(w);
  }),
  deleteWorkflow: vi.fn(() => Promise.resolve()),
}));

// The guarded local-process backend (#1857) is mocked so no Tauri command runs;
// `invokeRunLocalProcess` records what it was asked to spawn.
const invokeRunLocalProcess = vi.fn((_args: { program: string; args: string[] }) =>
  Promise.resolve({ exitCode: 0 as number | null, timedOut: false, cancelled: false })
);
const cancelLocalProcess = vi.fn((_runId: string) => Promise.resolve(true));
// The last-registered streamed-output handler (#1865), so a test can push
// stdout/stderr chunks through the same seam #1857 emits them on.
type LocalProcessOutputChunk = { runId: string; stream: "stdout" | "stderr"; line: string };
let localProcessOutputHandler: ((chunk: LocalProcessOutputChunk) => void) | null = null;
const subscribeLocalProcessOutput = vi.fn(
  (_runId: string, onChunk: (chunk: LocalProcessOutputChunk) => void) => {
    localProcessOutputHandler = onChunk;
    return Promise.resolve(() => {
      localProcessOutputHandler = null;
    });
  }
);
vi.mock("@/services/localProcessApi", () => ({
  invokeRunLocalProcess: (args: { program: string; args: string[] }) => invokeRunLocalProcess(args),
  cancelLocalProcess: (runId: string) => cancelLocalProcess(runId),
  subscribeLocalProcessOutput: (runId: string, onChunk: (chunk: LocalProcessOutputChunk) => void) =>
    subscribeLocalProcessOutput(runId, onChunk),
}));

import { useAppStore } from "./appStore";
import { currentSettingsView } from "./settingsBridge";
import { setupSettingsRegion, seedSettings } from "@/test/settingsRegionTestHarness";
import { registerTerminalInputInjector } from "@/services/macroPlayback";
import { serializeWorkflows } from "@/services/workflowIo";
import { resetOnConnectDispatchState } from "@/services/workflowTriggers";
import { toast } from "@/components/ui";

setupSettingsRegion();

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

describe("appStore — workflow run slice (#1852)", () => {
  let injected: string[];

  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    resetOnConnectDispatchState();
    savedWorkflows.length = 0;
    injected = [];
    invokeRunLocalProcess.mockClear();
    cancelLocalProcess.mockClear();
    subscribeLocalProcessOutput.mockClear();
    localProcessOutputHandler = null;
    registerTerminalInputInjector(async (_tabId, data) => {
      injected.push(data);
      return true;
    });
    vi.spyOn(toast, "error");
    vi.spyOn(toast, "info");
    vi.spyOn(toast, "success");
    vi.spyOn(toast, "loading");
  });

  afterEach(() => {
    registerTerminalInputInjector(null);
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("runs every send-command step in order (with trailing newlines) into the active terminal", async () => {
    seedConnectedTerminal();
    useAppStore.setState({
      workflows: [workflow("w1", [cmd("sudo -v"), cmd("git status"), cmd("exit")])],
    });

    await useAppStore.getState().runWorkflow("w1");

    expect(injected).toEqual(["sudo -v\n", "git status\n", "exit\n"]);
    // Run state is cleared once the run finishes.
    expect(useAppStore.getState().workflowRun).toBeNull();
    expect(toast.success).toHaveBeenCalled();
  });

  it("defaults the target to the active terminal tab", async () => {
    const tabIds: string[] = [];
    registerTerminalInputInjector(async (tabId, data) => {
      tabIds.push(tabId);
      injected.push(data);
      return true;
    });
    seedConnectedTerminal("tab-xyz", "sess-xyz");
    useAppStore.setState({ workflows: [workflow("w1", [cmd("hi")])] });

    await useAppStore.getState().runWorkflow("w1");

    expect(tabIds).toEqual(["tab-xyz"]);
  });

  it("can be cancelled mid-run — the in-flight step finishes, the rest do not run", async () => {
    // Gate the first injection so the run is genuinely in flight when we cancel.
    let markStarted!: () => void;
    const started = new Promise<void>((r) => (markStarted = r));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let call = 0;
    registerTerminalInputInjector(async (_tabId, data) => {
      call += 1;
      injected.push(data);
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
    expect(useAppStore.getState().workflowRun).not.toBeNull();

    useAppStore.getState().cancelWorkflowRun();
    release();
    await done;

    expect(injected).toEqual(["a\n"]);
    expect(useAppStore.getState().workflowRun).toBeNull();
    expect(toast.info).toHaveBeenCalled();
  });

  it("runs run-script, wait, and run-macro steps end to end (#1853)", async () => {
    seedConnectedTerminal();
    const macro: Macro = {
      id: "m1",
      name: "tail log",
      tags: [],
      steps: [{ data: "tail -f app.log\n", delayMs: 0 }],
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };
    useAppStore.setState({
      macros: [macro],
      workflows: [
        workflow("w1", [
          { kind: "run-script", script: "line1\nline2" },
          { kind: "wait", delayMs: 0 },
          { kind: "run-macro", macroId: "m1" },
        ]),
      ],
    });

    await useAppStore.getState().runWorkflow("w1");

    // run-script streams each line, then run-macro replays via the same injector.
    expect(injected).toEqual(["line1\n", "line2\n", "tail -f app.log\n"]);
    expect(useAppStore.getState().workflowRun).toBeNull();
    expect(toast.success).toHaveBeenCalled();
  });

  describe("run-local-process guardrails (#1857)", () => {
    const lp = (program: string, args: string[]): WorkflowStep => ({
      kind: "run-local-process",
      program,
      args,
    });

    /** Enable the opt-in, optionally pre-authorizing programs. */
    function enableLocalProcess(allowlist: string[] = []) {
      seedSettings({
        workflowLocalProcessEnabled: true,
        workflowLocalProcessAllowlist: allowlist,
      });
    }

    it("GUARDRAIL: refuses to spawn when the opt-in is off (default)", async () => {
      seedConnectedTerminal();
      useAppStore.setState({ workflows: [workflow("w1", [cmd("a"), lp("rm", ["-rf", "/"])])] });

      await useAppStore.getState().runWorkflow("w1");

      // The prior send ran; the local process NEVER spawned.
      expect(injected).toEqual(["a\n"]);
      expect(invokeRunLocalProcess).not.toHaveBeenCalled();
      expect(toast.error).toHaveBeenCalled();
    });

    it("runs an allowlisted program without prompting, passing discrete args", async () => {
      seedConnectedTerminal();
      enableLocalProcess(["notify-send"]);
      useAppStore.setState({
        workflows: [workflow("w1", [lp("notify-send", ["--urgency", "hello world"])])],
      });

      await useAppStore.getState().runWorkflow("w1");

      expect(useAppStore.getState().localProcessPrompt).toBeNull();
      expect(invokeRunLocalProcess).toHaveBeenCalledTimes(1);
      const call = invokeRunLocalProcess.mock.calls[0][0] as unknown as {
        program: string;
        args: string[];
      };
      expect(call.program).toBe("notify-send");
      // GUARDRAIL: the space-containing arg stays a single, literal argv entry.
      expect(call.args).toEqual(["--urgency", "hello world"]);
      expect(toast.success).toHaveBeenCalled();
    });

    it("prompts for a not-yet-trusted program and runs it on 'allow once'", async () => {
      seedConnectedTerminal();
      enableLocalProcess([]);
      useAppStore.setState({ workflows: [workflow("w1", [lp("echo", ["hi"])])] });

      const done = useAppStore.getState().runWorkflow("w1");
      // Wait for the prompt to open.
      await vi.waitFor(() => expect(useAppStore.getState().localProcessPrompt).not.toBeNull());
      expect(useAppStore.getState().localProcessPrompt?.program).toBe("echo");

      useAppStore.getState().resolveLocalProcessPrompt("once");
      await done;

      expect(invokeRunLocalProcess).toHaveBeenCalledTimes(1);
      // "once" does NOT persist the program to the allowlist.
      expect(currentSettingsView().workflowLocalProcessAllowlist).toEqual([]);
    });

    it("'always allow' persists the program to the allowlist", async () => {
      seedConnectedTerminal();
      enableLocalProcess([]);
      useAppStore.setState({ workflows: [workflow("w1", [lp("echo", ["hi"])])] });

      const done = useAppStore.getState().runWorkflow("w1");
      await vi.waitFor(() => expect(useAppStore.getState().localProcessPrompt).not.toBeNull());
      useAppStore.getState().resolveLocalProcessPrompt("always");
      await done;

      expect(invokeRunLocalProcess).toHaveBeenCalledTimes(1);
      expect(currentSettingsView().workflowLocalProcessAllowlist).toContain("echo");
    });

    it("GUARDRAIL: 'cancel' refuses — the process never spawns", async () => {
      seedConnectedTerminal();
      enableLocalProcess([]);
      useAppStore.setState({ workflows: [workflow("w1", [lp("echo", ["hi"])])] });

      const done = useAppStore.getState().runWorkflow("w1");
      await vi.waitFor(() => expect(useAppStore.getState().localProcessPrompt).not.toBeNull());
      useAppStore.getState().resolveLocalProcessPrompt("cancel");
      await done;

      expect(invokeRunLocalProcess).not.toHaveBeenCalled();
      expect(toast.error).toHaveBeenCalled();
    });

    // --- Inline run-output surface (#1865) ---

    it("accumulates streamed stdout/stderr into the inline run-output surface", async () => {
      seedConnectedTerminal();
      enableLocalProcess(["make"]);
      useAppStore.setState({ workflows: [workflow("w1", [lp("make", ["build"])])] });
      // The spawn emits two lines through the same event seam #1857 uses, then
      // exits 0. Emitting inside the invoke mock guarantees the handler is set.
      invokeRunLocalProcess.mockImplementationOnce(() => {
        localProcessOutputHandler?.({ runId: "r", stream: "stdout", line: "compiling" });
        localProcessOutputHandler?.({ runId: "r", stream: "stderr", line: "warning: unused" });
        return Promise.resolve({ exitCode: 0, timedOut: false, cancelled: false });
      });

      await useAppStore.getState().runWorkflow("w1");

      const out = useAppStore.getState().workflowRunOutput;
      expect(out).not.toBeNull();
      expect(out?.program).toBe("make");
      expect(out?.lines.map((l) => [l.stream, l.text])).toEqual([
        ["stdout", "compiling"],
        ["stderr", "warning: unused"],
      ]);
      // The run finished cleanly — the surface reflects the terminal outcome.
      expect(out?.status).toBe("completed");
      expect(out?.exitCode).toBe(0);
    });

    it("marks the run-output surface failed with the exit code on a non-zero exit", async () => {
      seedConnectedTerminal();
      enableLocalProcess(["make"]);
      useAppStore.setState({ workflows: [workflow("w1", [lp("make", ["build"])])] });
      invokeRunLocalProcess.mockImplementationOnce(() =>
        Promise.resolve({ exitCode: 2, timedOut: false, cancelled: false })
      );

      await useAppStore.getState().runWorkflow("w1");

      const out = useAppStore.getState().workflowRunOutput;
      expect(out?.status).toBe("failed");
      expect(out?.exitCode).toBe(2);
    });

    it("does not open a run-output surface for a terminal-native workflow", async () => {
      seedConnectedTerminal();
      useAppStore.setState({ workflows: [workflow("w1", [cmd("echo hi")])] });

      await useAppStore.getState().runWorkflow("w1");

      // No local process ran, so the inline surface stays null.
      expect(useAppStore.getState().workflowRunOutput).toBeNull();
    });

    it("dismissWorkflowRunOutput clears the surface", async () => {
      seedConnectedTerminal();
      enableLocalProcess(["make"]);
      useAppStore.setState({ workflows: [workflow("w1", [lp("make", ["build"])])] });

      await useAppStore.getState().runWorkflow("w1");
      expect(useAppStore.getState().workflowRunOutput).not.toBeNull();

      useAppStore.getState().dismissWorkflowRunOutput();
      expect(useAppStore.getState().workflowRunOutput).toBeNull();
    });
  });

  it("errors when the workflow does not exist", async () => {
    seedConnectedTerminal();
    await useAppStore.getState().runWorkflow("missing");

    expect(injected).toEqual([]);
    expect(toast.error).toHaveBeenCalled();
  });

  it("errors when there is no connected terminal", async () => {
    seedConnectedTerminal("tab-active", null); // no session → not connected
    useAppStore.setState({ workflows: [workflow("w1", [cmd("x")])] });

    await useAppStore.getState().runWorkflow("w1");

    expect(injected).toEqual([]);
    expect(toast.error).toHaveBeenCalled();
  });

  it("errors when the target terminal has exited", async () => {
    seedConnectedTerminal();
    useAppStore.setState({
      workflows: [workflow("w1", [cmd("x")])],
      terminalExitedTabs: { "tab-active": true },
    });

    await useAppStore.getState().runWorkflow("w1");

    expect(injected).toEqual([]);
    expect(toast.error).toHaveBeenCalled();
  });

  it("does nothing but inform the user for an empty workflow", async () => {
    seedConnectedTerminal();
    useAppStore.setState({ workflows: [workflow("w1", [])] });

    await useAppStore.getState().runWorkflow("w1");

    expect(injected).toEqual([]);
    expect(toast.info).toHaveBeenCalled();
    expect(useAppStore.getState().workflowRun).toBeNull();
  });

  it("cancelWorkflowRun is a no-op when nothing is running", () => {
    expect(() => useAppStore.getState().cancelWorkflowRun()).not.toThrow();
  });

  it("saves a workflow to the backend and refreshes the library", async () => {
    await useAppStore.getState().saveWorkflowToBackend(workflow("w1", [cmd("ls")]));
    expect(useAppStore.getState().workflows.map((w) => w.id)).toEqual(["w1"]);
  });

  it("imports workflows from an exported file, giving them fresh ids", async () => {
    useAppStore.setState({ workflows: [] });
    const json = serializeWorkflows([workflow("original", [cmd("ls")])]);

    const result = await useAppStore.getState().importWorkflows(json);

    expect(result.imported).toBe(1);
    // A clean file carries no run-local-process steps to flag.
    expect(result.localProcessSteps).toBe(0);
    expect(result.workflowsWithLocalProcess).toBe(0);
    const imported = useAppStore.getState().workflows;
    expect(imported).toHaveLength(1);
    // A fresh id is assigned on import (never the file's original id).
    expect(imported[0].id).not.toBe("original");
    expect(imported[0].steps).toEqual([cmd("ls")]);
  });

  it("flags imported run-local-process steps without stripping them", async () => {
    useAppStore.setState({ workflows: [] });
    const json = serializeWorkflows([
      {
        ...workflow("danger", [cmd("ls")]),
        steps: [
          { kind: "send-command", command: "ls" },
          { kind: "run-local-process", program: "echo", args: ["hi"] },
        ],
      },
    ]);

    const result = await useAppStore.getState().importWorkflows(json);

    // The step count is surfaced so the caller can warn the user...
    expect(result.imported).toBe(1);
    expect(result.workflowsWithLocalProcess).toBe(1);
    expect(result.localProcessSteps).toBe(1);
    // ...and the step is preserved (not stripped), so #1857's run-time guard applies.
    const imported = useAppStore.getState().workflows;
    expect(imported[0].steps).toContainEqual({
      kind: "run-local-process",
      program: "echo",
      args: ["hi"],
    });
  });
});

describe("appStore — on-connect trigger dispatch (#1855)", () => {
  let injected: string[];

  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    resetOnConnectDispatchState();
    injected = [];
    registerTerminalInputInjector(async (_tabId, data) => {
      injected.push(data);
      return true;
    });
  });

  afterEach(() => {
    registerTerminalInputInjector(null);
    vi.restoreAllMocks();
  });

  /** Seed a terminal tab opened from `connectionId`, not yet connected. */
  function seedUnconnectedTab(connectionId: string | undefined, tabId = "tab-oc") {
    const tab: TerminalTab = {
      id: tabId,
      sessionId: null,
      title: "term",
      connectionType: "ssh",
      contentType: "terminal",
      config: { type: "ssh", config: {} },
      panelId: "leaf-1",
      isActive: true,
      ...(connectionId ? { connectionId } : {}),
    };
    const leaf: LeafPanel = { type: "leaf", id: "leaf-1", tabs: [tab], activeTabId: tabId };
    useAppStore.setState({ rootPanel: leaf, activePanelId: "leaf-1", terminalExitedTabs: {} });
  }

  function onConnectWorkflow(id: string, connectionIds: string[]): Workflow {
    return {
      ...workflow(id, [cmd(`echo ${id}`)]),
      triggers: [{ kind: "on-connect", connectionIds }],
    };
  }

  it("runs an on-connect workflow when a bound connection's session opens", async () => {
    useAppStore.setState({ workflows: [onConnectWorkflow("wf-a", ["conn-1"])] });
    seedUnconnectedTab("conn-1");

    useAppStore.getState().setTabSessionId("tab-oc", "sess-oc-1");

    await vi.waitFor(() => expect(injected).toContain("echo wf-a\n"));
  });

  it("does not run for a connection with no matching on-connect trigger", async () => {
    useAppStore.setState({ workflows: [onConnectWorkflow("wf-a", ["conn-other"])] });
    seedUnconnectedTab("conn-1");

    useAppStore.getState().setTabSessionId("tab-oc", "sess-oc-2");

    await new Promise((r) => setTimeout(r, 20));
    expect(injected).toEqual([]);
  });

  it("fires at most once per session open", async () => {
    useAppStore.setState({ workflows: [onConnectWorkflow("wf-a", ["conn-1"])] });
    seedUnconnectedTab("conn-1");

    useAppStore.getState().setTabSessionId("tab-oc", "sess-oc-3");
    await vi.waitFor(() => expect(injected).toContain("echo wf-a\n"));
    // A redundant session-open signal for the same session must not re-run it.
    useAppStore.getState().setTabSessionId("tab-oc", "sess-oc-3");
    await new Promise((r) => setTimeout(r, 20));

    expect(injected.filter((d) => d === "echo wf-a\n")).toHaveLength(1);
  });

  it("does not run on-connect workflows for a tab with no connection id", async () => {
    useAppStore.setState({ workflows: [onConnectWorkflow("wf-a", ["conn-1"])] });
    seedUnconnectedTab(undefined);

    useAppStore.getState().setTabSessionId("tab-oc", "sess-oc-4");

    await new Promise((r) => setTimeout(r, 20));
    expect(injected).toEqual([]);
  });
});
