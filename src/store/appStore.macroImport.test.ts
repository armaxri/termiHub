/**
 * Tests for the macro import store action (#1677).
 *
 * Pins that importMacros parses+validates the file before touching the backend
 * (a malformed file rejects and never calls saveMacro), assigns fresh ids and
 * de-duplicated names on collision, saves each imported macro, and refreshes the
 * list exactly once.
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

vi.mock("@/services/macroApi", () => ({
  listMacros: vi.fn(() => Promise.resolve([])),
  getMacro: vi.fn(),
  saveMacro: vi.fn((macro) => Promise.resolve(macro)),
  deleteMacro: vi.fn(() => Promise.resolve()),
}));

import { useAppStore } from "./appStore";
import {
  listMacros as apiListMacros,
  saveMacro as apiSaveMacro,
} from "@/services/macroApi";
import type { Macro } from "@/types/macro";
import { MACRO_EXPORT_VERSION } from "@/services/macroIo";

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

function envelope(macros: Partial<Macro>[]): string {
  return JSON.stringify({ version: MACRO_EXPORT_VERSION, macros });
}

describe("appStore — importMacros (#1677)", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("imports macros with fresh ids and returns the count", async () => {
    vi.mocked(apiListMacros).mockResolvedValueOnce([]);

    const count = await useAppStore
      .getState()
      .importMacros(envelope([makeMacro("macro-1", "One"), makeMacro("macro-2", "Two")]));

    expect(count).toBe(2);
    expect(apiSaveMacro).toHaveBeenCalledTimes(2);
    // Fresh ids: the saved macros must not reuse the file's ids.
    const savedIds = vi.mocked(apiSaveMacro).mock.calls.map((c) => (c[0] as Macro).id);
    expect(savedIds).not.toContain("macro-1");
    expect(savedIds).not.toContain("macro-2");
    // Refreshed once after all saves.
    expect(apiListMacros).toHaveBeenCalledTimes(1);
  });

  it("de-duplicates a name that collides with an existing macro", async () => {
    useAppStore.setState({ macros: [makeMacro("existing", "Deploy")] });
    vi.mocked(apiListMacros).mockResolvedValueOnce([]);

    await useAppStore.getState().importMacros(envelope([makeMacro("macro-1", "Deploy")]));

    const saved = vi.mocked(apiSaveMacro).mock.calls[0][0] as Macro;
    expect(saved.name).toBe("Deploy (imported)");
  });

  it("rejects a malformed file without touching the backend", async () => {
    useAppStore.setState({ macros: [makeMacro("existing", "Keep")] });

    await expect(useAppStore.getState().importMacros("{not json")).rejects.toThrow(
      /not valid JSON/
    );

    expect(apiSaveMacro).not.toHaveBeenCalled();
    // Library untouched.
    expect(useAppStore.getState().macros).toHaveLength(1);
  });
});
