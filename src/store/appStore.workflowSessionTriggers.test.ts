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

vi.mock("@/themes", () => ({
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(() => vi.fn()),
}));

const savedWorkflows: Workflow[] = [];
vi.mock("@/services/workflowApi", () => ({
  listWorkflows: vi.fn(() => Promise.resolve([...savedWorkflows])),
  getWorkflow: vi.fn(),
  saveWorkflow: vi.fn((w: Workflow) => Promise.resolve(w)),
  deleteWorkflow: vi.fn(() => Promise.resolve()),
  listWorkflowRuns: vi.fn(() => Promise.resolve([])),
  recordWorkflowRun: vi.fn(() => Promise.resolve([])),
  clearWorkflowRunHistory: vi.fn(() => Promise.resolve([])),
}));

import { useAppStore } from "./appStore";
import { recordWorkflowRun as apiRecordWorkflowRun } from "@/services/workflowApi";
import { seedLayoutState } from "@/test/layoutState";
import { setupSettingsRegion } from "@/test/settingsRegionTestHarness";
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
      const tap = setTap.mock.calls.at(-1)?.[0] ?? null;
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
});
