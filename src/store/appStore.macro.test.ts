/**
 * Tests for the macro Zustand slice (#1673).
 *
 * Pins that the store's macro actions round-trip through the automation store
 * (#5818, slice 4: the macro view is a thin adapter over automationApi):
 * loadMacros populates state, and deleteMacroFromBackend only mutates state after the
 * backend delete resolves (and rethrows on failure without desyncing).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mock the service modules the store imports at module load. The store pulls in
// the full graph, so stub the ones with side effects on import.
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

vi.mock("@/services/automationApi", () => ({
  listAutomations: vi.fn(() => Promise.resolve([])),
  saveAutomation: vi.fn(),
  deleteAutomation: vi.fn(() => Promise.resolve()),
}));

import { useAppStore } from "./appStore";
import {
  listAutomations as apiListMacros,
  deleteAutomation as apiDeleteMacro,
} from "@/services/automationApi";
import type { Macro } from "@/types/macro";
import { automationLibraryState } from "./slices/automationStoreState";
import { macroToAutomation } from "./slices/automationViews";

/** The stored automation a macro view comes from. */
const asAutomation = (macro: Macro) => macroToAutomation(macro);
/** Seed the store with these macros (as automations). */
const seed = (...macros: Macro[]) =>
  useAppStore.setState(automationLibraryState(macros.map(asAutomation)));

function makeMacro(id: string, name: string): Macro {
  return {
    id,
    name,
    description: undefined,
    tags: [],
    steps: [{ data: "echo hi\r", delayMs: 0 }],
    createdAt: "2026-07-19T00:00:00Z",
    updatedAt: "2026-07-19T00:00:00Z",
  };
}

describe("appStore — macro slice (#1673)", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("loadMacros populates state from the api", async () => {
    vi.mocked(apiListMacros).mockResolvedValueOnce([asAutomation(makeMacro("m-1", "First"))]);

    await useAppStore.getState().loadMacros();

    expect(apiListMacros).toHaveBeenCalled();
    expect(useAppStore.getState().macros).toHaveLength(1);
    expect(useAppStore.getState().macros[0].name).toBe("First");
  });

  it("loadMacros swallows an Error rejection and leaves state untouched (#2979)", async () => {
    seed(makeMacro("m-keep", "Keep"));
    vi.mocked(apiListMacros).mockRejectedValueOnce(new Error("backend down"));

    // A read-only refresh logs rather than throwing, so it must resolve...
    await expect(useAppStore.getState().loadMacros()).resolves.toBeUndefined();
    // ...and must not clobber the existing library on failure.
    expect(useAppStore.getState().macros).toHaveLength(1);
    expect(useAppStore.getState().macros[0].id).toBe("m-keep");
  });

  it("loadMacros tolerates a non-Error rejection via the String(err) guard (#2979)", async () => {
    vi.mocked(apiListMacros).mockRejectedValueOnce("kaboom");
    await expect(useAppStore.getState().loadMacros()).resolves.toBeUndefined();
    expect(useAppStore.getState().macros).toEqual([]);
  });

  it("deleteMacroFromBackend removes the macro after the backend delete resolves", async () => {
    seed(makeMacro("m-1", "First"), makeMacro("m-2", "Second"));

    await useAppStore.getState().deleteMacroFromBackend("m-1");

    expect(apiDeleteMacro).toHaveBeenCalledWith("m-1");
    const remaining = useAppStore.getState().macros;
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe("m-2");
  });

  it("deleteMacroFromBackend keeps the macro and rethrows when the backend fails", async () => {
    seed(makeMacro("m-1", "First"));
    vi.mocked(apiDeleteMacro).mockRejectedValueOnce(new Error("boom"));

    await expect(useAppStore.getState().deleteMacroFromBackend("m-1")).rejects.toThrow("boom");

    // On failure the row must NOT be optimistically removed (no desync).
    expect(useAppStore.getState().macros).toHaveLength(1);
  });
});
