/**
 * Tests for the macro run history (#3543): every started playback — single or
 * multi-target — is recorded fire-and-forget as a metadata-only record (never
 * the macro's input), with its origin, outcome, timing and targets; a playback
 * that never started records nothing; and the history can be loaded / cleared.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { LeafPanel, TerminalTab } from "@/types/terminal";
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

const recorded: AutomationRun[] = [];
vi.mock("@/services/automationApi", () => ({
  listAutomations: vi.fn(() => Promise.resolve([])),
  saveAutomation: vi.fn((a: unknown) => Promise.resolve(a)),
  deleteAutomation: vi.fn(() => Promise.resolve()),
  listAutomationRuns: vi.fn(() => Promise.resolve([...recorded])),
  recordAutomationRun: vi.fn((run: AutomationRun) => {
    recorded.unshift(run);
    return Promise.resolve([...recorded]);
  }),
  clearAutomationRunHistory: vi.fn((ids?: string[]) => {
    const keep = recorded.filter((r) => ids !== undefined && !ids.includes(r.id));
    recorded.length = 0;
    recorded.push(...keep);
    return Promise.resolve([...recorded]);
  }),
}));

import { useAppStore } from "./appStore";
import { seedLayoutState } from "@/test/layoutState";
import { registerTerminalInputInjector } from "@/services/macroPlayback";
import {
  recordAutomationRun as apiRecordMacroRun,
  listAutomationRuns as apiListMacroRuns,
  clearAutomationRunHistory as apiClearMacroRunHistory,
} from "@/services/automationApi";
import type { AutomationRun } from "@/types/generated/AutomationRun";
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
async function lastRecorded(): Promise<AutomationRun> {
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

    await useAppStore.getState().playMacro("m1");

    const run = await lastRecorded();
    expect(run).toMatchObject({
      automationId: "m1",
      automationName: "Macro m1",
      status: "completed",
      origin: "manual",
      stepsCompleted: 1,
      total: 1,
      targetCount: 1,
      targetLabels: ["title-a"],
    });
    expect(run.error).toBeUndefined();
    expect(Date.parse(run.endedAt)).toBeGreaterThanOrEqual(Date.parse(run.startedAt));
    expect(JSON.stringify(run)).not.toContain(SECRET);
    // The store's list is refreshed from the backend's response.
    await vi.waitFor(() => expect(useAppStore.getState().automationRuns).toHaveLength(1));
  });

  it("records the caller's origin and hands it the record", async () => {
    useAppStore.setState({ macros: [macro("m1", [{ data: "x", delayMs: 0 }])] });

    const onRecorded = vi.fn();
    await useAppStore.getState().playMacro("m1", { origin: "palette", onRecorded });

    expect(onRecorded).toHaveBeenCalledTimes(1);
    const { id } = onRecorded.mock.calls[0][0];
    expect(await lastRecorded()).toMatchObject({ id, origin: "palette" });
  });

  it("records a playback that lost its terminal as an error", async () => {
    registerTerminalInputInjector(async () => false);
    useAppStore.setState({ macros: [macro("m1", [{ data: "x", delayMs: 0 }])] });

    await useAppStore.getState().playMacro("m1");

    const run = await lastRecorded();
    expect(run.status).toBe("failed");
    expect(run.stepsCompleted).toBe(0);
    expect(run.error).toMatch(/stopped accepting input/);
  });

  it("records a multi-target playback once per terminal (#5818)", async () => {
    useAppStore.setState({ macros: [macro("m1", [{ data: "x", delayMs: 0 }])] });

    const handed: string[] = [];
    await useAppStore.getState().playMacro("m1", {
      targetTabIds: ["a", "b", "c"],
      origin: "scheduled",
      onRecorded: (run) => handed.push(run.id),
    });

    // c is not connected, so it never became a target.
    await vi.waitFor(() => expect(recorded).toHaveLength(2));
    const byLabel = Object.fromEntries(recorded.map((r) => [r.targetLabel, r]));
    expect(Object.keys(byLabel).sort()).toEqual(["title-a", "title-b"]);
    for (const run of recorded) {
      expect(run).toMatchObject({
        automationId: "m1",
        status: "completed",
        targetCount: 1,
        stepsCompleted: 1,
        total: 1,
        origin: "scheduled",
      });
    }
    // The caller gets every terminal's record.
    expect(handed.sort()).toEqual(recorded.map((r) => r.id).sort());
  });

  it("records each terminal's own outcome when one drops out (#5818)", async () => {
    registerTerminalInputInjector(async (tabId) => tabId !== "b");
    useAppStore.setState({ macros: [macro("m1", [{ data: "x", delayMs: 0 }])] });

    await useAppStore.getState().playMacro("m1", { targetTabIds: ["a", "b"] });

    await vi.waitFor(() => expect(recorded).toHaveLength(2));
    const byLabel = Object.fromEntries(recorded.map((r) => [r.targetLabel, r]));
    expect(byLabel["title-a"]).toMatchObject({ status: "completed", stepsCompleted: 1 });
    expect(byLabel["title-a"].error).toBeUndefined();
    expect(byLabel["title-b"]).toMatchObject({
      status: "failed",
      stepsCompleted: 0,
      error: "The terminal stopped accepting input",
    });
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

    const status = await useAppStore.getState().playMacro("m1");

    expect(status).toBe("completed");
  });

  it("labels an untitled target 'Terminal' (#2979)", async () => {
    const untitled = { ...term("a", "sess-a"), title: "" };
    seedLayoutState({
      rootPanel: { type: "leaf", id: "leaf-1", tabs: [untitled], activeTabId: "a" },
      activePanelId: "leaf-1",
    });
    useAppStore.setState({ macros: [macro("m1", [{ data: "x", delayMs: 0 }])] });

    await useAppStore.getState().playMacro("m1");

    expect((await lastRecorded()).targetLabels).toEqual(["Terminal"]);
  });

  it("stores an empty history when the backend replies with a non-array (#2979)", async () => {
    useAppStore.setState({ automationRuns: [{ id: "stale" }] as never });
    vi.mocked(apiListMacroRuns).mockResolvedValueOnce(null as never);
    await useAppStore.getState().loadAutomationRuns();
    expect(useAppStore.getState().automationRuns).toEqual([]);

    useAppStore.setState({ automationRuns: [{ id: "stale" }] as never });
    vi.mocked(apiClearMacroRunHistory).mockResolvedValueOnce(undefined as never);
    await useAppStore.getState().clearAutomationRuns();
    expect(useAppStore.getState().automationRuns).toEqual([]);
  });

  it("loads and clears the history", async () => {
    useAppStore.setState({ macros: [macro("m1", [{ data: "x", delayMs: 0 }])] });
    await useAppStore.getState().playMacro("m1");
    await lastRecorded();

    useAppStore.setState({ automationRuns: [] });
    await useAppStore.getState().loadAutomationRuns();
    expect(useAppStore.getState().automationRuns).toHaveLength(1);

    await useAppStore.getState().clearAutomationRuns();
    expect(useAppStore.getState().automationRuns).toEqual([]);
  });
});
