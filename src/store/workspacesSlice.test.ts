/**
 * Unit coverage for the workspaces store slice (TFE-006).
 *
 * The cleanly-separable CRUD surface of the workspaces slice (load / save /
 * delete / duplicate) was almost entirely untested (branch coverage ~37%): the
 * layout-entangled `launchWorkspace` / `saveCurrentAsWorkspace` actions live in
 * `appStore` and have their own tests, but the plain backend-list actions did
 * not. These tests drive each directly against `useAppStore` with the workspace
 * IPC wrappers mocked, pinning both the success mutation and the error branch
 * (rethrow + no local mutation for save/delete, swallow+toast for load/duplicate).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import type { WorkspaceDefinition, WorkspaceSummary } from "@/types/workspace";

const { toastSuccess, toastError } = vi.hoisted(() => ({
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/components/ui", () => ({
  toast: {
    success: toastSuccess,
    error: toastError,
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

vi.mock("@/themes", () => ({
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(() => vi.fn()),
}));

vi.mock("@/services/workspaceApi", () => ({
  getWorkspaces: vi.fn(() => Promise.resolve([])),
  loadWorkspace: vi.fn(() => Promise.resolve({})),
  saveWorkspace: vi.fn(() => Promise.resolve()),
  deleteWorkspace: vi.fn(() => Promise.resolve()),
  duplicateWorkspace: vi.fn(() => Promise.resolve("ws-copy")),
}));

import { useAppStore } from "./appStore";
import {
  getWorkspaces as apiGetWorkspaces,
  saveWorkspace as apiSaveWorkspace,
  deleteWorkspace as apiDeleteWorkspace,
  duplicateWorkspace as apiDuplicateWorkspace,
} from "@/services/workspaceApi";

function summary(id: string, name: string): WorkspaceSummary {
  return { id, name, connectionCount: 0 };
}

function definition(id: string, name: string): WorkspaceDefinition {
  return {
    id,
    name,
    tabGroups: [{ name: "Main", layout: { type: "leaf", tabs: [] } }],
  };
}

describe("workspaces slice (TFE-006)", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("loadWorkspaces", () => {
    it("populates the summaries list from the backend", async () => {
      vi.mocked(apiGetWorkspaces).mockResolvedValueOnce([
        summary("ws-1", "A"),
        summary("ws-2", "B"),
      ]);

      await useAppStore.getState().loadWorkspaces();

      expect(useAppStore.getState().workspaces.map((w) => w.id)).toEqual(["ws-1", "ws-2"]);
    });

    it("swallows a backend failure and leaves state untouched (read-only load)", async () => {
      useAppStore.setState({ workspaces: [summary("keep", "K")] });
      vi.mocked(apiGetWorkspaces).mockRejectedValueOnce(new Error("boom"));

      await expect(useAppStore.getState().loadWorkspaces()).resolves.toBeUndefined();

      expect(useAppStore.getState().workspaces.map((w) => w.id)).toEqual(["keep"]);
    });
  });

  describe("saveWorkspaceToBackend", () => {
    it("persists then refreshes the summaries list", async () => {
      vi.mocked(apiGetWorkspaces).mockResolvedValueOnce([summary("ws-1", "Saved")]);

      await useAppStore.getState().saveWorkspaceToBackend(definition("ws-1", "Saved"));

      expect(apiSaveWorkspace).toHaveBeenCalledTimes(1);
      expect(apiGetWorkspaces).toHaveBeenCalledTimes(1);
      expect(useAppStore.getState().workspaces.map((w) => w.id)).toEqual(["ws-1"]);
    });

    it("rethrows on failure and does not refresh the list", async () => {
      vi.mocked(apiSaveWorkspace).mockRejectedValueOnce(new Error("save failed"));

      await expect(
        useAppStore.getState().saveWorkspaceToBackend(definition("ws-1", "Saved"))
      ).rejects.toThrow("save failed");

      expect(apiGetWorkspaces).not.toHaveBeenCalled();
    });
  });

  describe("deleteWorkspaceFromBackend", () => {
    it("removes the workspace locally only after the backend delete resolves", async () => {
      useAppStore.setState({ workspaces: [summary("ws-1", "A"), summary("ws-2", "B")] });

      await useAppStore.getState().deleteWorkspaceFromBackend("ws-1");

      expect(apiDeleteWorkspace).toHaveBeenCalledWith("ws-1");
      expect(useAppStore.getState().workspaces.map((w) => w.id)).toEqual(["ws-2"]);
    });

    it("rethrows and keeps the workspace when the backend delete fails (GAP G7)", async () => {
      useAppStore.setState({ workspaces: [summary("ws-1", "A")] });
      vi.mocked(apiDeleteWorkspace).mockRejectedValueOnce(new Error("delete failed"));

      await expect(useAppStore.getState().deleteWorkspaceFromBackend("ws-1")).rejects.toThrow(
        "delete failed"
      );

      // No optimistic removal — the item is still present so the caller can surface the error.
      expect(useAppStore.getState().workspaces.map((w) => w.id)).toEqual(["ws-1"]);
    });
  });

  describe("duplicateWorkspaceInBackend", () => {
    it("duplicates, refreshes, and toasts success", async () => {
      vi.mocked(apiGetWorkspaces).mockResolvedValueOnce([
        summary("ws-1", "A"),
        summary("ws-copy", "A copy"),
      ]);

      await useAppStore.getState().duplicateWorkspaceInBackend("ws-1");

      expect(apiDuplicateWorkspace).toHaveBeenCalledWith("ws-1");
      expect(toastSuccess).toHaveBeenCalledWith("Duplicated workspace");
      expect(useAppStore.getState().workspaces.map((w) => w.id)).toEqual(["ws-1", "ws-copy"]);
    });

    it("toasts an error and does NOT rethrow when the backend duplicate fails", async () => {
      vi.mocked(apiDuplicateWorkspace).mockRejectedValueOnce(new Error("dup failed"));

      // duplicate is a convenience action — it surfaces the failure as a toast and
      // resolves (does not reject), unlike save/delete.
      await expect(
        useAppStore.getState().duplicateWorkspaceInBackend("ws-1")
      ).resolves.toBeUndefined();

      expect(toastError).toHaveBeenCalledWith("Failed to duplicate workspace: dup failed");
      expect(apiGetWorkspaces).not.toHaveBeenCalled();
    });
  });

  // Every action stringifies the rejection via `err instanceof Error ? err.message
  // : String(err)`. The Error side is covered above; these pin the non-Error side
  // (a raw string rejection) so both branches of that guard are exercised.
  describe("non-Error rejections stringify via the String(err) branch", () => {
    it("loadWorkspaces swallows a non-Error rejection", async () => {
      useAppStore.setState({ workspaces: [summary("keep", "K")] });
      vi.mocked(apiGetWorkspaces).mockRejectedValueOnce("raw string failure");

      await expect(useAppStore.getState().loadWorkspaces()).resolves.toBeUndefined();
      expect(useAppStore.getState().workspaces.map((w) => w.id)).toEqual(["keep"]);
    });

    it("saveWorkspaceToBackend rethrows a non-Error rejection", async () => {
      vi.mocked(apiSaveWorkspace).mockRejectedValueOnce("raw string failure");

      await expect(
        useAppStore.getState().saveWorkspaceToBackend(definition("ws-1", "Saved"))
      ).rejects.toBe("raw string failure");
    });

    it("duplicateWorkspaceInBackend toasts a String(err) for a non-Error rejection", async () => {
      vi.mocked(apiDuplicateWorkspace).mockRejectedValueOnce("raw string failure");

      await expect(
        useAppStore.getState().duplicateWorkspaceInBackend("ws-1")
      ).resolves.toBeUndefined();
      expect(toastError).toHaveBeenCalledWith("Failed to duplicate workspace: raw string failure");
    });
  });
});
