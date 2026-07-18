/**
 * Tests for the macro Zustand slice (#1673).
 *
 * Pins that the store's macro actions round-trip through the macroApi service:
 * loadMacros populates state, saveMacroToBackend refreshes the list and returns
 * the stored macro, and deleteMacroFromBackend only mutates state after the
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

vi.mock("@/services/macroApi", () => ({
  listMacros: vi.fn(() => Promise.resolve([])),
  getMacro: vi.fn(),
  saveMacro: vi.fn(),
  deleteMacro: vi.fn(() => Promise.resolve()),
}));

import { useAppStore } from "./appStore";
import {
  listMacros as apiListMacros,
  saveMacro as apiSaveMacro,
  deleteMacro as apiDeleteMacro,
} from "@/services/macroApi";
import type { Macro } from "@/types/macro";

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
    vi.mocked(apiListMacros).mockResolvedValueOnce([makeMacro("m-1", "First")]);

    await useAppStore.getState().loadMacros();

    expect(apiListMacros).toHaveBeenCalled();
    expect(useAppStore.getState().macros).toHaveLength(1);
    expect(useAppStore.getState().macros[0].name).toBe("First");
  });

  it("saveMacroToBackend saves, refreshes the list, and returns the stored macro", async () => {
    const stored = makeMacro("m-1", "Saved");
    vi.mocked(apiSaveMacro).mockResolvedValueOnce(stored);
    vi.mocked(apiListMacros).mockResolvedValueOnce([stored]);

    const result = await useAppStore.getState().saveMacroToBackend(makeMacro("m-1", "Saved"));

    expect(apiSaveMacro).toHaveBeenCalled();
    expect(apiListMacros).toHaveBeenCalled();
    expect(result).toEqual(stored);
    expect(useAppStore.getState().macros).toHaveLength(1);
  });

  it("deleteMacroFromBackend removes the macro after the backend delete resolves", async () => {
    useAppStore.setState({ macros: [makeMacro("m-1", "First"), makeMacro("m-2", "Second")] });

    await useAppStore.getState().deleteMacroFromBackend("m-1");

    expect(apiDeleteMacro).toHaveBeenCalledWith("m-1");
    const remaining = useAppStore.getState().macros;
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe("m-2");
  });

  it("deleteMacroFromBackend keeps the macro and rethrows when the backend fails", async () => {
    useAppStore.setState({ macros: [makeMacro("m-1", "First")] });
    vi.mocked(apiDeleteMacro).mockRejectedValueOnce(new Error("boom"));

    await expect(useAppStore.getState().deleteMacroFromBackend("m-1")).rejects.toThrow("boom");

    // On failure the row must NOT be optimistically removed (no desync).
    expect(useAppStore.getState().macros).toHaveLength(1);
  });
});
