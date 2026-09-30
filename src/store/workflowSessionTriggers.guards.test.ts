/**
 * The launch guards of the session-driven workflow triggers (#3791, #3992).
 *
 * `appStore.workflowSessionTriggers.test.ts` covers the happy paths end to end.
 * A triggered run is unattended, so it must *skip* rather than queue or prompt
 * whenever it cannot run cleanly. Those skips had no test:
 *
 * - another run (triggered or manual) is in flight;
 * - another workflow is waiting for input, or a macro is playing;
 * - the workflow has no steps;
 * - a required parameter has no default (surfaced as a toast);
 * - the run itself fails (logged; the in-flight claim is released);
 * - the trigger hook throws (logged; the tab-close / exit path still completes).
 *
 * `runWorkflowOnTarget` is replaced by a controllable double so each test decides
 * when (and how) the launched run settles.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LeafPanel, LogEntry, TerminalTab } from "@/types/terminal";
import type { Workflow, WorkflowParameter, WorkflowStep } from "@/types/workflow";
import { toast } from "@/components/ui";
import { resetOnDisconnectDispatchState } from "@/services/workflowTriggers";
import { onFrontendLog } from "@/utils/frontendLog";
import { seedLayoutState } from "@/test/layoutState";
import { setupSettingsRegion } from "@/test/settingsRegionTestHarness";
import { installSessionLifecycleHarness } from "@/test/sessionLifecycleRegionTestHarness";

const runner = vi.hoisted(() => ({
  runWorkflowOnTarget: vi.fn(),
  activeWorkflowRunCount: vi.fn(() => 0),
}));

vi.mock("./slices/workflowRunOnTarget", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./slices/workflowRunOnTarget")>()),
  runWorkflowOnTarget: runner.runWorkflowOnTarget,
  activeWorkflowRunCount: runner.activeWorkflowRunCount,
}));

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

vi.mock("@/themes", () => ({
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(() => vi.fn()),
}));

import { useAppStore } from "./appStore";
import type { AppState } from "./appStore";
import {
  notifyWorkflowSessionExited,
  notifyWorkflowTabClosing,
  resetWorkflowSessionTriggers,
  type WorkflowTriggerStore,
} from "./workflowSessionTriggers";

setupSettingsRegion();

const WAIT: WorkflowStep = { kind: "wait", delayMs: 0 };

function workflow(
  id: string,
  steps: WorkflowStep[] = [WAIT],
  parameters?: WorkflowParameter[]
): Workflow {
  return {
    id,
    name: `Workflow ${id}`,
    tags: [],
    steps,
    triggers: [{ kind: "on-disconnect", connectionIds: ["conn-1"] }],
    ...(parameters ? { parameters } : {}),
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

/** Seed one terminal tab opened from saved connection `conn-1`. */
function seedTab(sessionId: string | null = "sess-1"): void {
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

const store: WorkflowTriggerStore = {
  get: () => useAppStore.getState(),
  set: (partial) => useAppStore.setState(partial),
};

/** Fire the tab's on-disconnect triggers (a dropped session). */
const drop = () => notifyWorkflowSessionExited(store, "tab-1", "dropped");

/** A run the test settles by hand. */
function deferredRun(): { resolve: () => void; reject: (err: unknown) => void } {
  let resolve!: () => void;
  let reject!: (err: unknown) => void;
  runner.runWorkflowOnTarget.mockImplementationOnce(
    () =>
      new Promise<void>((res, rej) => {
        resolve = res;
        reject = rej;
      })
  );
  return { resolve: () => resolve(), reject: (err) => reject(err) };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

let logs: LogEntry[] = [];
let offLog: (() => void) | null = null;
const skips = () => logs.map((l) => l.message).filter((m) => m.includes("skipped"));

describe("workflowSessionTriggers launch guards", () => {
  installSessionLifecycleHarness();

  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    resetOnDisconnectDispatchState();
    resetWorkflowSessionTriggers();
    runner.runWorkflowOnTarget.mockReset().mockResolvedValue(undefined);
    runner.activeWorkflowRunCount.mockReset().mockReturnValue(0);
    logs = [];
    offLog = onFrontendLog((entry) => logs.push(entry));
    seedTab();
  });

  afterEach(() => {
    offLog?.();
    resetWorkflowSessionTriggers();
    vi.restoreAllMocks();
  });

  it("launches an unattended, sessionless run on a drop", () => {
    useAppStore.setState({ workflows: [workflow("wf-a")] });
    drop();

    expect(runner.runWorkflowOnTarget).toHaveBeenCalledTimes(1);
    expect(runner.runWorkflowOnTarget.mock.calls[0][0]).toMatchObject({
      targetTabId: "tab-1",
      targetSessionId: "sess-1",
      targetLabel: "prod",
      triggeredBy: "on-disconnect",
      unattended: true,
      sessionless: true,
    });
  });

  it("passes an empty session id when the tab never had a session", () => {
    seedTab(null);
    useAppStore.setState({ workflows: [workflow("wf-a")] });
    drop();

    expect(runner.runWorkflowOnTarget.mock.calls[0][0]).toMatchObject({ targetSessionId: "" });
  });

  it("skips while another workflow run is in progress", () => {
    runner.activeWorkflowRunCount.mockReturnValue(1);
    useAppStore.setState({ workflows: [workflow("wf-a")] });
    drop();

    expect(runner.runWorkflowOnTarget).not.toHaveBeenCalled();
    expect(skips()).toEqual([
      expect.stringContaining('"Workflow wf-a" skipped: another workflow run is in progress'),
    ]);
  });

  it("claims the slot synchronously: a second trigger in the same tick is skipped", async () => {
    const first = deferredRun();
    useAppStore.setState({ workflows: [workflow("wf-a"), workflow("wf-b")] });
    drop();

    expect(runner.runWorkflowOnTarget).toHaveBeenCalledTimes(1);
    expect(skips()).toEqual([expect.stringContaining('"Workflow wf-b" skipped')]);

    // Once the first run settles, the claim is released and a new end can run.
    first.resolve();
    await settle();
    resetOnDisconnectDispatchState();
    drop();
    expect(runner.runWorkflowOnTarget).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["a parameter prompt", { workflowParamPrompt: {} }, "another workflow is waiting for input"],
    ["a local-process prompt", { localProcessPrompt: {} }, "another workflow is waiting for input"],
    ["macro playback", { macroPlayback: {} }, "a macro is playing"],
  ])("skips while %s is pending", (_what, busy, reason) => {
    useAppStore.setState({ workflows: [workflow("wf-a")], ...(busy as Partial<AppState>) });
    drop();

    expect(runner.runWorkflowOnTarget).not.toHaveBeenCalled();
    expect(skips()).toEqual([expect.stringContaining(`skipped: ${reason}`)]);
  });

  it("does not launch a workflow with no steps", () => {
    useAppStore.setState({ workflows: [workflow("wf-a", [])] });
    drop();

    expect(runner.runWorkflowOnTarget).not.toHaveBeenCalled();
  });

  it("refuses, with a toast, a required parameter that has no default", () => {
    const info = vi.spyOn(toast, "info");
    useAppStore.setState({
      workflows: [
        workflow("wf-a", [WAIT], [{ name: "host", label: "Host", type: "string", required: true }]),
      ],
    });
    drop();

    expect(runner.runWorkflowOnTarget).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith('Workflow "Workflow wf-a" was not run', {
      description: 'Parameter "Host" needs a default value to run from a trigger',
    });
  });

  it("runs with the parameters' defaults", () => {
    useAppStore.setState({
      workflows: [
        workflow("wf-a", [WAIT], [{ name: "host", type: "string", required: true, default: "db" }]),
      ],
    });
    drop();

    expect(runner.runWorkflowOnTarget.mock.calls[0][0]).toMatchObject({
      paramValues: { host: "db" },
    });
  });

  it("logs a failed run and releases its claim", async () => {
    const run = deferredRun();
    useAppStore.setState({ workflows: [workflow("wf-a")] });
    drop();
    run.reject(new Error("injector gone"));

    await vi.waitFor(() =>
      expect(logs.map((l) => l.message)).toContainEqual(
        expect.stringContaining('on-disconnect run of "Workflow wf-a" failed: Error: injector gone')
      )
    );
    // The claim was released: the next end of the session runs again.
    await settle();
    resetOnDisconnectDispatchState();
    drop();
    expect(runner.runWorkflowOnTarget).toHaveBeenCalledTimes(2);
  });

  it("logs, and does not throw, when a trigger hook fails", () => {
    const broken: WorkflowTriggerStore = {
      get: () => {
        throw new Error("store gone");
      },
      set: () => {},
    };

    expect(() => notifyWorkflowSessionExited(broken, "tab-1", "dropped")).not.toThrow();
    expect(() => notifyWorkflowTabClosing(broken, "tab-1")).not.toThrow();
    const failures = logs.map((l) => l.message).filter((m) => m.includes("trigger hook failed"));
    expect(failures).toEqual([
      expect.stringContaining("session-exit trigger hook failed: Error: store gone"),
      expect.stringContaining("tab-close trigger hook failed: Error: store gone"),
    ]);
  });
});
