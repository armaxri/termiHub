/**
 * Regression tests for GAP G3 from the workspace save/restore audit (#1146) —
 * the launch side.
 *
 * `launchWorkspace` treated a failed load (catch → console.error) and an
 * empty build (`builtGroups.length === 0` → silent `return`) as no-ops. A user
 * who launches a workspace whose connections were deleted got nothing and no
 * explanation, indistinguishable from "nothing happened". These tests pin that
 * both paths now surface user feedback via the shared toast hub.
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
import { loadWorkspace as apiLoadWorkspace } from "@/services/workspaceApi";
import { toast } from "@/components/ui";
import type { WorkspaceDefinition } from "@/types/workspace";

const mockLoad = vi.mocked(apiLoadWorkspace);
const mockToast = vi.mocked(toast);

describe("appStore — launchWorkspace failure feedback (GAP G3, #1146)", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    vi.clearAllMocks();
  });

  it("surfaces an error toast when the workspace fails to load", async () => {
    mockLoad.mockRejectedValueOnce(new Error("boom"));

    await useAppStore.getState().launchWorkspace("ws-1");

    expect(mockToast.error).toHaveBeenCalledTimes(1);
    expect(mockToast.error.mock.calls[0][0]).toMatch(/launch/i);
  });

  it("surfaces a notice when the workspace has no launchable tabs", async () => {
    // A workspace whose only tab group has no tabs builds zero groups.
    const definition: WorkspaceDefinition = {
      id: "ws-empty",
      name: "Deleted Everything",
      tabGroups: [{ name: "Group 1", layout: { type: "leaf", tabs: [] } }],
    };
    mockLoad.mockResolvedValueOnce(definition);

    await useAppStore.getState().launchWorkspace("ws-empty");

    expect(mockToast.info).toHaveBeenCalledTimes(1);
    // Names the workspace so the user knows which launch produced nothing.
    expect(mockToast.info.mock.calls[0][0]).toMatch(/Deleted Everything/);
    expect(mockToast.error).not.toHaveBeenCalled();
  });

  it("stays silent on a successful launch that opens tabs", async () => {
    const definition: WorkspaceDefinition = {
      id: "ws-ok",
      name: "Good",
      tabGroups: [
        {
          name: "Group 1",
          layout: { type: "leaf", tabs: [{ inlineConfig: { type: "shell", config: {} } }] },
        },
      ],
    };
    mockLoad.mockResolvedValueOnce(definition);

    await useAppStore.getState().launchWorkspace("ws-ok");

    expect(mockToast.error).not.toHaveBeenCalled();
    expect(mockToast.info).not.toHaveBeenCalled();
  });
});
