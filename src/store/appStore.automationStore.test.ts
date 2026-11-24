/**
 * The single automation store (#5818, slice 4): the library and history are
 * automations, the macro and workflow views are derived from them, and macro
 * playback runs the stored automation through the automation runner.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import type { LeafPanel, TerminalTab } from "@/types/terminal";
import type { Automation } from "@/types/generated/Automation";

vi.mock("@/services/storage", () => ({
  loadConnections: vi.fn(() =>
    Promise.resolve({ connections: [], folders: [], agents: [], externalErrors: [] })
  ),
  getSettings: vi.fn(() => Promise.resolve({ version: "1", externalConnectionFiles: [] })),
  saveSettings: vi.fn(() => Promise.resolve()),
  getRecoveryWarnings: vi.fn(() => Promise.resolve([])),
}));

vi.mock("@/themes", () => ({
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(() => vi.fn()),
}));

const library: Automation[] = [];
vi.mock("@/services/automationApi", () => ({
  listAutomations: vi.fn(() => Promise.resolve([...library])),
  getAutomation: vi.fn((id: string) => {
    const found = library.find((a) => a.id === id);
    return found ? Promise.resolve(found) : Promise.reject(new Error("Automation not found"));
  }),
  saveAutomation: vi.fn((a: Automation) => Promise.resolve(a)),
  deleteAutomation: vi.fn(() => Promise.resolve()),
  listAutomationRuns: vi.fn(() => Promise.resolve([])),
  recordAutomationRun: vi.fn(() => Promise.resolve([])),
  clearAutomationRunHistory: vi.fn(() => Promise.resolve([])),
}));

import { useAppStore } from "./appStore";
import { getAutomation } from "@/services/automationApi";
import { registerTerminalInputInjector } from "@/services/macroPlayback";
import { seedLayoutState } from "@/test/layoutState";
import { installSessionLifecycleHarness } from "@/test/sessionLifecycleRegionTestHarness";
import { automationLibraryState } from "./slices/automationStoreState";

const typed = (id: string, timing: "recorded" | "fixed" | "instant"): Automation => ({
  id,
  name: `Typed ${id}`,
  tags: [],
  steps: [
    {
      kind: "type-keys",
      chunks: [
        { data: "echo 1", delayMs: 0 },
        { data: "\r", delayMs: 4000 },
      ],
      timing,
      recorded: true,
    },
  ],
  triggers: [],
  createdAt: "",
  updatedAt: "",
});

const workflow: Automation = {
  id: "w1",
  name: "Calls typed",
  tags: [],
  steps: [{ kind: "run-automation", automationId: "m-instant" }],
  triggers: [],
  createdAt: "",
  updatedAt: "",
  legacy: { from: "workflow", version: 3 },
};

function seedTerminal(): void {
  const tab: TerminalTab = {
    id: "a",
    sessionId: "sess-a",
    title: "prod",
    connectionType: "ssh",
    contentType: "terminal",
    config: { type: "ssh", config: {} },
    panelId: "leaf-1",
    isActive: true,
  };
  const leaf: LeafPanel = { type: "leaf", id: "leaf-1", tabs: [tab], activeTabId: "a" };
  seedLayoutState({ rootPanel: leaf, activePanelId: "leaf-1" });
}

describe("appStore — single automation store (#5818, slice 4)", () => {
  installSessionLifecycleHarness();
  let typedInput: string[];

  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    library.length = 0;
    typedInput = [];
    registerTerminalInputInjector(async (_tab, data) => {
      typedInput.push(data);
      return true;
    });
    seedTerminal();
  });

  afterEach(() => {
    registerTerminalInputInjector(null);
    vi.useRealTimers();
  });

  it("derives the macro and workflow views from one list", async () => {
    library.push(typed("m-instant", "instant"), workflow);
    await useAppStore.getState().loadAutomations();

    const state = useAppStore.getState();
    expect(state.automations.map((a) => a.id)).toEqual(["m-instant", "w1"]);
    expect(state.macros.map((m) => m.id)).toEqual(["m-instant"]);
    expect(state.workflows.map((w) => w.id)).toEqual(["w1"]);
    expect(state.workflows[0].steps).toEqual([{ kind: "run-macro", macroId: "m-instant" }]);
  });

  it("plays a macro with its saved typing speed", async () => {
    useAppStore.setState(automationLibraryState([typed("m-instant", "instant")]));
    vi.useFakeTimers();

    // Instant: the 4 s recorded gap is not waited.
    const status = await useAppStore.getState().playMacro("m-instant");

    expect(status).toBe("completed");
    expect(typedInput).toEqual(["echo 1", "\r"]);
  });

  it("lets the play dialog override the saved typing speed for one run", async () => {
    useAppStore.setState(automationLibraryState([typed("m-recorded", "recorded")]));

    const started = Date.now();
    const status = await useAppStore
      .getState()
      .playMacro("m-recorded", { timingMode: "fixed", fixedDelayMs: 0 });

    expect(status).toBe("completed");
    // The recorded 4 s gap was not waited.
    expect(Date.now() - started).toBeLessThan(2000);
    expect(typedInput).toEqual(["echo 1", "\r"]);
  });

  it("reports the saved typing speed as the playback's timing mode", async () => {
    useAppStore.setState(automationLibraryState([typed("m-fixed", "fixed")]));
    const playing = useAppStore.getState().playMacro("m-fixed");
    expect(useAppStore.getState().macroPlayback?.timingMode).toBe("fixed");
    useAppStore.getState().cancelMacroPlayback();
    expect(await playing).toBe("cancelled");
  });

  it("runs a workflow's run-automation step through the stored automation", async () => {
    useAppStore.setState(automationLibraryState([typed("m-instant", "instant"), workflow]));

    await useAppStore.getState().runWorkflow("w1");

    expect(typedInput).toEqual(["echo 1", "\r"]);
  });

  it("asks the backend for an automation another window just created", async () => {
    library.push(typed("m-instant", "instant"));

    const status = await useAppStore.getState().playMacro("m-instant");

    expect(getAutomation).toHaveBeenCalledWith("m-instant");
    expect(status).toBe("completed");
    expect(useAppStore.getState().macros.map((m) => m.id)).toEqual(["m-instant"]);
  });

  it("still reports a missing macro when the backend has none either", async () => {
    expect(await useAppStore.getState().playMacro("ghost")).toBeNull();
    expect(getAutomation).toHaveBeenCalledWith("ghost");
  });

  it("saves a workflow view edit back without losing the stored provenance", async () => {
    useAppStore.setState(automationLibraryState([workflow]));
    const view = useAppStore.getState().workflows[0];
    const { saveAutomation } = await import("@/services/automationApi");

    await useAppStore.getState().saveWorkflowToBackend({ ...view, name: "Renamed" });

    expect(saveAutomation).toHaveBeenCalledWith({ ...workflow, name: "Renamed" });
  });
});
