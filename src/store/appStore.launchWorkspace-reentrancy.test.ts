/**
 * Regression test for GAP G6 from the workspace save/restore audit (#1146).
 *
 * `launchWorkspace` had no in-flight guard. Because it awaits several
 * multi-second phases (credential unlock, agent connects), a second
 * double-click / Play press issued before the first launch resolved started
 * a second concurrent launch — two overlapping `set(...)` calls that tore over
 * each other and multiplied orphaned sessions.
 *
 * This test pins that a second `launchWorkspace` for the same (or any) id,
 * issued before the first call resolves, is a no-op (only ONE launch runs).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

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

vi.mock("@/services/workspaceApi", () => ({
  getWorkspaces: vi.fn(() => Promise.resolve([])),
  loadWorkspace: vi.fn(),
  saveWorkspace: vi.fn(() => Promise.resolve()),
  deleteWorkspace: vi.fn(() => Promise.resolve()),
  duplicateWorkspace: vi.fn(() => Promise.resolve("")),
}));

import { useAppStore } from "./appStore";
import { loadWorkspace as apiLoadWorkspace } from "@/services/workspaceApi";
import type { WorkspaceDefinition } from "@/types/workspace";

function makeDefinition(id: string): WorkspaceDefinition {
  return {
    id,
    name: `Workspace ${id}`,
    tabGroups: [
      {
        name: "Group 1",
        layout: { type: "leaf", tabs: [{ inlineConfig: { type: "shell", config: {} } }] },
      },
    ],
  };
}

/** A promise that never resolves on its own — keeps the load "in flight". */
function makeDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("appStore — launchWorkspace re-entrancy guard (GAP G6, #1146)", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("ignores a second launchWorkspace while the first is still in flight", async () => {
    const deferred = makeDeferred<WorkspaceDefinition>();
    vi.mocked(apiLoadWorkspace).mockReturnValueOnce(deferred.promise);

    // First launch — kicks off the load (still pending).
    const first = useAppStore.getState().launchWorkspace("ws-1");
    // Second launch before the first resolves — must be a no-op.
    await useAppStore.getState().launchWorkspace("ws-1");

    expect(apiLoadWorkspace).toHaveBeenCalledTimes(1);

    // Let the first launch finish so the in-flight guard clears.
    deferred.resolve(makeDefinition("ws-1"));
    await first;

    // A later launch (after the first resolved) is allowed again.
    vi.mocked(apiLoadWorkspace).mockResolvedValueOnce(makeDefinition("ws-1"));
    await useAppStore.getState().launchWorkspace("ws-1");
    expect(apiLoadWorkspace).toHaveBeenCalledTimes(2);
  });

  it("ignores a launch of a different workspace while one is already in flight", async () => {
    const deferred = makeDeferred<WorkspaceDefinition>();
    vi.mocked(apiLoadWorkspace).mockReturnValueOnce(deferred.promise);

    const first = useAppStore.getState().launchWorkspace("ws-1");
    // A different id, but a launch is already in flight — must still be ignored.
    await useAppStore.getState().launchWorkspace("ws-2");

    expect(apiLoadWorkspace).toHaveBeenCalledTimes(1);

    deferred.resolve(makeDefinition("ws-1"));
    await first;
  });

  it("exposes the launching workspace id while a launch is in flight and clears it after", async () => {
    const deferred = makeDeferred<WorkspaceDefinition>();
    vi.mocked(apiLoadWorkspace).mockReturnValueOnce(deferred.promise);

    expect(useAppStore.getState().launchingWorkspaceId).toBeNull();

    const first = useAppStore.getState().launchWorkspace("ws-1");
    expect(useAppStore.getState().launchingWorkspaceId).toBe("ws-1");

    deferred.resolve(makeDefinition("ws-1"));
    await first;
    expect(useAppStore.getState().launchingWorkspaceId).toBeNull();
  });

  it("clears the launching id even when the launch throws", async () => {
    vi.mocked(apiLoadWorkspace).mockRejectedValueOnce(new Error("boom"));

    await useAppStore.getState().launchWorkspace("ws-1");
    expect(useAppStore.getState().launchingWorkspaceId).toBeNull();

    // A subsequent launch is not blocked by the failed one.
    vi.mocked(apiLoadWorkspace).mockResolvedValueOnce(makeDefinition("ws-1"));
    await useAppStore.getState().launchWorkspace("ws-1");
    expect(apiLoadWorkspace).toHaveBeenCalledTimes(2);
  });
});
