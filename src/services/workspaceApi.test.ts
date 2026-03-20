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
    const ws = { id: "ws-1", name: "Test", layout: { type: "leaf", tabs: [] } };
    mockedInvoke.mockResolvedValue(ws);
    const result = await loadWorkspace("ws-1");
    expect(mockedInvoke).toHaveBeenCalledWith("load_workspace", { workspaceId: "ws-1" });
    expect(result).toEqual(ws);
  });

  it("saveWorkspace invokes correct command", async () => {
    const definition = { id: "ws-1", name: "Test", layout: { type: "leaf" as const, tabs: [] } };
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
});
