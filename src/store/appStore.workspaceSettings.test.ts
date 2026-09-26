/**
 * PROD-052: launching a workspace makes it the backend's active workspace (so
 * its default directory / env reach its new local shells and every window
 * applies its theme / font overrides), and re-capturing the layout over an
 * existing workspace keeps its settings overrides.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

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
  setActiveWorkspace: vi.fn(() => Promise.resolve()),
  getActiveWorkspace: vi.fn(() => Promise.resolve(null)),
}));

vi.mock("@/components/ui", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    loading: vi.fn(),
    promise: vi.fn(),
    dismiss: vi.fn(),
  },
}));

import { useAppStore } from "./appStore";
import {
  loadWorkspace as apiLoadWorkspace,
  saveWorkspace as apiSaveWorkspace,
  setActiveWorkspace as apiSetActiveWorkspace,
} from "@/services/workspaceApi";
import type { WorkspaceDefinition } from "@/types/workspace";

const mockLoad = vi.mocked(apiLoadWorkspace);

describe("appStore — per-workspace settings (PROD-052)", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    vi.clearAllMocks();
  });

  it("activates the launched workspace so its overrides apply to its new sessions", async () => {
    const definition: WorkspaceDefinition = {
      id: "ws-prod",
      name: "Prod",
      tabGroups: [
        {
          name: "Group 1",
          layout: { type: "leaf", tabs: [{ inlineConfig: { type: "local", config: {} } }] },
        },
      ],
      settings: { defaultWorkingDirectory: "/srv" },
    };
    mockLoad.mockResolvedValueOnce(definition);

    await useAppStore.getState().launchWorkspace("ws-prod");

    expect(apiSetActiveWorkspace).toHaveBeenCalledWith("ws-prod");
  });

  it("keeps the workspace's settings when re-saving the current layout over it", async () => {
    mockLoad.mockResolvedValueOnce({
      id: "ws-prod",
      name: "Prod",
      tabGroups: [],
      settings: { theme: "light" },
    });

    await useAppStore.getState().saveCurrentAsWorkspace("Prod", "all", undefined, "ws-prod");

    expect(apiSaveWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ id: "ws-prod", settings: { theme: "light" } })
    );
    expect(apiSetActiveWorkspace).toHaveBeenCalledWith("ws-prod");
  });

  it("saves a brand-new workspace without settings", async () => {
    await useAppStore.getState().saveCurrentAsWorkspace("Fresh", "all");

    const saved = vi.mocked(apiSaveWorkspace).mock.calls[0][0];
    expect(saved.settings).toBeUndefined();
    expect(mockLoad).not.toHaveBeenCalled();
  });
});
