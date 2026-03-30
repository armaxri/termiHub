import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the api module that storage delegates to
vi.mock("./api", () => ({
  loadConnectionsAndFolders: vi.fn(),
  saveConnection: vi.fn(),
  deleteConnectionFromBackend: vi.fn(),
  moveConnectionToFile: vi.fn(),
  saveFolder: vi.fn(),
  deleteFolderFromBackend: vi.fn(),
  saveRemoteAgent: vi.fn(),
  deleteRemoteAgentFromBackend: vi.fn(),
  reorderRemoteAgents: vi.fn(),
  exportConnections: vi.fn(),
  importConnections: vi.fn(),
  getSettings: vi.fn(),
  saveSettings: vi.fn(),
  saveExternalFile: vi.fn(),
  reloadExternalConnections: vi.fn(),
  previewImport: vi.fn(),
  exportConnectionsEncrypted: vi.fn(),
  importConnectionsWithCredentials: vi.fn(),
  getRecoveryWarnings: vi.fn(),
}));

import * as api from "./api";
import {
  loadConnections,
  persistConnection,
  removeConnection,
  persistFolder,
  removeFolder,
  persistAgent,
  removeAgent,
  reorderAgents,
} from "./storage";

const mockApi = vi.mocked(api);

describe("storage service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("loadConnections", () => {
    it("delegates to loadConnectionsAndFolders", async () => {
      const data = { connections: [], folders: [], agents: [], externalErrors: [] };
      mockApi.loadConnectionsAndFolders.mockResolvedValue(data);

      const result = await loadConnections();

      expect(mockApi.loadConnectionsAndFolders).toHaveBeenCalledTimes(1);
      expect(result).toEqual(data);
    });
  });

  describe("persistConnection", () => {
    it("delegates to saveConnection with connection object", async () => {
      mockApi.saveConnection.mockResolvedValue(undefined);
      const conn = {
        id: "conn-1",
        name: "Test",
        config: { type: "local" as const, config: { shell: "bash" } },
        folderId: null,
      };

      await persistConnection(conn);

      expect(mockApi.saveConnection).toHaveBeenCalledWith(conn);
    });
  });

  describe("removeConnection", () => {
    it("delegates to deleteConnectionFromBackend with id", async () => {
      mockApi.deleteConnectionFromBackend.mockResolvedValue(undefined);

      await removeConnection("conn-1");

      expect(mockApi.deleteConnectionFromBackend).toHaveBeenCalledWith("conn-1", undefined);
    });

    it("passes optional sourceFile", async () => {
      mockApi.deleteConnectionFromBackend.mockResolvedValue(undefined);

      await removeConnection("conn-1", "/path/to/file.json");

      expect(mockApi.deleteConnectionFromBackend).toHaveBeenCalledWith(
        "conn-1",
        "/path/to/file.json"
      );
    });
  });

  describe("persistFolder", () => {
    it("delegates to saveFolder", async () => {
      mockApi.saveFolder.mockResolvedValue(undefined);
      const folder = { id: "f-1", name: "Servers", parentId: null, isExpanded: true };

      await persistFolder(folder);

      expect(mockApi.saveFolder).toHaveBeenCalledWith(folder);
    });
  });

  describe("removeFolder", () => {
    it("delegates to deleteFolderFromBackend", async () => {
      mockApi.deleteFolderFromBackend.mockResolvedValue(undefined);

      await removeFolder("f-1");

      expect(mockApi.deleteFolderFromBackend).toHaveBeenCalledWith("f-1");
    });
  });

  describe("persistAgent", () => {
    it("delegates to saveRemoteAgent", async () => {
      mockApi.saveRemoteAgent.mockResolvedValue(undefined);
      const agent = {
        id: "agent-1",
        name: "Pi",
        host: "pi.local",
        port: 22,
        username: "pi",
        authMethod: "key" as const,
      };

      await persistAgent(agent as never);

      expect(mockApi.saveRemoteAgent).toHaveBeenCalledWith(agent);
    });
  });

  describe("removeAgent", () => {
    it("delegates to deleteRemoteAgentFromBackend", async () => {
      mockApi.deleteRemoteAgentFromBackend.mockResolvedValue(undefined);

      await removeAgent("agent-1");

      expect(mockApi.deleteRemoteAgentFromBackend).toHaveBeenCalledWith("agent-1");
    });
  });

  describe("reorderAgents", () => {
    it("delegates to apiReorderRemoteAgents with agent IDs", async () => {
      mockApi.reorderRemoteAgents.mockResolvedValue(undefined);

      await reorderAgents(["agent-2", "agent-1", "agent-3"]);

      expect(mockApi.reorderRemoteAgents).toHaveBeenCalledWith(["agent-2", "agent-1", "agent-3"]);
    });
  });
});
