/**
 * Run picker → refusal (#5988): the real sidebar, picker and store. With
 * experimental features off, confirming a run of an automation that can reach a
 * Run local process step refuses it: no run, no badge, no queue, nothing typed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve([])) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(vi.fn()) }));
vi.mock("@/themes", () => ({ applyTheme: vi.fn(), onThemeChange: vi.fn(() => vi.fn()) }));
const spawn = vi.hoisted(() =>
  vi.fn(() => Promise.resolve({ exitCode: 0, timedOut: false, cancelled: false }))
);
vi.mock("@/services/localProcessApi", () => ({
  invokeRunLocalProcess: spawn,
  cancelLocalProcess: vi.fn(() => Promise.resolve(true)),
  subscribeLocalProcessOutput: vi.fn(() => Promise.resolve(() => {})),
}));
vi.mock("@/services/automationApi", () => ({
  listAutomations: vi.fn(() => Promise.resolve([])),
  listAutomationRuns: vi.fn(() => Promise.resolve([])),
  getAutomation: vi.fn(() => Promise.reject(new Error("none"))),
  saveAutomation: vi.fn(),
  deleteAutomation: vi.fn(),
  recordAutomationRun: vi.fn(() => Promise.resolve([])),
  clearAutomationRunHistory: vi.fn(() => Promise.resolve([])),
}));
const started = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock("@/store/workflowRunBridge", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/store/workflowRunBridge")>()),
  ensureWorkflowSubscribed: vi.fn(() => Promise.resolve()),
  dispatchWorkflowRunStarted: started,
  dispatchWorkflowStepAdvanced: vi.fn(() => Promise.resolve()),
  dispatchWorkflowOutputOpened: vi.fn(() => Promise.resolve()),
  dispatchWorkflowRunSettled: vi.fn(() => Promise.resolve()),
  dispatchWorkflowDismissOutput: vi.fn(() => Promise.resolve()),
}));

import { toast } from "@/components/ui";
import { recordAutomationRun } from "@/services/automationApi";
import { registerTerminalInputInjector } from "@/services/macroPlayback";
import { useAppStore } from "@/store/appStore";
import { automationLibraryState } from "@/store/slices/automationStoreState";
import { activeWorkflowRunCount } from "@/store/slices/workflowRunOnTarget";
import { setupConnectionsRegion, seedConnectionsRegion } from "@/test/connectionsHarness";
import { openAutomationRowMenu } from "@/test/automationRowMenu";
import { flushAsync } from "@/test/flushAsync";
import { seedLayoutState } from "@/test/layoutState";
import { seedSettings, setupSettingsRegion } from "@/test/settingsRegionTestHarness";
import { withTooltip } from "@/test/tooltip";
import type { AutomationStep } from "@/types/generated/AutomationStep";
import type { TerminalTab } from "@/types/terminal";
import { LOCAL_PROCESS_REASON } from "@/utils/localProcessGate";
import { resetRememberedRunTargetChoice } from "../Automations/runTargetChoice";
import { AutomationSidebar } from "./AutomationSidebar";

setupSettingsRegion();
setupConnectionsRegion();

const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const click = (id: string) => act(() => q(id)!.click());
const typed: AutomationStep = { kind: "send-command", command: "uptime" };
const lp: AutomationStep = { kind: "run-local-process", program: "make", args: [] };

describe("run picker and the local-process gate (#5988)", () => {
  let root: Root;
  let container: HTMLDivElement;
  let injected: string[];

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(toast, "error");
    vi.spyOn(toast, "loading");
    resetRememberedRunTargetChoice();
    useAppStore.setState(useAppStore.getInitialState());
    seedConnectionsRegion({ connections: [] });
    injected = [];
    registerTerminalInputInjector(async (tabId) => {
      injected.push(tabId);
      return true;
    });
    const tab = (id: string): TerminalTab => ({
      id,
      sessionId: `sess-${id}`,
      title: id,
      connectionType: "local",
      contentType: "terminal",
      config: { type: "local", config: {} },
      panelId: "leaf-1",
      isActive: id === "tab-a",
    });
    seedLayoutState({
      rootPanel: {
        type: "leaf",
        id: "leaf-1",
        tabs: [tab("tab-a"), tab("tab-b")],
        activeTabId: "tab-a",
      },
      activePanelId: "leaf-1",
    });
    const base = { name: "Build", tags: [], triggers: [], createdAt: "", updatedAt: "" };
    useAppStore.setState(
      automationLibraryState([
        { ...base, id: "w1", steps: [typed, { kind: "run-automation", automationId: "w2" }] },
        { ...base, id: "w2", name: "Nested", steps: [lp] },
      ])
    );
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    registerTerminalInputInjector(null);
    vi.restoreAllMocks();
  });

  /** Pick `count` terminals in the real picker and confirm the run. */
  async function runFromPicker(experimental: boolean, count: 1 | 2, parallel = true) {
    seedSettings({
      experimentalFeaturesEnabled: experimental,
      workflowLocalProcessEnabled: true,
      workflowLocalProcessAllowlist: ["make"],
    });
    await act(async () => root.render(withTooltip(<AutomationSidebar />)));
    await flushAsync();
    openAutomationRowMenu("w1");
    click("automation-menu-run-on-w1");
    if (count === 2) {
      click("run-targets-target-pick");
      click("run-targets-terminal-tab-b");
      if (!parallel) {
        click("run-targets-more");
        click("run-targets-parallel");
      }
      click("run-targets-run"); // asks to confirm
    }
    click("run-targets-run");
    await flushAsync();
  }

  it.each([
    ["one terminal", 1, true],
    ["two terminals, parallel", 2, true],
    ["two terminals, one after another", 2, false],
  ] as const)("off: refuses %s before anything starts", async (_name, count, parallel) => {
    await runFromPicker(false, count, parallel);

    expect(toast.error).toHaveBeenCalledWith(
      'Automation "Build" was not run',
      expect.objectContaining({ description: LOCAL_PROCESS_REASON })
    );
    expect(injected).toEqual([]); // nothing typed
    expect(started).not.toHaveBeenCalled(); // no run in the region, so no badge
    expect(activeWorkflowRunCount()).toBe(0); // nothing running or queued
    expect(toast.loading).not.toHaveBeenCalled(); // no fan-out progress
    expect(recordAutomationRun).not.toHaveBeenCalled(); // no history record
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each([
    ["one terminal", 1],
    ["two terminals", 2],
  ] as const)("on: runs on %s as before", async (_name, count) => {
    await runFromPicker(true, count);
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(count));
    expect(injected).toHaveLength(count);
    expect(started).toHaveBeenCalledTimes(count);
  });
});
