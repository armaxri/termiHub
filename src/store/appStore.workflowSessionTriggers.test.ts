/**
 * Store wiring of the session-driven workflow triggers (#3791): on-disconnect
 * fires from `setTerminalExited` / `closeTab` with the right cause and without
 * a live session, and on-output-match fires from the terminal output tap into
 * the matching tab. The backend, injector and output events are mocked.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { LeafPanel, TerminalTab } from "@/types/terminal";
import type { Workflow, WorkflowStep, WorkflowTrigger } from "@/types/workflow";

vi.mock("@/services/storage", () => ({
  loadConnections: vi.fn(() =>
    Promise.resolve({ connections: [], folders: [], agents: [], externalErrors: [] })
  ),
  persistConnection: vi.fn(() => Promise.resolve()),
  removeConnection: vi.fn(() => Promise.resolve()),
  persistFolder: vi.fn(() => Promise.resolve()),
  removeFolder: vi.fn(() => Promise.resolve()),
  getSettings: vi.fn(() =>
    Promise.resolve({ version: "1", externalConnectionFiles: [], powerMonitoringEnabled: true })
  ),
  saveSettings: vi.fn(() => Promise.resolve()),
  moveConnectionToFile: vi.fn(() => Promise.resolve()),
  reloadExternalConnections: vi.fn(() => Promise.resolve([])),
  getRecoveryWarnings: vi.fn(() => Promise.resolve([])),
}));

const invokeRunLocalProcess = vi.hoisted(() =>
  vi.fn(() => Promise.resolve({ exitCode: 0, timedOut: false, cancelled: false }))
);
vi.mock("@/services/localProcessApi", () => ({
  // The backend's rule, over the seeded settings: the program as written or its file.
  checkLocalProcess: vi.fn(async (program: string) => {
    const { currentSettingsView } = await import("@/store/settingsBridge");
    const list = currentSettingsView().workflowLocalProcessAllowlist ?? [];
    const path = `/bin/${program}`;
    return list.includes(program) || list.includes(path)
      ? { status: "allowed", path }
      : { status: "ask", path, reason: `"${program}" (${path}) is not an allowed program.` };
  }),
  invokeRunLocalProcess,
  cancelLocalProcess: vi.fn(() => Promise.resolve(true)),
  subscribeLocalProcessOutput: vi.fn(() => Promise.resolve(() => {})),
}));

vi.mock("@/themes", () => ({
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(() => vi.fn()),
}));

// The automation store's IPC (#5818, slice 4), emulated over the workflow
// view: `savedWorkflows` is the library, `apiSaveWorkflow` sees each saved
// workflow view and `apiRecordWorkflowRun` each recorded workflow run.
const savedWorkflows: Workflow[] = [];
const apis = vi.hoisted(() => ({
  apiSaveWorkflow: vi.fn(),
  apiRecordWorkflowRun: vi.fn((_run: import("@/types/workflow").WorkflowRun) =>
    Promise.resolve([] as unknown[])
  ),
}));
vi.mock("@/services/automationApi", async () => {
  const views = await vi.importActual<typeof import("./slices/automationViews")>(
    "./slices/automationViews"
  );
  apis.apiSaveWorkflow.mockImplementation((w: Workflow) => Promise.resolve(w));
  return {
    listAutomations: vi.fn(() =>
      Promise.resolve(savedWorkflows.map((w) => views.workflowToAutomation(w)))
    ),
    saveAutomation: vi.fn(async (a: import("@/types/generated/Automation").Automation) =>
      views.workflowToAutomation(await apis.apiSaveWorkflow(views.automationToWorkflow(a)))
    ),
    deleteAutomation: vi.fn(() => Promise.resolve()),
    listAutomationRuns: vi.fn(() => Promise.resolve([])),
    recordAutomationRun: vi.fn((run: import("@/types/generated/AutomationRun").AutomationRun) =>
      apis.apiRecordWorkflowRun(views.automationRunToWorkflowRun(run))
    ),
    clearAutomationRunHistory: vi.fn(() => Promise.resolve([])),
  };
});
const { apiSaveWorkflow, apiRecordWorkflowRun } = apis;

import { toast } from "@/components/ui";
import { LOCAL_PROCESS_REASON } from "@/utils/localProcessGate";
import { useAppStore } from "./appStore";
import { seedLayoutState } from "@/test/layoutState";
import { seedSettings, setupSettingsRegion } from "@/test/settingsRegionTestHarness";
import { installSessionLifecycleHarness } from "@/test/sessionLifecycleRegionTestHarness";
import { registerTerminalInputInjector } from "@/services/macroPlayback";
import { terminalDispatcher } from "@/services/events";
import { OUTPUT_TRIGGER_LIMITS } from "@/services/workflowOutputTriggers";
import { resetOnDisconnectDispatchState } from "@/services/workflowTriggers";
import { resetWorkflowSessionTriggers } from "./workflowSessionTriggers";

setupSettingsRegion();

const workflow = (id: string, steps: WorkflowStep[], triggers: WorkflowTrigger[]): Workflow => ({
  id,
  name: `Workflow ${id}`,
  tags: [],
  steps,
  triggers,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
});

/** Seed one connected terminal tab opened from saved connection `conn-1`. */
function seedTab(sessionId: string | null = "sess-1") {
  const tab: TerminalTab = {
    id: "tab-1",
    sessionId,
    title: "prod",
    connectionType: "ssh",
    contentType: "terminal",
    config: { type: "ssh", config: {} },
    panelId: "leaf-1",
    isActive: true,
    connectionId: "conn-1",
  };
  const leaf: LeafPanel = { type: "leaf", id: "leaf-1", tabs: [tab], activeTabId: "tab-1" };
  seedLayoutState({ rootPanel: leaf, activePanelId: "leaf-1" });
}

/** The `triggeredBy` + status of every recorded run. */
function recorded(): { triggeredBy: string; status: string }[] {
  return vi
    .mocked(apiRecordWorkflowRun)
    .mock.calls.map(([run]) => ({ triggeredBy: run.triggeredBy, status: run.status }));
}

describe("appStore — session-driven workflow triggers (#3791)", () => {
  let injected: string[];
  installSessionLifecycleHarness();

  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    resetOnDisconnectDispatchState();
    resetWorkflowSessionTriggers();
    vi.mocked(apiRecordWorkflowRun).mockClear();
    savedWorkflows.length = 0;
    injected = [];
    registerTerminalInputInjector(async (_tabId, data) => {
      injected.push(data);
      return true;
    });
  });

  afterEach(() => {
    registerTerminalInputInjector(null);
    resetWorkflowSessionTriggers();
    vi.restoreAllMocks();
  });

  describe("on-disconnect", () => {
    const wait: WorkflowStep = { kind: "wait", delayMs: 0 };

    it("runs on a drop, without a live session", async () => {
      useAppStore.setState({
        workflows: [
          workflow("wf-a", [wait], [{ kind: "on-disconnect", connectionIds: ["conn-1"] }]),
        ],
      });
      seedTab();

      useAppStore.getState().setTerminalExited("tab-1", { code: null, reason: "dropped" });

      await vi.waitFor(() =>
        expect(recorded()).toEqual([{ triggeredBy: "on-disconnect", status: "completed" }])
      );
    });

    it("never types into the dead session", async () => {
      useAppStore.setState({
        workflows: [
          workflow(
            "wf-a",
            [{ kind: "send-command", command: "echo hi" }],
            [{ kind: "on-disconnect", connectionIds: ["conn-1"] }]
          ),
        ],
      });
      seedTab();

      useAppStore.getState().setTerminalExited("tab-1", { code: 1, reason: "dropped" });

      await vi.waitFor(() =>
        expect(recorded()).toEqual([{ triggeredBy: "on-disconnect", status: "failed" }])
      );
      expect(injected).toEqual([]);
    });

    it("does not run on a user kill when the trigger fires on drops only", async () => {
      useAppStore.setState({
        workflows: [
          workflow("wf-a", [wait], [{ kind: "on-disconnect", connectionIds: ["conn-1"] }]),
        ],
      });
      seedTab();

      useAppStore.getState().setTerminalExited("tab-1", { code: null, reason: "killed" });

      await new Promise((r) => setTimeout(r, 20));
      expect(recorded()).toEqual([]);
    });

    it("runs a user-close trigger when a live tab is closed, once", async () => {
      useAppStore.setState({
        workflows: [
          workflow(
            "wf-a",
            [wait],
            [{ kind: "on-disconnect", connectionIds: ["conn-1"], when: "user-close" }]
          ),
        ],
      });
      seedTab();

      useAppStore.getState().closeTab("tab-1", "leaf-1");
      // A late exit event for the torn-down session is the same end.
      useAppStore.getState().setTerminalExited("tab-1", { code: 0, reason: "clean" });

      await vi.waitFor(() => expect(recorded()).toHaveLength(1));
      await new Promise((r) => setTimeout(r, 20));
      expect(recorded()).toEqual([{ triggeredBy: "on-disconnect", status: "completed" }]);
    });

    it("does not run a drops-only trigger when a live tab is closed", async () => {
      useAppStore.setState({
        workflows: [
          workflow("wf-a", [wait], [{ kind: "on-disconnect", connectionIds: ["conn-1"] }]),
        ],
      });
      seedTab();

      useAppStore.getState().closeTab("tab-1", "leaf-1");

      await new Promise((r) => setTimeout(r, 20));
      expect(recorded()).toEqual([]);
    });
  });

  describe("on-output-match", () => {
    /** Install the triggers the way `loadWorkflows` does and capture the output tap. */
    async function loadWithTap(triggers: WorkflowTrigger[]) {
      const setTap = vi.spyOn(terminalDispatcher, "setOutputTap");
      savedWorkflows.push(
        workflow("wf-m", [{ kind: "send-command", command: "uptime" }], triggers)
      );
      await useAppStore.getState().loadWorkflows();
      const tap = setTap.mock.calls[setTap.mock.calls.length - 1]?.[0] ?? null;
      return tap;
    }

    const encode = (text: string) => btoa(text);

    it("runs the workflow in the tab whose output matched", async () => {
      seedTab("sess-1");
      const tap = await loadWithTap([
        { kind: "on-output-match", connectionIds: ["conn-1"], pattern: "load average" },
      ]);
      expect(tap).not.toBeNull();

      tap!("sess-1", encode("\u001b[32m up 3 days, load average: 0.10\r\n"));

      await vi.waitFor(() => expect(injected).toEqual(["uptime\n"]), {
        timeout: OUTPUT_TRIGGER_LIMITS.batchMs * 20,
      });
      expect(recorded()[0]?.triggeredBy).toBe("on-output-match");
    });

    it("does not run for output that does not match", async () => {
      seedTab("sess-1");
      const tap = await loadWithTap([
        { kind: "on-output-match", connectionIds: ["conn-1"], pattern: "load average" },
      ]);

      tap!("sess-1", encode("nothing to see\r\n"));

      await new Promise((r) => setTimeout(r, OUTPUT_TRIGGER_LIMITS.batchMs * 3));
      expect(injected).toEqual([]);
    });

    it("installs no output tap without a valid trigger", async () => {
      seedTab("sess-1");
      const tap = await loadWithTap([
        { kind: "on-output-match", connectionIds: ["conn-1"], pattern: "(a+)+", isRegex: true },
      ]);
      expect(tap).toBeNull();
    });
  });

  describe("a local-process workflow (#5988)", () => {
    const steps: WorkflowStep[] = [{ kind: "run-local-process", program: "make", args: [] }];
    const fireOutput = async () => {
      const setTap = vi.spyOn(terminalDispatcher, "setOutputTap");
      await useAppStore.getState().loadWorkflows();
      setTap.mock.calls[setTap.mock.calls.length - 1]?.[0]?.("sess-1", btoa("match\r\n"));
    };
    const fireDisconnect = async () => {
      await useAppStore.getState().loadWorkflows();
      useAppStore.getState().setTerminalExited("tab-1", { code: null, reason: "dropped" });
    };
    const origins: [string, WorkflowTrigger, () => Promise<void>][] = [
      ["on-disconnect", { kind: "on-disconnect", connectionIds: ["conn-1"] }, fireDisconnect],
      [
        "on-output-match",
        { kind: "on-output-match", connectionIds: ["conn-1"], pattern: "match" },
        fireOutput,
      ],
    ];
    const allow = (experimentalFeaturesEnabled?: boolean) =>
      seedSettings({
        experimentalFeaturesEnabled,
        workflowLocalProcessEnabled: true,
        workflowLocalProcessAllowlist: ["make"],
      });
    beforeEach(() => invokeRunLocalProcess.mockClear());

    it.each(origins)("experimental off: %s is refused up front", async (_name, trigger, fire) => {
      const error = vi.spyOn(toast, "error");
      allow(false);
      savedWorkflows.push(workflow("wf-lp", steps, [trigger]));
      seedTab("sess-1");
      await fire();
      await vi.waitFor(
        () =>
          expect(error).toHaveBeenCalledWith(
            'Workflow "Workflow wf-lp" was not run',
            expect.objectContaining({ description: LOCAL_PROCESS_REASON })
          ),
        { timeout: OUTPUT_TRIGGER_LIMITS.batchMs * 20 }
      );
      expect(invokeRunLocalProcess).not.toHaveBeenCalled();
      expect(recorded()).toEqual([]);
    });

    it.each(origins)("experimental on: %s runs as before", async (name, trigger, fire) => {
      allow(true);
      savedWorkflows.push(workflow("wf-lp", steps, [trigger]));
      seedTab("sess-1");
      await fire();
      await vi.waitFor(() => expect(invokeRunLocalProcess).toHaveBeenCalledTimes(1), {
        timeout: OUTPUT_TRIGGER_LIMITS.batchMs * 20,
      });
      await vi.waitFor(() =>
        expect(recorded()).toEqual([{ triggeredBy: name, status: "completed" }])
      );
    });
  });

  describe("disarm toggle (#5674)", () => {
    const outputMatch: WorkflowTrigger = {
      kind: "on-output-match",
      connectionIds: ["conn-1"],
      pattern: "load average",
    };

    /** The output tap most recently installed (or removed, `null`). */
    function lastTap(setTap: { mock: { calls: unknown[][] } }) {
      const calls = setTap.mock.calls;
      return calls[calls.length - 1]?.[0] as ((sid: string, data: string) => void) | null;
    }

    /** Make the mocked backend persist saves into `savedWorkflows`. */
    function persistSaves() {
      vi.mocked(apiSaveWorkflow).mockImplementation((w: Workflow) => {
        const i = savedWorkflows.findIndex((s) => s.id === w.id);
        if (i >= 0) savedWorkflows[i] = w;
        else savedWorkflows.push(w);
        return Promise.resolve(w);
      });
    }

    afterEach(() => {
      vi.mocked(apiSaveWorkflow).mockImplementation((w: Workflow) => Promise.resolve(w));
    });

    it("disarms without touching the triggers, and a disarmed trigger never fires", async () => {
      persistSaves();
      seedTab("sess-1");
      const setTap = vi.spyOn(terminalDispatcher, "setOutputTap");
      savedWorkflows.push(
        workflow("wf-m", [{ kind: "send-command", command: "uptime" }], [outputMatch])
      );
      await useAppStore.getState().loadWorkflows();
      expect(lastTap(setTap)).not.toBeNull();

      await useAppStore.getState().setWorkflowTriggersEnabled("wf-m", false);

      const saved = useAppStore.getState().workflows[0];
      expect(saved.triggersEnabled).toBe(false);
      // The view always carries the manual trigger (#5818, slice 4).
      expect(saved.triggers).toEqual([{ kind: "manual" }, outputMatch]);
      // With only a disarmed trigger left, the output tap is removed entirely.
      expect(lastTap(setTap)).toBeNull();
      await new Promise((r) => setTimeout(r, OUTPUT_TRIGGER_LIMITS.batchMs * 3));
      expect(injected).toEqual([]);
      expect(recorded()).toEqual([]);
    });

    it("re-arms by dropping the flag, which reinstalls the output tap", async () => {
      persistSaves();
      seedTab("sess-1");
      const setTap = vi.spyOn(terminalDispatcher, "setOutputTap");
      savedWorkflows.push({
        ...workflow("wf-m", [{ kind: "send-command", command: "uptime" }], [outputMatch]),
        triggersEnabled: false,
      });
      await useAppStore.getState().loadWorkflows();
      expect(lastTap(setTap)).toBeNull();

      await useAppStore.getState().setWorkflowTriggersEnabled("wf-m", true);

      expect("triggersEnabled" in useAppStore.getState().workflows[0]).toBe(false);
      const tap = lastTap(setTap) ?? null;
      expect(tap).not.toBeNull();
      tap!("sess-1", btoa("load average: 0.10\r\n"));
      await vi.waitFor(() => expect(injected).toEqual(["uptime\n"]), {
        timeout: OUTPUT_TRIGGER_LIMITS.batchMs * 20,
      });
    });

    it("re-checks the flag at launch, so a just-disarmed match never runs", async () => {
      seedTab("sess-1");
      const setTap = vi.spyOn(terminalDispatcher, "setOutputTap");
      savedWorkflows.push(
        workflow("wf-m", [{ kind: "send-command", command: "uptime" }], [outputMatch])
      );
      await useAppStore.getState().loadWorkflows();
      const tap = lastTap(setTap) ?? null;
      // Disarmed in the store before the engine was recompiled.
      const [armed] = useAppStore.getState().workflows;
      useAppStore.setState({ workflows: [{ ...armed, triggersEnabled: false }] });

      tap!("sess-1", btoa("load average: 0.10\r\n"));

      await new Promise((r) => setTimeout(r, OUTPUT_TRIGGER_LIMITS.batchMs * 3));
      expect(injected).toEqual([]);
      expect(recorded()).toEqual([]);
    });

    it("does not run a disarmed on-disconnect trigger on a drop", async () => {
      useAppStore.setState({
        workflows: [
          {
            ...workflow(
              "wf-a",
              [{ kind: "wait", delayMs: 0 }],
              [{ kind: "on-disconnect", connectionIds: ["conn-1"] }]
            ),
            triggersEnabled: false,
          },
        ],
      });
      seedTab();

      useAppStore.getState().setTerminalExited("tab-1", { code: null, reason: "dropped" });

      await new Promise((r) => setTimeout(r, 20));
      expect(recorded()).toEqual([]);
    });

    it("rejects for an unknown workflow and saves nothing", async () => {
      vi.mocked(apiSaveWorkflow).mockClear();
      await expect(
        useAppStore.getState().setWorkflowTriggersEnabled("nope", false)
      ).rejects.toThrow("Workflow not found");
      expect(apiSaveWorkflow).not.toHaveBeenCalled();
    });
  });
});
