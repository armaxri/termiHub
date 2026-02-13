import { describe, it, expect, vi, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

const mockedInvoke = vi.mocked(invoke);

// Import after mock setup
import {
  createTerminal,
  sendInput,
  resizeTerminal,
  closeTerminal,
  listSerialPorts,
  listAvailableShells,
  checkX11Available,
  loadConnectionsAndFolders,
  saveConnection,
  deleteConnectionFromBackend,
  saveFolder,
  deleteFolderFromBackend,
  exportConnections,
  importConnections,
  getSettings,
  saveSettings,
  saveExternalFile,
  reloadExternalConnections,
  sftpOpen,
  sftpClose,
  sftpListDir,
  sftpDownload,
  sftpUpload,
  sftpMkdir,
  sftpDelete,
  sftpRename,
  localListDir,
  localMkdir,
  localDelete,
  localRename,
  localReadFile,
  localWriteFile,
  sftpReadFileContent,
  sftpWriteFileContent,
  vscodeAvailable,
  vscodeOpenLocal,
  vscodeOpenRemote,
} from "./api";

describe("api service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("terminal commands", () => {
    it("createTerminal invokes with correct command and config", async () => {
      mockedInvoke.mockResolvedValue("session-123");
      const config = { type: "local" as const, config: { shellType: "bash" as const } };

      const result = await createTerminal(config);

      expect(mockedInvoke).toHaveBeenCalledWith("create_terminal", { config });
      expect(result).toBe("session-123");
    });

    it("sendInput invokes with session ID and data", async () => {
      mockedInvoke.mockResolvedValue(undefined);

      await sendInput("session-1", "ls -la\n");

      expect(mockedInvoke).toHaveBeenCalledWith("send_input", {
        sessionId: "session-1",
        data: "ls -la\n",
      });
    });

    it("resizeTerminal invokes with session ID, cols, and rows", async () => {
      mockedInvoke.mockResolvedValue(undefined);

      await resizeTerminal("session-1", 120, 40);

      expect(mockedInvoke).toHaveBeenCalledWith("resize_terminal", {
        sessionId: "session-1",
        cols: 120,
        rows: 40,
      });
    });

    it("closeTerminal invokes with session ID", async () => {
      mockedInvoke.mockResolvedValue(undefined);

      await closeTerminal("session-1");

      expect(mockedInvoke).toHaveBeenCalledWith("close_terminal", {
        sessionId: "session-1",
      });
    });

    it("listSerialPorts returns port names", async () => {
      mockedInvoke.mockResolvedValue(["/dev/ttyUSB0", "/dev/ttyACM0"]);

      const result = await listSerialPorts();

      expect(mockedInvoke).toHaveBeenCalledWith("list_serial_ports");
      expect(result).toEqual(["/dev/ttyUSB0", "/dev/ttyACM0"]);
    });

    it("listAvailableShells returns shell types", async () => {
      mockedInvoke.mockResolvedValue(["zsh", "bash"]);

      const result = await listAvailableShells();

      expect(mockedInvoke).toHaveBeenCalledWith("list_available_shells");
      expect(result).toEqual(["zsh", "bash"]);
    });

    it("checkX11Available returns boolean", async () => {
      mockedInvoke.mockResolvedValue(true);

      const result = await checkX11Available();

      expect(mockedInvoke).toHaveBeenCalledWith("check_x11_available");
      expect(result).toBe(true);
    });
  });

  describe("connection persistence commands", () => {
    it("loadConnectionsAndFolders returns connection data", async () => {
      const data = { connections: [], folders: [], externalSources: [] };
      mockedInvoke.mockResolvedValue(data);

      const result = await loadConnectionsAndFolders();

      expect(mockedInvoke).toHaveBeenCalledWith("load_connections_and_folders");
      expect(result).toEqual(data);
    });

    it("saveConnection invokes with connection object", async () => {
      mockedInvoke.mockResolvedValue(undefined);
      const connection = {
        id: "conn-1",
        name: "Test",
        config: { type: "local" as const, config: { shellType: "bash" as const } },
        folderId: null,
      };

      await saveConnection(connection);

      expect(mockedInvoke).toHaveBeenCalledWith("save_connection", { connection });
    });

    it("deleteConnectionFromBackend invokes with ID", async () => {
      mockedInvoke.mockResolvedValue(undefined);

      await deleteConnectionFromBackend("conn-1");

      expect(mockedInvoke).toHaveBeenCalledWith("delete_connection", { id: "conn-1" });
    });

    it("saveFolder invokes with folder object", async () => {
      mockedInvoke.mockResolvedValue(undefined);
      const folder = { id: "folder-1", name: "Test", parentId: null, isExpanded: true };

      await saveFolder(folder);

      expect(mockedInvoke).toHaveBeenCalledWith("save_folder", { folder });
    });

    it("deleteFolderFromBackend invokes with ID", async () => {
      mockedInvoke.mockResolvedValue(undefined);

      await deleteFolderFromBackend("folder-1");

      expect(mockedInvoke).toHaveBeenCalledWith("delete_folder", { id: "folder-1" });
    });

    it("exportConnections returns JSON string", async () => {
      mockedInvoke.mockResolvedValue('{"connections":[]}');

      const result = await exportConnections();

      expect(mockedInvoke).toHaveBeenCalledWith("export_connections");
      expect(result).toBe('{"connections":[]}');
    });

    it("importConnections returns count", async () => {
      mockedInvoke.mockResolvedValue(5);

      const result = await importConnections('{"connections":[]}');

      expect(mockedInvoke).toHaveBeenCalledWith("import_connections", {
        json: '{"connections":[]}',
      });
      expect(result).toBe(5);
    });
  });

  describe("settings commands", () => {
    it("getSettings returns settings object", async () => {
      const settings = { version: "1", externalConnectionFiles: [] };
      mockedInvoke.mockResolvedValue(settings);

      const result = await getSettings();

      expect(mockedInvoke).toHaveBeenCalledWith("get_settings");
      expect(result).toEqual(settings);
    });

    it("saveSettings invokes with settings object", async () => {
      mockedInvoke.mockResolvedValue(undefined);
      const settings = { version: "1", externalConnectionFiles: [] };

      await saveSettings(settings);

      expect(mockedInvoke).toHaveBeenCalledWith("save_settings", { settings });
    });

    it("saveExternalFile invokes with all parameters", async () => {
      mockedInvoke.mockResolvedValue(undefined);

      await saveExternalFile("/path/to/file.json", "Test File", [], []);

      expect(mockedInvoke).toHaveBeenCalledWith("save_external_file", {
        filePath: "/path/to/file.json",
        name: "Test File",
        folders: [],
        connections: [],
      });
    });

    it("reloadExternalConnections returns sources", async () => {
      const sources = [{ filePath: "/test", name: "Test", folders: [], connections: [], error: null }];
      mockedInvoke.mockResolvedValue(sources);

      const result = await reloadExternalConnections();

      expect(mockedInvoke).toHaveBeenCalledWith("reload_external_connections");
      expect(result).toEqual(sources);
    });
  });

  describe("SFTP commands", () => {
    it("sftpOpen invokes with SSH config", async () => {
      mockedInvoke.mockResolvedValue("sftp-session-1");
      const config = { host: "pi.local", port: 22, username: "pi", authMethod: "password" as const };

      const result = await sftpOpen(config);

      expect(mockedInvoke).toHaveBeenCalledWith("sftp_open", { config });
      expect(result).toBe("sftp-session-1");
    });

    it("sftpClose invokes with session ID", async () => {
      mockedInvoke.mockResolvedValue(undefined);

      await sftpClose("sftp-session-1");

      expect(mockedInvoke).toHaveBeenCalledWith("sftp_close", { sessionId: "sftp-session-1" });
    });

    it("sftpListDir invokes with session ID and path", async () => {
      const entries = [{ name: "file.txt", path: "/home/file.txt", isDirectory: false, size: 100, modified: "2024-01-01", permissions: "rw-r--r--" }];
      mockedInvoke.mockResolvedValue(entries);

      const result = await sftpListDir("sftp-1", "/home");

      expect(mockedInvoke).toHaveBeenCalledWith("sftp_list_dir", { sessionId: "sftp-1", path: "/home" });
      expect(result).toEqual(entries);
    });

    it("sftpDownload invokes with correct params and returns bytes", async () => {
      mockedInvoke.mockResolvedValue(1024);

      const result = await sftpDownload("sftp-1", "/remote/file.txt", "/local/file.txt");

      expect(mockedInvoke).toHaveBeenCalledWith("sftp_download", {
        sessionId: "sftp-1",
        remotePath: "/remote/file.txt",
        localPath: "/local/file.txt",
      });
      expect(result).toBe(1024);
    });

    it("sftpUpload invokes with correct params and returns bytes", async () => {
      mockedInvoke.mockResolvedValue(2048);

      const result = await sftpUpload("sftp-1", "/local/file.txt", "/remote/file.txt");

      expect(mockedInvoke).toHaveBeenCalledWith("sftp_upload", {
        sessionId: "sftp-1",
        localPath: "/local/file.txt",
        remotePath: "/remote/file.txt",
      });
      expect(result).toBe(2048);
    });

    it("sftpMkdir invokes with session ID and path", async () => {
      mockedInvoke.mockResolvedValue(undefined);

      await sftpMkdir("sftp-1", "/remote/newdir");

      expect(mockedInvoke).toHaveBeenCalledWith("sftp_mkdir", {
        sessionId: "sftp-1",
        path: "/remote/newdir",
      });
    });

    it("sftpDelete invokes with session ID, path, and isDirectory flag", async () => {
      mockedInvoke.mockResolvedValue(undefined);

      await sftpDelete("sftp-1", "/remote/file.txt", false);

      expect(mockedInvoke).toHaveBeenCalledWith("sftp_delete", {
        sessionId: "sftp-1",
        path: "/remote/file.txt",
        isDirectory: false,
      });
    });

    it("sftpRename invokes with session ID, old and new paths", async () => {
      mockedInvoke.mockResolvedValue(undefined);

      await sftpRename("sftp-1", "/remote/old.txt", "/remote/new.txt");

      expect(mockedInvoke).toHaveBeenCalledWith("sftp_rename", {
        sessionId: "sftp-1",
        oldPath: "/remote/old.txt",
        newPath: "/remote/new.txt",
      });
    });

    it("sftpReadFileContent invokes with session ID and remote path", async () => {
      mockedInvoke.mockResolvedValue("file contents here");

      const result = await sftpReadFileContent("sftp-1", "/remote/file.txt");

      expect(mockedInvoke).toHaveBeenCalledWith("sftp_read_file_content", {
        sessionId: "sftp-1",
        remotePath: "/remote/file.txt",
      });
      expect(result).toBe("file contents here");
    });

    it("sftpWriteFileContent invokes with session ID, path, and content", async () => {
      mockedInvoke.mockResolvedValue(undefined);

      await sftpWriteFileContent("sftp-1", "/remote/file.txt", "new content");

      expect(mockedInvoke).toHaveBeenCalledWith("sftp_write_file_content", {
        sessionId: "sftp-1",
        remotePath: "/remote/file.txt",
        content: "new content",
      });
    });
  });

  describe("local filesystem commands", () => {
    it("localListDir invokes with path", async () => {
      const entries = [{ name: "file.txt", path: "/home/file.txt", isDirectory: false, size: 50, modified: "2024-01-01", permissions: null }];
      mockedInvoke.mockResolvedValue(entries);

      const result = await localListDir("/home");

      expect(mockedInvoke).toHaveBeenCalledWith("local_list_dir", { path: "/home" });
      expect(result).toEqual(entries);
    });

    it("localMkdir invokes with path", async () => {
      mockedInvoke.mockResolvedValue(undefined);

      await localMkdir("/home/newdir");

      expect(mockedInvoke).toHaveBeenCalledWith("local_mkdir", { path: "/home/newdir" });
    });

    it("localDelete invokes with path and isDirectory flag", async () => {
      mockedInvoke.mockResolvedValue(undefined);

      await localDelete("/home/file.txt", false);

      expect(mockedInvoke).toHaveBeenCalledWith("local_delete", {
        path: "/home/file.txt",
        isDirectory: false,
      });
    });

    it("localRename invokes with old and new paths", async () => {
      mockedInvoke.mockResolvedValue(undefined);

      await localRename("/home/old.txt", "/home/new.txt");

      expect(mockedInvoke).toHaveBeenCalledWith("local_rename", {
        oldPath: "/home/old.txt",
        newPath: "/home/new.txt",
      });
    });

    it("localReadFile invokes with path and returns content", async () => {
      mockedInvoke.mockResolvedValue("file content");

      const result = await localReadFile("/home/file.txt");

      expect(mockedInvoke).toHaveBeenCalledWith("local_read_file", { path: "/home/file.txt" });
      expect(result).toBe("file content");
    });

    it("localWriteFile invokes with path and content", async () => {
      mockedInvoke.mockResolvedValue(undefined);

      await localWriteFile("/home/file.txt", "new content");

      expect(mockedInvoke).toHaveBeenCalledWith("local_write_file", {
        path: "/home/file.txt",
        content: "new content",
      });
    });
  });

  describe("VS Code integration", () => {
    it("vscodeAvailable returns boolean", async () => {
      mockedInvoke.mockResolvedValue(false);

      const result = await vscodeAvailable();

      expect(mockedInvoke).toHaveBeenCalledWith("vscode_available");
      expect(result).toBe(false);
    });

    it("vscodeOpenLocal invokes with path", async () => {
      mockedInvoke.mockResolvedValue(undefined);

      await vscodeOpenLocal("/home/file.txt");

      expect(mockedInvoke).toHaveBeenCalledWith("vscode_open_local", { path: "/home/file.txt" });
    });

    it("vscodeOpenRemote invokes with session ID and remote path", async () => {
      mockedInvoke.mockResolvedValue(undefined);

      await vscodeOpenRemote("sftp-1", "/remote/file.txt");

      expect(mockedInvoke).toHaveBeenCalledWith("vscode_open_remote", {
        sessionId: "sftp-1",
        remotePath: "/remote/file.txt",
      });
    });
  });
});
