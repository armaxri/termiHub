import { describe, it, expect, vi, beforeEach } from "vitest";
import { flushMacrotask } from "@/test/flushAsync";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

// `sftpDownload` / `sftpUpload` await the terminal `transfer-progress` event
// after the command returns a transferId (#1245). Capture the registered
// listener so tests can drive the lifecycle deterministically.
let transferListener: ((event: { payload: unknown }) => void) | undefined;
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((_event: string, handler: (event: { payload: unknown }) => void) => {
    transferListener = handler;
    return Promise.resolve(() => {
      transferListener = undefined;
    });
  }),
}));

const mockedInvoke = vi.mocked(invoke);

// Import after mock setup
import {
  createTerminal,
  createConnection,
  cancelConnecting,
  getConnectionTypes,
  sendInput,
  resizeTerminal,
  closeTerminal,
  listSerialPorts,
  listAvailableShells,
  checkX11Available,
  checkSshAgentStatus,
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
  sftpCancelTransfer,
  getHomeDir,
  localListDir,
  localMkdir,
  localDelete,
  localRename,
  localReadFile,
  localWriteFile,
  sessionRealpath,
  sessionCheckWritable,
  sessionWriteFileElevated,
  sessionHasExecCapability,
  sessionDownload,
  sessionUpload,
  sessionVscodeOpenRemote,
  vscodeAvailable,
  vscodeOpenLocal,
  validateSshKey,
  checkDockerAvailable,
  listDockerImages,
  checkPodmanAvailable,
  listPodmanImages,
  detectAgentArch,
  setupRemoteAgent,
  cancelAgentSetup,
  getLogs,
  clearLogs,
  getCredentialStoreStatus,
  unlockCredentialStore,
  lockCredentialStore,
  setupMasterPassword,
  changeMasterPassword,
  switchCredentialStore,
  resolveCredential,
  removeCredential,
} from "./api";

describe("api service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    transferListener = undefined;
  });

  describe("terminal commands", () => {
    it("createConnection invokes with type ID and settings", async () => {
      mockedInvoke.mockResolvedValue("session-456");

      const result = await createConnection("ssh", { host: "pi.local", port: 22 });

      expect(mockedInvoke).toHaveBeenCalledWith("create_connection", {
        typeId: "ssh",
        settings: { host: "pi.local", port: 22 },
        agentId: null,
        connectId: null,
        spawned: false,
        resilientReconnect: false,
        backendReattach: false,
      });
      expect(result).toBe("session-456");
    });

    it("createConnection passes agentId when provided", async () => {
      mockedInvoke.mockResolvedValue("session-789");

      const result = await createConnection("local", { shell: "bash" }, "agent-1");

      expect(mockedInvoke).toHaveBeenCalledWith("create_connection", {
        typeId: "local",
        settings: { shell: "bash" },
        agentId: "agent-1",
        connectId: null,
        spawned: false,
        resilientReconnect: false,
        backendReattach: false,
      });
      expect(result).toBe("session-789");
    });

    it("createConnection forwards connectId for mid-connect cancellation", async () => {
      mockedInvoke.mockResolvedValue("session-c");

      await createConnection("ssh", { host: "h" }, undefined, "tab-7");

      expect(mockedInvoke).toHaveBeenCalledWith("create_connection", {
        typeId: "ssh",
        settings: { host: "h" },
        agentId: null,
        connectId: "tab-7",
        spawned: false,
        resilientReconnect: false,
        backendReattach: false,
      });
    });

    it("createTerminal forwards connectId to create_connection", async () => {
      mockedInvoke.mockResolvedValue("session-c2");
      const config = { type: "ssh", config: { host: "h" } };

      await createTerminal(config, "tab-9");

      expect(mockedInvoke).toHaveBeenCalledWith("create_connection", {
        typeId: "ssh",
        settings: { host: "h" },
        agentId: null,
        connectId: "tab-9",
        spawned: false,
        resilientReconnect: false,
        backendReattach: false,
      });
    });

    it("createTerminal forwards spawned to create_connection (#1466)", async () => {
      mockedInvoke.mockResolvedValue("session-spawn");
      const config = { type: "docker", config: { image: "alpine:3" } };

      await createTerminal(config, "tab-s", true);

      expect(mockedInvoke).toHaveBeenCalledWith("create_connection", {
        typeId: "docker",
        settings: { image: "alpine:3" },
        agentId: null,
        connectId: "tab-s",
        spawned: true,
        resilientReconnect: false,
        backendReattach: false,
      });
    });

    it("createTerminal forwards resilientReconnect to create_connection (#2439)", async () => {
      mockedInvoke.mockResolvedValue("session-r");
      const config = { type: "ssh", config: { host: "h", resilientReconnect: true } };

      await createTerminal(config, "tab-r", false, true);

      expect(mockedInvoke).toHaveBeenCalledWith("create_connection", {
        typeId: "ssh",
        settings: { host: "h", resilientReconnect: true },
        agentId: null,
        connectId: "tab-r",
        spawned: false,
        resilientReconnect: true,
        backendReattach: false,
      });
    });

    it("createTerminal forwards backendReattach to create_connection (#2454)", async () => {
      mockedInvoke.mockResolvedValue("session-br");
      const config = { type: "ssh", config: { host: "h" } };

      await createTerminal(config, "tab-br", false, true, true);

      expect(mockedInvoke).toHaveBeenCalledWith("create_connection", {
        typeId: "ssh",
        settings: { host: "h" },
        agentId: null,
        connectId: "tab-br",
        spawned: false,
        resilientReconnect: true,
        backendReattach: true,
      });
    });

    it("cancelConnecting invokes cancel_connecting with the connectId", async () => {
      mockedInvoke.mockResolvedValue(true);

      const result = await cancelConnecting("tab-7");

      expect(mockedInvoke).toHaveBeenCalledWith("cancel_connecting", { connectId: "tab-7" });
      expect(result).toBe(true);
    });

    it("getConnectionTypes returns available types", async () => {
      const types = [
        { typeId: "local", displayName: "Local Shell", icon: "terminal", settingsSchema: {} },
      ];
      mockedInvoke.mockResolvedValue(types);

      const result = await getConnectionTypes();

      expect(mockedInvoke).toHaveBeenCalledWith("get_connection_types");
      expect(result).toEqual(types);
    });

    it("createTerminal adapter maps local config to create_connection", async () => {
      mockedInvoke.mockResolvedValue("session-123");
      const config = { type: "local", config: { shell: "bash" } };

      const result = await createTerminal(config);

      expect(mockedInvoke).toHaveBeenCalledWith("create_connection", {
        typeId: "local",
        settings: { shell: "bash" },
        agentId: null,
        connectId: null,
        spawned: false,
        resilientReconnect: false,
        backendReattach: false,
      });
      expect(result).toBe("session-123");
    });

    it("createTerminal adapter maps remote-session config to create_connection with agentId", async () => {
      mockedInvoke.mockResolvedValue("session-remote");
      const config = {
        type: "remote-session",
        config: {
          agentId: "agent-1",
          sessionType: "shell",
          shell: "/bin/bash",
          persistent: false,
        },
      };

      const result = await createTerminal(config);

      expect(mockedInvoke).toHaveBeenCalledWith("create_connection", {
        typeId: "shell",
        settings: { shell: "/bin/bash", persistent: false },
        agentId: "agent-1",
        connectId: null,
        spawned: false,
        resilientReconnect: false,
        backendReattach: false,
      });
      expect(result).toBe("session-remote");
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

    it("closeTerminal invokes with session ID (non-kill close by default)", async () => {
      mockedInvoke.mockResolvedValue(undefined);

      await closeTerminal("session-1");

      expect(mockedInvoke).toHaveBeenCalledWith("close_terminal", {
        sessionId: "session-1",
        intentional: false,
      });
    });

    it("closeTerminal forwards the intentional kill-intent flag (#2439)", async () => {
      mockedInvoke.mockResolvedValue(undefined);

      await closeTerminal("session-1", true);

      expect(mockedInvoke).toHaveBeenCalledWith("close_terminal", {
        sessionId: "session-1",
        intentional: true,
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

    it("checkSshAgentStatus returns status string", async () => {
      mockedInvoke.mockResolvedValue("running");

      const result = await checkSshAgentStatus();

      expect(mockedInvoke).toHaveBeenCalledWith("check_ssh_agent_status");
      expect(result).toBe("running");
    });
  });

  describe("connection persistence commands", () => {
    it("loadConnectionsAndFolders returns connection data", async () => {
      const data = { connections: [], folders: [], agents: [], externalErrors: [] };
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
        config: { type: "local", config: { shell: "bash" } },
        folderId: null,
      };

      await saveConnection(connection);

      expect(mockedInvoke).toHaveBeenCalledWith("save_connection", { connection });
    });

    it("deleteConnectionFromBackend invokes with ID", async () => {
      mockedInvoke.mockResolvedValue(undefined);

      await deleteConnectionFromBackend("conn-1");

      expect(mockedInvoke).toHaveBeenCalledWith("delete_connection", {
        id: "conn-1",
        sourceFile: null,
      });
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
      const settings = {
        version: "1",
        externalConnectionFiles: [],
        powerMonitoringEnabled: true,
        fileBrowserEnabled: true,
      };
      mockedInvoke.mockResolvedValue(settings);

      const result = await getSettings();

      expect(mockedInvoke).toHaveBeenCalledWith("get_settings");
      expect(result).toEqual(settings);
    });

    it("saveSettings invokes with settings object", async () => {
      mockedInvoke.mockResolvedValue(undefined);
      const settings = {
        version: "1",
        externalConnectionFiles: [],
        powerMonitoringEnabled: true,
        fileBrowserEnabled: true,
      };

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
      const sources = [
        { filePath: "/test", name: "Test", folders: [], connections: [], error: null },
      ];
      mockedInvoke.mockResolvedValue(sources);

      const result = await reloadExternalConnections();

      expect(mockedInvoke).toHaveBeenCalledWith("reload_external_connections");
      expect(result).toEqual(sources);
    });
  });

  // The standalone UUID `sftp_*` session commands (open/close/list/stat/…/
  // download/upload/…) were retired in #2314; SSH file browsing/editing/transfer
  // now goes through the `session_*` path (see "session-scoped SFTP advanced
  // commands" below). Only the shared, protocol-agnostic transfer cancellation
  // remains under the `sftp` name.
  describe("SFTP transfer cancellation", () => {
    it("sftpCancelTransfer invokes with the transfer id", async () => {
      mockedInvoke.mockResolvedValue(undefined);

      await sftpCancelTransfer("transfer-9");

      expect(mockedInvoke).toHaveBeenCalledWith("sftp_cancel_transfer", {
        transferId: "transfer-9",
      });
    });
  });

  // Session-path mirrors of the SFTP advanced ops (#2312/#2383), the frontend
  // half of the #2307 convergence (#2313). Each must invoke its `session_*`
  // command with the same camelCase arg shape as its `sftp_*` twin so an SSH
  // session id can drive the file browser / editor without a separate
  // `SftpManager` session.
  describe("session-scoped SFTP advanced commands", () => {
    // Wait until `awaitTransfer` has registered its `transfer-progress`
    // listener (it does so after a dynamic import), then emit `payload`.
    const fireWhenListening = async (payload: unknown) => {
      for (let i = 0; i < 50 && !transferListener; i++) {
        await flushMacrotask();
      }
      if (!transferListener) throw new Error("transfer listener never registered");
      transferListener({ payload });
    };

    it("sessionRealpath invokes with session ID and path", async () => {
      mockedInvoke.mockResolvedValue("/home/pi");

      const result = await sessionRealpath("ssh-1", ".");

      expect(mockedInvoke).toHaveBeenCalledWith("session_realpath", {
        sessionId: "ssh-1",
        path: ".",
      });
      expect(result).toBe("/home/pi");
    });

    it("sessionCheckWritable invokes with session ID and remote path", async () => {
      mockedInvoke.mockResolvedValue("writable");

      const result = await sessionCheckWritable("ssh-1", "/etc/hosts");

      expect(mockedInvoke).toHaveBeenCalledWith("session_check_writable", {
        sessionId: "ssh-1",
        remotePath: "/etc/hosts",
      });
      expect(result).toBe("writable");
    });

    it("sessionWriteFileElevated invokes with session ID, path, content and sudo password", async () => {
      mockedInvoke.mockResolvedValue({ kind: "success" });

      const result = await sessionWriteFileElevated("ssh-1", "/etc/hosts", "127.0.0.1 x", "pw");

      expect(mockedInvoke).toHaveBeenCalledWith("session_write_file_elevated", {
        sessionId: "ssh-1",
        remotePath: "/etc/hosts",
        content: "127.0.0.1 x",
        sudoPassword: "pw",
      });
      expect(result).toEqual({ kind: "success" });
    });

    it("sessionHasExecCapability invokes with session ID", async () => {
      mockedInvoke.mockResolvedValue(true);

      const result = await sessionHasExecCapability("ssh-1");

      expect(mockedInvoke).toHaveBeenCalledWith("session_has_exec_capability", {
        sessionId: "ssh-1",
      });
      expect(result).toBe(true);
    });

    it("sessionDownload invokes with correct params and returns bytes on the done event", async () => {
      mockedInvoke.mockResolvedValue("transfer-s1");

      const pending = sessionDownload("ssh-1", "/remote/file.txt", "/local/file.txt");
      await fireWhenListening({
        transferId: "transfer-s1",
        phase: "done",
        transferred: 4096,
      });

      const result = await pending;
      expect(mockedInvoke).toHaveBeenCalledWith("session_download", {
        sessionId: "ssh-1",
        remotePath: "/remote/file.txt",
        localPath: "/local/file.txt",
      });
      expect(result).toBe(4096);
    });

    it("sessionDownload fires onRegistered with the transfer id before completion", async () => {
      mockedInvoke.mockResolvedValue("transfer-seed-s");
      const onRegistered = vi.fn();

      const pending = sessionDownload("ssh-1", "/remote/file.txt", "/local/file.txt", onRegistered);
      // onRegistered fires from the command's synchronous return, ahead of the event.
      await flushMacrotask();
      expect(onRegistered).toHaveBeenCalledWith("transfer-seed-s");

      await fireWhenListening({ transferId: "transfer-seed-s", phase: "done", transferred: 1 });
      await pending;
    });

    it("sessionUpload invokes with correct params and returns bytes on the done event", async () => {
      mockedInvoke.mockResolvedValue("transfer-s2");

      const pending = sessionUpload("ssh-1", "/local/file.txt", "/remote/file.txt");
      await fireWhenListening({
        transferId: "transfer-s2",
        phase: "done",
        transferred: 8192,
      });

      const result = await pending;
      expect(mockedInvoke).toHaveBeenCalledWith("session_upload", {
        sessionId: "ssh-1",
        localPath: "/local/file.txt",
        remotePath: "/remote/file.txt",
      });
      expect(result).toBe(8192);
    });

    it("sessionDownload rejects when the transfer errors", async () => {
      mockedInvoke.mockResolvedValue("transfer-s3");

      const pending = sessionDownload("ssh-1", "/remote/file.txt", "/local/file.txt");
      await fireWhenListening({
        transferId: "transfer-s3",
        phase: "error",
        message: "boom",
      });

      await expect(pending).rejects.toThrow("boom");
    });

    it("sessionVscodeOpenRemote invokes with session ID and remote path", async () => {
      mockedInvoke.mockResolvedValue(undefined);

      await sessionVscodeOpenRemote("ssh-1", "/remote/file.txt");

      expect(mockedInvoke).toHaveBeenCalledWith("session_vscode_open_remote", {
        sessionId: "ssh-1",
        remotePath: "/remote/file.txt",
      });
    });
  });

  describe("local filesystem commands", () => {
    it("getHomeDir returns home directory path", async () => {
      mockedInvoke.mockResolvedValue("/Users/testuser");

      const result = await getHomeDir();

      expect(mockedInvoke).toHaveBeenCalledWith("get_home_dir");
      expect(result).toBe("/Users/testuser");
    });

    it("localListDir invokes with path", async () => {
      const entries = [
        {
          name: "file.txt",
          path: "/home/file.txt",
          isDirectory: false,
          size: 50,
          modified: "2024-01-01",
          permissions: null,
        },
      ];
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
  });

  describe("SSH key validation", () => {
    it("validateSshKey invokes with path and returns validation result", async () => {
      const validation = {
        status: "valid",
        message: "OpenSSH private key detected.",
        keyType: "OpenSSH",
      };
      mockedInvoke.mockResolvedValue(validation);

      const result = await validateSshKey("/home/user/.ssh/id_ed25519");

      expect(mockedInvoke).toHaveBeenCalledWith("validate_ssh_key", {
        path: "/home/user/.ssh/id_ed25519",
      });
      expect(result).toEqual(validation);
    });

    it("validateSshKey returns warning for public key", async () => {
      const validation = {
        status: "warning",
        message: "This looks like a public key (.pub).",
        keyType: "",
      };
      mockedInvoke.mockResolvedValue(validation);

      const result = await validateSshKey("/home/user/.ssh/id_ed25519.pub");

      expect(result.status).toBe("warning");
    });

    it("validateSshKey returns error for missing file", async () => {
      const validation = {
        status: "error",
        message: "File not found.",
        keyType: "",
      };
      mockedInvoke.mockResolvedValue(validation);

      const result = await validateSshKey("/nonexistent/key");

      expect(result.status).toBe("error");
    });
  });

  describe("docker commands", () => {
    it("checkDockerAvailable invokes correct command", async () => {
      mockedInvoke.mockResolvedValue(true);

      const result = await checkDockerAvailable();

      expect(mockedInvoke).toHaveBeenCalledWith("check_docker_available");
      expect(result).toBe(true);
    });

    it("checkDockerAvailable returns false when unavailable", async () => {
      mockedInvoke.mockResolvedValue(false);

      const result = await checkDockerAvailable();

      expect(result).toBe(false);
    });

    it("listDockerImages invokes correct command", async () => {
      const images = ["ubuntu:22.04", "node:18-alpine", "nginx:latest"];
      mockedInvoke.mockResolvedValue(images);

      const result = await listDockerImages();

      expect(mockedInvoke).toHaveBeenCalledWith("list_docker_images");
      expect(result).toEqual(images);
    });

    it("listDockerImages returns empty array when none available", async () => {
      mockedInvoke.mockResolvedValue([]);

      const result = await listDockerImages();

      expect(result).toEqual([]);
    });
  });

  describe("podman commands", () => {
    it("checkPodmanAvailable invokes correct command", async () => {
      mockedInvoke.mockResolvedValue(true);

      const result = await checkPodmanAvailable();

      expect(mockedInvoke).toHaveBeenCalledWith("check_podman_available");
      expect(result).toBe(true);
    });

    it("checkPodmanAvailable returns false when unavailable", async () => {
      mockedInvoke.mockResolvedValue(false);

      const result = await checkPodmanAvailable();

      expect(result).toBe(false);
    });

    it("listPodmanImages invokes correct command", async () => {
      const images = ["ubuntu:22.04", "node:18-alpine"];
      mockedInvoke.mockResolvedValue(images);

      const result = await listPodmanImages();

      expect(mockedInvoke).toHaveBeenCalledWith("list_podman_images");
      expect(result).toEqual(images);
    });

    it("listPodmanImages returns empty array when none available", async () => {
      mockedInvoke.mockResolvedValue([]);

      const result = await listPodmanImages();

      expect(result).toEqual([]);
    });
  });

  describe("agent setup commands", () => {
    it("detectAgentArch invokes with correct parameters", async () => {
      const base =
        "https://github.com/armaxri/termiHub/releases/download/dev-latest/termihub-agent-";
      const archInfo = {
        arch: "aarch64",
        os: "Linux",
        archSuffix: "linux-arm64",
        downloadBaseUrl: base,
        downloadUrl: `${base}linux-arm64`,
      };
      mockedInvoke.mockResolvedValue(archInfo);
      const config = {
        host: "pi.local",
        port: 22,
        username: "pi",
        authMethod: "key" as const,
      };

      const result = await detectAgentArch(config);

      expect(mockedInvoke).toHaveBeenCalledWith("detect_agent_arch", {
        config,
      });
      expect(result.arch).toBe("aarch64");
      expect(result.archSuffix).toBe("linux-arm64");
    });

    it("detectAgentArch returns null fields for unsupported arch", async () => {
      mockedInvoke.mockResolvedValue({
        arch: "mips",
        os: "Linux",
        archSuffix: null,
        downloadBaseUrl:
          "https://github.com/armaxri/termiHub/releases/download/dev-latest/termihub-agent-",
        downloadUrl: null,
      });

      const result = await detectAgentArch({
        host: "host",
        port: 22,
        username: "user",
        authMethod: "key",
      });

      expect(result.archSuffix).toBeNull();
      expect(result.downloadUrl).toBeNull();
    });

    it("setupRemoteAgent invokes with github download source", async () => {
      mockedInvoke.mockResolvedValue({ sessionId: "setup-123" });
      const config = {
        host: "pi.local",
        port: 22,
        username: "pi",
        authMethod: "key" as const,
      };
      const setupConfig = {
        binarySource: { type: "githubDownload" as const },
        remoteOs: "Linux",
        remoteArch: "aarch64",
        remotePath: "/usr/local/bin/termihub-agent",
        installService: false,
      };

      const result = await setupRemoteAgent("agent-1", config, setupConfig);

      expect(mockedInvoke).toHaveBeenCalledWith("setup_remote_agent", {
        agentId: "agent-1",
        config,
        setupConfig,
      });
      expect(result.sessionId).toBe("setup-123");
    });

    it("setupRemoteAgent invokes with local file source", async () => {
      mockedInvoke.mockResolvedValue({ sessionId: "setup-456" });
      const config = {
        host: "pi.local",
        port: 22,
        username: "pi",
        authMethod: "key" as const,
      };
      const setupConfig = {
        binarySource: { type: "localFile" as const, path: "/tmp/agent" },
        remoteOs: "Linux",
        remoteArch: "x86_64",
        installService: false,
      };

      const result = await setupRemoteAgent("agent-1", config, setupConfig);

      expect(result.sessionId).toBe("setup-456");
    });

    it("setupRemoteAgent propagates errors", async () => {
      mockedInvoke.mockRejectedValue("Binary not found");

      await expect(
        setupRemoteAgent(
          "agent-1",
          {
            host: "pi.local",
            port: 22,
            username: "pi",
            authMethod: "password",
          },
          {
            binarySource: { type: "githubDownload" },
            remoteOs: "Linux",
            remoteArch: "x86_64",
            installService: false,
          }
        )
      ).rejects.toEqual("Binary not found");
    });

    it("cancelAgentSetup invokes cancel_agent_setup with the agentId", async () => {
      mockedInvoke.mockResolvedValue(true);

      const result = await cancelAgentSetup("agent-1");

      expect(mockedInvoke).toHaveBeenCalledWith("cancel_agent_setup", { agentId: "agent-1" });
      expect(result).toBe(true);
    });

    it("cancelAgentSetup returns false when no run is in flight", async () => {
      mockedInvoke.mockResolvedValue(false);

      const result = await cancelAgentSetup("agent-2");

      expect(result).toBe(false);
    });
  });

  describe("log commands", () => {
    it("getLogs invokes with count and returns entries", async () => {
      const entries = [
        { timestamp: "12:00:00.000", level: "INFO", target: "test", message: "hello" },
      ];
      mockedInvoke.mockResolvedValue(entries);

      const result = await getLogs(100);

      expect(mockedInvoke).toHaveBeenCalledWith("get_logs", { count: 100 });
      expect(result).toEqual(entries);
    });

    it("clearLogs invokes correct command", async () => {
      mockedInvoke.mockResolvedValue(undefined);

      await clearLogs();

      expect(mockedInvoke).toHaveBeenCalledWith("clear_logs");
    });
  });

  describe("credential store commands", () => {
    it("getCredentialStoreStatus returns status info", async () => {
      const status = {
        mode: "master_password",
        status: "unlocked",
      };
      mockedInvoke.mockResolvedValue(status);

      const result = await getCredentialStoreStatus();

      expect(mockedInvoke).toHaveBeenCalledWith("get_credential_store_status");
      expect(result).toEqual(status);
    });

    it("unlockCredentialStore invokes with password", async () => {
      mockedInvoke.mockResolvedValue(undefined);

      await unlockCredentialStore("my-password");

      expect(mockedInvoke).toHaveBeenCalledWith("unlock_credential_store", {
        password: "my-password",
      });
    });

    it("lockCredentialStore invokes correct command", async () => {
      mockedInvoke.mockResolvedValue(undefined);

      await lockCredentialStore();

      expect(mockedInvoke).toHaveBeenCalledWith("lock_credential_store");
    });

    it("setupMasterPassword invokes with password", async () => {
      mockedInvoke.mockResolvedValue(undefined);

      await setupMasterPassword("new-master");

      expect(mockedInvoke).toHaveBeenCalledWith("setup_master_password", {
        password: "new-master",
      });
    });

    it("changeMasterPassword invokes with current and new password", async () => {
      mockedInvoke.mockResolvedValue(undefined);

      await changeMasterPassword("old-pass", "new-pass");

      expect(mockedInvoke).toHaveBeenCalledWith("change_master_password", {
        currentPassword: "old-pass",
        newPassword: "new-pass",
      });
    });

    it("switchCredentialStore invokes with mode and optional master password", async () => {
      const result = { migratedCount: 3, warnings: [] };
      mockedInvoke.mockResolvedValue(result);

      const switchResult = await switchCredentialStore("master_password", "my-pass");

      expect(mockedInvoke).toHaveBeenCalledWith("switch_credential_store", {
        newMode: "master_password",
        masterPassword: "my-pass",
      });
      expect(switchResult).toEqual(result);
    });

    it("switchCredentialStore sends null when no master password", async () => {
      mockedInvoke.mockResolvedValue({ migratedCount: 0, warnings: [] });

      await switchCredentialStore("none");

      expect(mockedInvoke).toHaveBeenCalledWith("switch_credential_store", {
        newMode: "none",
        masterPassword: null,
      });
    });

    it("resolveCredential returns stored password", async () => {
      mockedInvoke.mockResolvedValue("my-secret");

      const result = await resolveCredential("conn-1", "password");

      expect(mockedInvoke).toHaveBeenCalledWith("resolve_credential", {
        connectionId: "conn-1",
        credentialType: "password",
      });
      expect(result).toBe("my-secret");
    });

    it("resolveCredential returns null when not found", async () => {
      mockedInvoke.mockResolvedValue(null);

      const result = await resolveCredential("conn-1", "password");

      expect(mockedInvoke).toHaveBeenCalledWith("resolve_credential", {
        connectionId: "conn-1",
        credentialType: "password",
      });
      expect(result).toBeNull();
    });

    it("resolveCredential supports key_passphrase type", async () => {
      mockedInvoke.mockResolvedValue("key-pass");

      const result = await resolveCredential("conn-2", "key_passphrase");

      expect(mockedInvoke).toHaveBeenCalledWith("resolve_credential", {
        connectionId: "conn-2",
        credentialType: "key_passphrase",
      });
      expect(result).toBe("key-pass");
    });

    it("removeCredential invokes with correct parameters", async () => {
      mockedInvoke.mockResolvedValue(undefined);

      await removeCredential("conn-1", "password");

      expect(mockedInvoke).toHaveBeenCalledWith("remove_credential", {
        connectionId: "conn-1",
        credentialType: "password",
      });
    });
  });
});
