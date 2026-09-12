import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * UX-027 — `saveCurrentAsWorkspace` id handling.
 *
 * Saving the current layout must mint a fresh workspace id by default, but when
 * the caller supplies an `overwriteId` (the user chose to overwrite an existing
 * same-named workspace) it must reuse that exact id so the backend upsert is a
 * genuine update rather than a second, indistinguishable workspace.
 */

vi.mock("@/components/ui", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    loading: vi.fn(() => "toast-id"),
    info: vi.fn(),
    dismiss: vi.fn(),
  },
}));

vi.mock("@/services/storage", () => ({
  loadConnections: vi.fn(() =>
    Promise.resolve({ connections: [], folders: [], agents: [], externalErrors: [] })
  ),
  getSettings: vi.fn(() =>
    Promise.resolve({
      version: "1",
      externalConnectionFiles: [],
      powerMonitoringEnabled: true,
      fileBrowserEnabled: true,
    })
  ),
  saveSettings: vi.fn(() => Promise.resolve()),
  reloadExternalConnections: vi.fn(() => Promise.resolve([])),
  getRecoveryWarnings: vi.fn(() => Promise.resolve([])),
}));

interface SavedDefinition {
  id: string;
  name: string;
  description?: string;
}
const apiSaveWorkspace = vi.fn((_definition: SavedDefinition) => Promise.resolve());
vi.mock("@/services/workspaceApi", () => ({
  getWorkspaces: vi.fn(() => Promise.resolve([])),
  loadWorkspace: vi.fn(() => Promise.resolve({})),
  saveWorkspace: (definition: SavedDefinition) => apiSaveWorkspace(definition),
  deleteWorkspace: vi.fn(() => Promise.resolve()),
  duplicateWorkspace: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/services/lastSessionApi", () => ({
  saveLastSession: vi.fn(() => Promise.resolve()),
  loadLastSession: vi.fn(() => Promise.resolve(null)),
  clearLastSession: vi.fn(() => Promise.resolve()),
}));

import { useAppStore } from "./appStore";
import { setupConnectionsRegion } from "@/test/connectionsHarness";

setupConnectionsRegion();

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState());
  vi.clearAllMocks();
});

/** Extract the single definition passed to the mocked `saveWorkspace`. */
function savedDefinition(): SavedDefinition {
  expect(apiSaveWorkspace).toHaveBeenCalledTimes(1);
  return apiSaveWorkspace.mock.calls[0][0];
}

describe("saveCurrentAsWorkspace — id handling (UX-027)", () => {
  it("mints a fresh ws-prefixed id when no overwriteId is given", async () => {
    await useAppStore.getState().saveCurrentAsWorkspace("Fresh", "all", undefined);

    const def = savedDefinition();
    expect(def.id).toMatch(/^ws-/);
    expect(def.name).toBe("Fresh");
  });

  it("reuses the supplied overwriteId so the backend upsert is a true update", async () => {
    await useAppStore
      .getState()
      .saveCurrentAsWorkspace("Existing", "all", "updated desc", "ws-existing");

    const def = savedDefinition();
    expect(def.id).toBe("ws-existing");
    expect(def.name).toBe("Existing");
    expect(def.description).toBe("updated desc");
  });

  it("records the saved name as the active workspace", async () => {
    await useAppStore.getState().saveCurrentAsWorkspace("Active One", "all", undefined, "ws-1");

    expect(useAppStore.getState().activeWorkspaceName).toBe("Active One");
  });
});
