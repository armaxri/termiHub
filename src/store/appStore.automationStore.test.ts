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
import { toast } from "@/components/ui";
import { getAutomation, saveAutomation } from "@/services/automationApi";
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

  describe("runAutomation (slice 6)", () => {
    const playMacro = vi.fn(() => Promise.resolve(null));
    const runWorkflow = vi.fn(() => Promise.resolve());

    beforeEach(() => {
      playMacro.mockClear();
      runWorkflow.mockClear();
      useAppStore.setState({
        ...automationLibraryState([typed("m1", "instant"), workflow]),
        playMacro,
        runWorkflow,
      });
    });

    it("plays what only types keystrokes, and runs everything else", async () => {
      await useAppStore.getState().runAutomation("m1");
      expect(playMacro).toHaveBeenCalledWith("m1", {});
      await useAppStore.getState().runAutomation("w1");
      expect(runWorkflow).toHaveBeenCalledWith("w1", {});
    });

    it("hands on the picked terminals and the parallel choice", async () => {
      const run = useAppStore.getState().runAutomation;
      await run("m1", { targetTabIds: ["a", "b"], parallel: false });
      expect(playMacro).toHaveBeenLastCalledWith("m1", {
        targetTabIds: ["a", "b"],
        parallel: false,
      });
      await run("w1", { targetTabIds: ["a"] });
      expect(runWorkflow).toHaveBeenLastCalledWith("w1", { targetTabId: "a" });
      await run("w1", { targetTabIds: ["a", "b"] });
      expect(runWorkflow).toHaveBeenLastCalledWith("w1", { targetTabIds: ["a", "b"] });
      await run("w1", { targetTabIds: ["a", "b"], parallel: false });
      expect(runWorkflow).toHaveBeenLastCalledWith("w1", {
        targetTabIds: ["a", "b"],
        concurrency: 1,
      });
    });

    it("says what started it, for the history (slice 11)", async () => {
      const run = useAppStore.getState().runAutomation;
      await run("m1", { origin: "palette" });
      expect(playMacro).toHaveBeenLastCalledWith("m1", { origin: "palette" });
      await run("w1", { origin: "palette" });
      expect(runWorkflow).toHaveBeenLastCalledWith("w1", { triggeredBy: "palette" });
      await run("w1", { origin: "hotkey" });
      expect(runWorkflow).toHaveBeenLastCalledWith("w1", { triggeredBy: "hotkey" });
    });

    it.each(["m1", "w1"])("never falls back to the active terminal for %s", async (id) => {
      // The broadcast group's last terminal can drop between the pick and the run.
      const error = vi.spyOn(toast, "error");
      await useAppStore.getState().runAutomation(id, { targetTabIds: [] });
      expect(error).toHaveBeenCalledWith("None of the selected terminals are connected");
      expect(playMacro).not.toHaveBeenCalled();
      expect(runWorkflow).not.toHaveBeenCalled();
    });

    it("says so when the automation is gone", async () => {
      const error = vi.spyOn(toast, "error");
      await useAppStore.getState().runAutomation("gone");
      expect(error).toHaveBeenCalledWith("Automation not found");
      expect(playMacro).not.toHaveBeenCalled();
      expect(runWorkflow).not.toHaveBeenCalled();
    });
  });

  it("duplicates under a fresh id, keeping everything but the provenance (slice 6)", async () => {
    const original: Automation = {
      ...typed("m1", "fixed"),
      triggers: [{ kind: "on-connect", connectionIds: ["c1"] }],
      triggersEnabled: false,
      legacy: { from: "macro", version: 1 },
    };
    useAppStore.setState(automationLibraryState([original]));
    vi.mocked(saveAutomation).mockClear();
    await useAppStore.getState().duplicateAutomation("m1");
    const saved = vi.mocked(saveAutomation).mock.calls[0][0];
    const { id, name, createdAt, updatedAt, ...kept } = saved;
    expect(id).not.toBe("m1");
    expect([name, createdAt, updatedAt]).toEqual(["Copy of Typed m1", "", ""]);
    expect(kept).toEqual({
      tags: original.tags,
      steps: original.steps,
      triggers: original.triggers,
      triggersEnabled: false,
    });
    // A copy, not a share: editing one never edits the other.
    expect(saved.steps).not.toBe(original.steps);
  });

  it("plays a macro with its saved typing speed", async () => {
    useAppStore.setState(automationLibraryState([typed("m-instant", "instant")]));
    vi.useFakeTimers();

    // Instant: the 4 s recorded gap is not waited.
    const status = await useAppStore.getState().playMacro("m-instant");

    expect(status).toBe("completed");
    expect(typedInput).toEqual(["echo 1", "\r"]);
  });

  it.each(["palette", "scheduled", "manual"] as const)(
    "uses the saved typing speed whatever starts it: %s (#5820)",
    async (origin) => {
      useAppStore.setState(automationLibraryState([typed("m-instant", "instant")]));
      vi.useFakeTimers();

      const status = await useAppStore.getState().playMacro("m-instant", { origin });

      expect(status).toBe("completed");
      expect(typedInput).toEqual(["echo 1", "\r"]);
    }
  );

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
