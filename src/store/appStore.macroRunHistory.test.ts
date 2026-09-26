/**
 * Tests for the macro run history (#3543): every started playback — single or
 * multi-target — is recorded fire-and-forget as a metadata-only record (never
 * the macro's input), with its origin, outcome, timing and targets; a playback
 * that never started records nothing; and the history can be loaded / cleared.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { LeafPanel, TerminalTab } from "@/types/terminal";
import type { Macro, MacroRun } from "@/types/macro";

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

const recorded: MacroRun[] = [];
vi.mock("@/services/macroApi", () => ({
  listMacros: vi.fn(() => Promise.resolve([])),
  getMacro: vi.fn(),
  saveMacro: vi.fn((m: Macro) => Promise.resolve(m)),
  deleteMacro: vi.fn(() => Promise.resolve()),
  listMacroRuns: vi.fn(() => Promise.resolve([...recorded])),
  recordMacroRun: vi.fn((run: MacroRun) => {
    recorded.unshift(run);
    return Promise.resolve([...recorded]);
  }),
  clearMacroRunHistory: vi.fn(() => {
    recorded.length = 0;
    return Promise.resolve([]);
  }),
}));

import { useAppStore } from "./appStore";
import { seedLayoutState } from "@/test/layoutState";
import { registerTerminalInputInjector } from "@/services/macroPlayback";
import { recordMacroRun as apiRecordMacroRun } from "@/services/macroApi";
import { installSessionLifecycleHarness } from "@/test/sessionLifecycleRegionTestHarness";

const SECRET = "hunter2-secret-input";

const macro = (id: string, steps: Macro["steps"]): Macro => ({
  id,
  name: `Macro ${id}`,
  tags: [],
  steps,
  createdAt: "",
  updatedAt: "",
});

function term(id: string, sessionId: string | null): TerminalTab {
  return {
    id,
    sessionId,
    title: `title-${id}`,
    connectionType: "ssh",
    contentType: "terminal",
    config: { type: "ssh", config: {} },
    panelId: "leaf-1",
    isActive: id === "a",
  };
}

/** One panel with terminals a, b (connected) and c (no session). */
function seedFleet() {
  const tabs = [term("a", "sess-a"), term("b", "sess-b"), term("c", null)];
  const leaf: LeafPanel = { type: "leaf", id: "leaf-1", tabs, activeTabId: "a" };
  seedLayoutState({ rootPanel: leaf, activePanelId: "leaf-1" });
}

/** Wait until the fire-and-forget record lands, then return it. */
async function lastRecorded(): Promise<MacroRun> {
  await vi.waitFor(() => expect(recorded.length).toBeGreaterThan(0));
  return recorded[0];
}

describe("appStore — macro run history (#3543)", () => {
  installSessionLifecycleHarness();

  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    recorded.length = 0;
    vi.mocked(apiRecordMacroRun).mockClear();
    registerTerminalInputInjector(async () => true);
    seedFleet();
  });

  afterEach(() => {
    registerTerminalInputInjector(null);
    vi.restoreAllMocks();
  });

  it("records a completed manual playback as metadata only", async () => {
    useAppStore.setState({ macros: [macro("m1", [{ data: `${SECRET}\r`, delayMs: 0 }])] });

    await useAppStore.getState().playMacro("m1", { timingMode: "instant" });

    const run = await lastRecorded();
    expect(run).toMatchObject({
      macroId: "m1",
      macroName: "Macro m1",
      status: "completed",
      origin: "manual",
      stepsPlayed: 1,
      totalSteps: 1,
      targetCount: 1,
      targetLabels: ["title-a"],
    });
    expect(run.error).toBeUndefined();
    expect(Date.parse(run.endedAt)).toBeGreaterThanOrEqual(Date.parse(run.startedAt));
    expect(JSON.stringify(run)).not.toContain(SECRET);
    // The store's list is refreshed from the backend's response.
    await vi.waitFor(() => expect(useAppStore.getState().macroRuns).toHaveLength(1));
  });

  it("records the caller's origin and pre-generated run id", async () => {
    useAppStore.setState({ macros: [macro("m1", [{ data: "x", delayMs: 0 }])] });

    await useAppStore
      .getState()
      .playMacro("m1", { timingMode: "instant", origin: "palette", runId: "mrun-fixed" });

    expect(await lastRecorded()).toMatchObject({ id: "mrun-fixed", origin: "palette" });
  });

  it("records a playback that lost its terminal as an error", async () => {
    registerTerminalInputInjector(async () => false);
    useAppStore.setState({ macros: [macro("m1", [{ data: "x", delayMs: 0 }])] });

    await useAppStore.getState().playMacro("m1", { timingMode: "instant" });

    const run = await lastRecorded();
    expect(run.status).toBe("error");
    expect(run.stepsPlayed).toBe(0);
    expect(run.error).toMatch(/stopped accepting input/);
  });

  it("records a multi-target playback with every target label", async () => {
    useAppStore.setState({ macros: [macro("m1", [{ data: "x", delayMs: 0 }])] });

    await useAppStore
      .getState()
      .playMacro("m1", { timingMode: "instant", targetTabIds: ["a", "b", "c"] });

    // c is not connected, so it never became a target.
    expect(await lastRecorded()).toMatchObject({
      status: "completed",
      targetCount: 2,
      targetLabels: ["title-a", "title-b"],
      origin: "manual",
    });
  });

  it("notes a multi-target playback whose terminals dropped out", async () => {
    registerTerminalInputInjector(async (tabId) => tabId !== "b");
    useAppStore.setState({ macros: [macro("m1", [{ data: "x", delayMs: 0 }])] });

    await useAppStore
      .getState()
      .playMacro("m1", { timingMode: "instant", targetTabIds: ["a", "b"] });

    expect((await lastRecorded()).error).toBe("1 of 2 terminals stopped receiving input");
  });

  it("records nothing for a playback that never started", async () => {
    useAppStore.setState({ macros: [macro("m1", [{ data: "x", delayMs: 0 }]), macro("e", [])] });

    await useAppStore.getState().playMacro("missing");
    await useAppStore.getState().playMacro("e");
    await useAppStore.getState().playMacro("m1", { targetTabId: "c" });
    await new Promise((r) => setTimeout(r, 10));

    expect(apiRecordMacroRun).not.toHaveBeenCalled();
  });

  it("never fails the playback when recording fails", async () => {
    vi.mocked(apiRecordMacroRun).mockRejectedValueOnce(new Error("disk full"));
    useAppStore.setState({ macros: [macro("m1", [{ data: "x", delayMs: 0 }])] });

    const status = await useAppStore.getState().playMacro("m1", { timingMode: "instant" });

    expect(status).toBe("completed");
  });

  it("loads and clears the history", async () => {
    useAppStore.setState({ macros: [macro("m1", [{ data: "x", delayMs: 0 }])] });
    await useAppStore.getState().playMacro("m1", { timingMode: "instant" });
    await lastRecorded();

    useAppStore.setState({ macroRuns: [] });
    await useAppStore.getState().loadMacroRuns();
    expect(useAppStore.getState().macroRuns).toHaveLength(1);

    await useAppStore.getState().clearMacroRunHistory();
    expect(useAppStore.getState().macroRuns).toEqual([]);
  });
});
