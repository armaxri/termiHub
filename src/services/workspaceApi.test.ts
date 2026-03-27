import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import {
  getWorkspaces,
  loadWorkspace,
  saveWorkspace,
  deleteWorkspace,
  duplicateWorkspace,
  getCliWorkspace,
  exportWorkspaces,
  importWorkspaces,
  previewImportWorkspaces,
} from "./workspaceApi";

const mockedInvoke = vi.mocked(invoke);

describe("workspaceApi", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("getWorkspaces invokes correct command", async () => {
    mockedInvoke.mockResolvedValue([]);
    const result = await getWorkspaces();
    expect(mockedInvoke).toHaveBeenCalledWith("get_workspaces");
    expect(result).toEqual([]);
  });

  it("loadWorkspace invokes correct command with id", async () => {
    const ws = {
      id: "ws-1",
      name: "Test",
      tabGroups: [{ name: "Main", layout: { type: "leaf", tabs: [] } }],
    };
    mockedInvoke.mockResolvedValue(ws);
    const result = await loadWorkspace("ws-1");
    expect(mockedInvoke).toHaveBeenCalledWith("load_workspace", { workspaceId: "ws-1" });
    expect(result).toEqual(ws);
  });

  it("saveWorkspace invokes correct command", async () => {
    const definition = {
      id: "ws-1",
      name: "Test",
      tabGroups: [{ name: "Main", layout: { type: "leaf" as const, tabs: [] } }],
    };
    mockedInvoke.mockResolvedValue(undefined);
    await saveWorkspace(definition);
    expect(mockedInvoke).toHaveBeenCalledWith("save_workspace", { definition });
  });

  it("deleteWorkspace invokes correct command", async () => {
    mockedInvoke.mockResolvedValue(undefined);
    await deleteWorkspace("ws-1");
    expect(mockedInvoke).toHaveBeenCalledWith("delete_workspace", { workspaceId: "ws-1" });
  });

  it("duplicateWorkspace invokes correct command", async () => {
    mockedInvoke.mockResolvedValue("ws-2");
    const result = await duplicateWorkspace("ws-1");
    expect(mockedInvoke).toHaveBeenCalledWith("duplicate_workspace", { workspaceId: "ws-1" });
    expect(result).toBe("ws-2");
  });

  it("getCliWorkspace invokes correct command", async () => {
    mockedInvoke.mockResolvedValue("my-workspace");
    const result = await getCliWorkspace();
    expect(mockedInvoke).toHaveBeenCalledWith("get_cli_workspace");
    expect(result).toBe("my-workspace");
  });

  it("getCliWorkspace returns null when no CLI arg", async () => {
    mockedInvoke.mockResolvedValue(null);
    const result = await getCliWorkspace();
    expect(result).toBeNull();
  });

  it("exportWorkspaces invokes correct command", async () => {
    mockedInvoke.mockResolvedValue('{"version":"1","workspaces":[]}');
    const result = await exportWorkspaces();
    expect(mockedInvoke).toHaveBeenCalledWith("export_workspaces");
    expect(result).toContain("version");
  });

  it("importWorkspaces invokes correct command with json", async () => {
    mockedInvoke.mockResolvedValue(2);
    const json = '{"version":"1","workspaces":[]}';
    const result = await importWorkspaces(json);
    expect(mockedInvoke).toHaveBeenCalledWith("import_workspaces", { json });
    expect(result).toBe(2);
  });

  it("previewImportWorkspaces invokes correct command", async () => {
    const preview = { workspaceCount: 3, totalTabCount: 7 };
    mockedInvoke.mockResolvedValue(preview);
    const json = '{"version":"1","workspaces":[]}';
    const result = await previewImportWorkspaces(json);
    expect(mockedInvoke).toHaveBeenCalledWith("preview_import_workspaces", { json });
    expect(result).toEqual(preview);
  });
});
