import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ConnectionCreateParams } from "@/types/generated/ConnectionCreateParams";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

const mockedInvoke = vi.mocked(invoke);

import type { RemoteAgentConfig } from "@/types/terminal";
import type { RemoteDesktopInput } from "@/types/remoteDesktop";
import type { TabHandoffRecord, WindowRestorePayload } from "@/types/window";
import type { AgentSettings, ShellIntegrationSettings } from "@/types/connection";

// Import after mock setup.
import {
  // multi-window
  openWindow,
  claimSession,
  releaseSession,
  getSessionOwner,
  listSessionOwners,
  focusWindow,
  listWindows,
  reportWindowTabCount,
  takePendingHandoffs,
  sendHandoffToWindow,
  reportWindowLayout,
  collectWindowLayouts,
  takePendingWindowRestore,
  takePendingSpawn,
  listSpawnOptions,
  // remote-desktop
  remoteDesktopConnect,
  remoteDesktopResize,
  remoteDesktopRequestFullFrame,
  remoteDesktopSendInput,
  remoteDesktopReleaseInput,
  remoteDesktopSendClipboard,
  remoteDesktopGetClipboard,
  remoteDesktopRemoteClipboardFiles,
  remoteDesktopBindClipboardFiles,
  remoteDesktopClipboardImageStatus,
  remoteDesktopCopyClipboardImage,
  remoteDesktopSendClipboardImage,
  remoteDesktopCertDecision,
  remoteDesktopDisconnect,
  // session file browsing
  sessionListFiles,
  sessionStat,
  sessionDeleteFile,
  sessionRenameFile,
  sessionMkdir,
  sessionSetPermissions,
  sessionSetOwner,
  sessionCreateSymlink,
  sessionCopy,
  ftpDownload,
  ftpUpload,
  // session monitoring
  sessionGetCapabilities,
  sessionMonitoringClose,
  sessionMonitoringSetPaused,
  sessionMonitoringSetInterval,
  sessionMonitoringCancel,
  // shell integration
  getShellIntegrationStatus,
  saveShellIntegrationSettings,
  rememberSpawnChoice,
  installShellIntegration,
  uninstallShellIntegration,
  // local filesystem
  localCopyFile,
  localSetPermissions,
  localSetOwner,
  localCreateSymlink,
  localStat,
  watchLocalFile,
  unwatchLocalFile,
  watchLocalDir,
  unwatchLocalDir,
  // agent CRUD / lifecycle
  applyAgentSettings,
  requestAgentDeferredUpdate,
  requestAgentUpdate,
  disconnectAgent,
  getAgentCapabilities,
  listAgentSessions,
  listAgentHostSessions,
  takeOverAgentSession,
  closeAgentSession,
  listAgentDefinitions,
  saveAgentDefinition,
  deleteAgentDefinition,
  listAgentConnections,
  updateAgentDefinition,
  updateAgentFolder,
  deleteAgentFolder,
  updateAgentForce,
  saveRemoteAgent,
  deleteRemoteAgentFromBackend,
  reorderRemoteAgents,
  reorderConnections,
  // portable mode + update checker + logging
  getAppMode,
  listConfigFiles,
  resolvePortablePath,
  exportConfigToPortable,
  importConfigFromPortable,
  getAppInfo,
  getThirdPartyNotices,
  checkForUpdates,
  skipUpdateVersion,
  clearSkippedVersion,
  setUpdateAutoCheck,
  getUpdateSettings,
  setFileLogLevel,
  getLogFilePath,
  sessionLoggingStart,
  sessionLoggingStop,
  sessionLoggingStatus,
  setSessionLineEnding,
  // plugin CRUD
  listPlugins,
  listTrustedPublishers,
  revokeTrustedPublisher,
  uninstallPlugin,
  enablePlugin,
  disablePlugin,
  // misc
  probeConnectionPath,
  cancelConnectionPathProbe,
  importSshConfigConnections,
  moveConnectionToFile,
  getRecoveryWarnings,
  getDefaultShell,
  listLocalSessions,
  startPersistentSession,
  stopPersistentSession,
  attachPersistentTab,
  detachPersistentTab,
  isSshKeyEncrypted,
  resetCredentialStore,
  setAutoLockTimeout,
  storeCredential,
  // X-server
  xServerStatus,
  xServerStop,
  xServerEnsure,
  xServerInstallDependency,
  xServerConnectConsentReply,
} from "./api";
import type { SavedRemoteAgent } from "./api";

describe("api pass-through wrappers (#2975)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Multi-window foundation (#1900) ───────────────────────────────────────
  describe("multi-window foundation", () => {
    it("openWindow defaults handoff and restore to null", async () => {
      mockedInvoke.mockResolvedValue("window-2");

      const result = await openWindow();

      expect(mockedInvoke).toHaveBeenCalledWith("open_window", {
        handoff: null,
        restore: null,
      });
      expect(result).toBe("window-2");
    });

    it("openWindow forwards handoff and restore when provided", async () => {
      mockedInvoke.mockResolvedValue("window-3");
      const handoff = { tabId: "t1" } as unknown as TabHandoffRecord;
      const restore = { tabGroups: [] } as unknown as WindowRestorePayload;

      await openWindow(handoff, restore);

      expect(mockedInvoke).toHaveBeenCalledWith("open_window", { handoff, restore });
    });

    it("claimSession returns the previous owner label", async () => {
      mockedInvoke.mockResolvedValue("main");

      const result = await claimSession("session-1");

      expect(mockedInvoke).toHaveBeenCalledWith("claim_session", { sessionId: "session-1" });
      expect(result).toBe("main");
    });

    it("claimSession returns null when there was no prior owner", async () => {
      mockedInvoke.mockResolvedValue(null);

      expect(await claimSession("session-1")).toBeNull();
    });

    it("releaseSession returns whether it was the owner", async () => {
      mockedInvoke.mockResolvedValue(true);

      const result = await releaseSession("session-1");

      expect(mockedInvoke).toHaveBeenCalledWith("release_session", { sessionId: "session-1" });
      expect(result).toBe(true);
    });

    it("getSessionOwner returns the owning window label", async () => {
      mockedInvoke.mockResolvedValue("window-2");

      const result = await getSessionOwner("session-1");

      expect(mockedInvoke).toHaveBeenCalledWith("get_session_owner", { sessionId: "session-1" });
      expect(result).toBe("window-2");
    });

    it("listSessionOwners returns the owner map", async () => {
      const owners = { "session-1": "main", "session-2": "window-2" };
      mockedInvoke.mockResolvedValue(owners);

      const result = await listSessionOwners();

      expect(mockedInvoke).toHaveBeenCalledWith("list_session_owners");
      expect(result).toEqual(owners);
    });

    it("focusWindow forwards the label", async () => {
      mockedInvoke.mockResolvedValue(undefined);

      await focusWindow("window-2");

      expect(mockedInvoke).toHaveBeenCalledWith("focus_window", { label: "window-2" });
    });

    it("listWindows returns the window list", async () => {
      const windows = [{ label: "main", tabCount: 3 }];
      mockedInvoke.mockResolvedValue(windows);

      const result = await listWindows();

      expect(mockedInvoke).toHaveBeenCalledWith("list_windows");
      expect(result).toEqual(windows);
    });

    it("reportWindowTabCount forwards the count", async () => {
      mockedInvoke.mockResolvedValue(undefined);

      await reportWindowTabCount(4);

      expect(mockedInvoke).toHaveBeenCalledWith("report_window_tab_count", { count: 4 });
    });

    it("takePendingHandoffs returns queued handoff records", async () => {
      const handoffs = [{ tabId: "t1" }];
      mockedInvoke.mockResolvedValue(handoffs);

      const result = await takePendingHandoffs();

      expect(mockedInvoke).toHaveBeenCalledWith("take_pending_handoffs");
      expect(result).toEqual(handoffs);
    });

    it("sendHandoffToWindow forwards the target label and record", async () => {
      mockedInvoke.mockResolvedValue(undefined);
      const handoff = { tabId: "t1" } as unknown as TabHandoffRecord;

      await sendHandoffToWindow("window-2", handoff);

      expect(mockedInvoke).toHaveBeenCalledWith("send_handoff_to_window", {
        targetLabel: "window-2",
        handoff,
      });
    });

    it("reportWindowLayout forwards tab groups and active index", async () => {
      mockedInvoke.mockResolvedValue(undefined);

      await reportWindowLayout([], 0);

      expect(mockedInvoke).toHaveBeenCalledWith("report_window_layout", {
        tabGroups: [],
        activeGroupIndex: 0,
      });
    });

    it("collectWindowLayouts returns per-window layout slices", async () => {
      const layouts = [{ label: "main", tabGroups: [] }];
      mockedInvoke.mockResolvedValue(layouts);

      const result = await collectWindowLayouts();

      expect(mockedInvoke).toHaveBeenCalledWith("collect_window_layouts");
      expect(result).toEqual(layouts);
    });

    it("takePendingWindowRestore returns null when nothing is pending", async () => {
      mockedInvoke.mockResolvedValue(null);

      const result = await takePendingWindowRestore();

      expect(mockedInvoke).toHaveBeenCalledWith("take_pending_window_restore");
      expect(result).toBeNull();
    });

    it("takePendingSpawn returns null when nothing is pending", async () => {
      mockedInvoke.mockResolvedValue(null);

      const result = await takePendingSpawn();

      expect(mockedInvoke).toHaveBeenCalledWith("take_pending_spawn");
      expect(result).toBeNull();
    });

    it("listSpawnOptions returns the spawn targets snapshot", async () => {
      const options = {
        shells: ["bash"],
        wslDistros: [],
        dockerAvailable: false,
        dockerImages: [],
        podmanAvailable: false,
        podmanImages: [],
      };
      mockedInvoke.mockResolvedValue(options);

      const result = await listSpawnOptions();

      expect(mockedInvoke).toHaveBeenCalledWith("list_spawn_options");
      expect(result).toEqual(options);
    });
  });

  // ── Remote-desktop (#1680) ────────────────────────────────────────────────
  describe("remote-desktop commands", () => {
    it("remoteDesktopConnect forwards type and settings and returns the session id", async () => {
      mockedInvoke.mockResolvedValue("rd-session-1");

      const result = await remoteDesktopConnect("vnc", { host: "10.0.0.5" });

      expect(mockedInvoke).toHaveBeenCalledWith("remote_desktop_connect", {
        typeId: "vnc",
        settings: { host: "10.0.0.5" },
      });
      expect(result).toBe("rd-session-1");
    });

    it("remoteDesktopResize forwards pixel dimensions", async () => {
      mockedInvoke.mockResolvedValue(undefined);

      await remoteDesktopResize("rd-1", 1920, 1080);

      expect(mockedInvoke).toHaveBeenCalledWith("remote_desktop_resize", {
        sessionId: "rd-1",
        width: 1920,
        height: 1080,
      });
    });

    it("remoteDesktopRequestFullFrame forwards the session id", async () => {
      mockedInvoke.mockResolvedValue(undefined);

      await remoteDesktopRequestFullFrame("rd-1");

      expect(mockedInvoke).toHaveBeenCalledWith("remote_desktop_request_full_frame", {
        sessionId: "rd-1",
      });
    });

    it("remoteDesktopSendInput forwards the input event", async () => {
      mockedInvoke.mockResolvedValue(undefined);
      const event = { kind: "pointer", x: 1, y: 2 } as unknown as RemoteDesktopInput;

      await remoteDesktopSendInput("rd-1", event);

      expect(mockedInvoke).toHaveBeenCalledWith("remote_desktop_send_input", {
        sessionId: "rd-1",
        event,
      });
    });

    it("remoteDesktopReleaseInput forwards the session id", async () => {
      mockedInvoke.mockResolvedValue(undefined);

      await remoteDesktopReleaseInput("rd-1");

      expect(mockedInvoke).toHaveBeenCalledWith("remote_desktop_release_input", {
        sessionId: "rd-1",
      });
    });

    it("remoteDesktopSendClipboard forwards the text", async () => {
      mockedInvoke.mockResolvedValue(undefined);

      await remoteDesktopSendClipboard("rd-1", "hello");

      expect(mockedInvoke).toHaveBeenCalledWith("remote_desktop_send_clipboard", {
        sessionId: "rd-1",
        text: "hello",
      });
    });

    it("remoteDesktopGetClipboard returns the remote clipboard text", async () => {
      mockedInvoke.mockResolvedValue("clip");

      const result = await remoteDesktopGetClipboard("rd-1");

      expect(mockedInvoke).toHaveBeenCalledWith("remote_desktop_get_clipboard", {
        sessionId: "rd-1",
      });
      expect(result).toBe("clip");
    });

    it("remoteDesktopRemoteClipboardFiles returns the file list", async () => {
      const files = [{ name: "a.txt", size: 10 }];
      mockedInvoke.mockResolvedValue(files);

      const result = await remoteDesktopRemoteClipboardFiles("rd-1");

      expect(mockedInvoke).toHaveBeenCalledWith("remote_desktop_remote_clipboard_files", {
        sessionId: "rd-1",
      });
      expect(result).toEqual(files);
    });

    it("remoteDesktopBindClipboardFiles returns the bound count", async () => {
      mockedInvoke.mockResolvedValue(2);

      const result = await remoteDesktopBindClipboardFiles("rd-1");

      expect(mockedInvoke).toHaveBeenCalledWith("remote_desktop_bind_clipboard_files", {
        sessionId: "rd-1",
      });
      expect(result).toBe(2);
    });

    it("remoteDesktopClipboardImageStatus returns support and the remote image", async () => {
      const status = { supported: true, image: { width: 4, height: 2 } };
      mockedInvoke.mockResolvedValue(status);

      const result = await remoteDesktopClipboardImageStatus("rd-1");

      expect(mockedInvoke).toHaveBeenCalledWith("remote_desktop_clipboard_image_info", {
        sessionId: "rd-1",
      });
      expect(result).toEqual(status);
    });

    it("remoteDesktopCopyClipboardImage returns the copied image's size", async () => {
      mockedInvoke.mockResolvedValue({ width: 4, height: 2 });

      const result = await remoteDesktopCopyClipboardImage("rd-1");

      expect(mockedInvoke).toHaveBeenCalledWith("remote_desktop_copy_clipboard_image", {
        sessionId: "rd-1",
      });
      expect(result).toEqual({ width: 4, height: 2 });
    });

    it("remoteDesktopSendClipboardImage returns null when nothing was sent", async () => {
      mockedInvoke.mockResolvedValue(null);

      const result = await remoteDesktopSendClipboardImage("rd-1");

      expect(mockedInvoke).toHaveBeenCalledWith("remote_desktop_send_clipboard_image", {
        sessionId: "rd-1",
      });
      expect(result).toBeNull();
    });

    it("remoteDesktopCertDecision forwards accept and remember", async () => {
      mockedInvoke.mockResolvedValue(undefined);

      await remoteDesktopCertDecision("rd-1", true, false);

      expect(mockedInvoke).toHaveBeenCalledWith("remote_desktop_cert_decision", {
        sessionId: "rd-1",
        accept: true,
        remember: false,
      });
    });

    it("remoteDesktopDisconnect forwards the session id", async () => {
      mockedInvoke.mockResolvedValue(undefined);

      await remoteDesktopDisconnect("rd-1");

      expect(mockedInvoke).toHaveBeenCalledWith("remote_desktop_disconnect", { sessionId: "rd-1" });
    });
  });

  // ── Session file browsing ─────────────────────────────────────────────────
  describe("session file browsing", () => {
    it("sessionListFiles returns the directory listing", async () => {
      const entries = [{ name: "f.txt", isDirectory: false }];
      mockedInvoke.mockResolvedValue(entries);

      const result = await sessionListFiles("s-1", "/home");

      expect(mockedInvoke).toHaveBeenCalledWith("session_list_files", {
        sessionId: "s-1",
        path: "/home",
      });
      expect(result).toEqual(entries);
    });

    it("sessionStat returns the file entry", async () => {
      const entry = { name: "f.txt", size: 5 };
      mockedInvoke.mockResolvedValue(entry);

      const result = await sessionStat("s-1", "/home/f.txt");

      expect(mockedInvoke).toHaveBeenCalledWith("session_stat", {
        sessionId: "s-1",
        path: "/home/f.txt",
      });
      expect(result).toEqual(entry);
    });

    it("sessionDeleteFile forwards the path", async () => {
      mockedInvoke.mockResolvedValue(undefined);

      await sessionDeleteFile("s-1", "/home/f.txt");

      expect(mockedInvoke).toHaveBeenCalledWith("session_delete_file", {
        sessionId: "s-1",
        path: "/home/f.txt",
      });
    });

    it("sessionRenameFile forwards old and new paths", async () => {
      mockedInvoke.mockResolvedValue(undefined);

      await sessionRenameFile("s-1", "/a", "/b");

      expect(mockedInvoke).toHaveBeenCalledWith("session_rename_file", {
        sessionId: "s-1",
        oldPath: "/a",
        newPath: "/b",
      });
    });

    it("sessionMkdir forwards the path", async () => {
      mockedInvoke.mockResolvedValue(undefined);

      await sessionMkdir("s-1", "/home/new");

      expect(mockedInvoke).toHaveBeenCalledWith("session_mkdir", {
        sessionId: "s-1",
        path: "/home/new",
      });
    });

    it("sessionSetPermissions forwards the mode bits", async () => {
      mockedInvoke.mockResolvedValue(undefined);

      await sessionSetPermissions("s-1", "/home/f", 0o755);

      expect(mockedInvoke).toHaveBeenCalledWith("session_set_permissions", {
        sessionId: "s-1",
        path: "/home/f",
        mode: 0o755,
      });
    });

    it("sessionSetOwner forwards uid/gid (null leaves a side unchanged)", async () => {
      mockedInvoke.mockResolvedValue(undefined);

      await sessionSetOwner("s-1", "/home/f", 1000, null);

      expect(mockedInvoke).toHaveBeenCalledWith("session_set_owner", {
        sessionId: "s-1",
        path: "/home/f",
        uid: 1000,
        gid: null,
      });
    });

    it("sessionCreateSymlink forwards target and link path", async () => {
      mockedInvoke.mockResolvedValue(undefined);

      await sessionCreateSymlink("s-1", "/real", "/link");

      expect(mockedInvoke).toHaveBeenCalledWith("session_create_symlink", {
        sessionId: "s-1",
        target: "/real",
        linkPath: "/link",
      });
    });

    it("sessionCopy forwards src and dest", async () => {
      mockedInvoke.mockResolvedValue(undefined);

      await sessionCopy("s-1", "/a", "/b");

      expect(mockedInvoke).toHaveBeenCalledWith("session_copy", {
        sessionId: "s-1",
        src: "/a",
        dest: "/b",
      });
    });

    it("ftpDownload forwards config/paths and returns the transfer id", async () => {
      mockedInvoke.mockResolvedValue("transfer-1");

      const result = await ftpDownload("s-1", { host: "ftp" }, "/remote/f", "/local/f");

      expect(mockedInvoke).toHaveBeenCalledWith("ftp_download", {
        sessionId: "s-1",
        config: { host: "ftp" },
        remotePath: "/remote/f",
        localPath: "/local/f",
      });
      expect(result).toBe("transfer-1");
    });

    it("ftpUpload forwards config/paths and returns the transfer id", async () => {
      mockedInvoke.mockResolvedValue("transfer-2");

      const result = await ftpUpload("s-1", { host: "ftp" }, "/local/f", "/remote/f");

      expect(mockedInvoke).toHaveBeenCalledWith("ftp_upload", {
        sessionId: "s-1",
        config: { host: "ftp" },
        localPath: "/local/f",
        remotePath: "/remote/f",
      });
      expect(result).toBe("transfer-2");
    });
  });

  // ── Session monitoring ────────────────────────────────────────────────────
  describe("session monitoring", () => {
    it("sessionGetCapabilities returns the capability flags", async () => {
      const caps = { monitoring: true, fileBrowser: false };
      mockedInvoke.mockResolvedValue(caps);

      const result = await sessionGetCapabilities("s-1");

      expect(mockedInvoke).toHaveBeenCalledWith("session_get_capabilities", { sessionId: "s-1" });
      expect(result).toEqual(caps);
    });

    it("sessionMonitoringClose forwards the session id", async () => {
      mockedInvoke.mockResolvedValue(undefined);

      await sessionMonitoringClose("s-1");

      expect(mockedInvoke).toHaveBeenCalledWith("session_monitoring_close", { sessionId: "s-1" });
    });

    it("sessionMonitoringSetPaused forwards the paused flag", async () => {
      mockedInvoke.mockResolvedValue(undefined);

      await sessionMonitoringSetPaused("s-1", true);

      expect(mockedInvoke).toHaveBeenCalledWith("session_monitoring_set_paused", {
        sessionId: "s-1",
        paused: true,
      });
    });

    it("sessionMonitoringSetInterval forwards the interval", async () => {
      mockedInvoke.mockResolvedValue(undefined);

      await sessionMonitoringSetInterval("s-1", 2000);

      expect(mockedInvoke).toHaveBeenCalledWith("session_monitoring_set_interval", {
        sessionId: "s-1",
        intervalMs: 2000,
      });
    });

    it("sessionMonitoringCancel forwards the session id", async () => {
      mockedInvoke.mockResolvedValue(undefined);

      await sessionMonitoringCancel("s-1");

      expect(mockedInvoke).toHaveBeenCalledWith("session_monitoring_cancel", { sessionId: "s-1" });
    });
  });

  // ── Shell integration ─────────────────────────────────────────────────────
  describe("shell integration", () => {
    const status = { registered: true, stale: false };

    it("getShellIntegrationStatus returns the status", async () => {
      mockedInvoke.mockResolvedValue(status);

      const result = await getShellIntegrationStatus();

      expect(mockedInvoke).toHaveBeenCalledWith("get_shell_integration_status");
      expect(result).toEqual(status);
    });

    it("saveShellIntegrationSettings forwards settings and returns status", async () => {
      mockedInvoke.mockResolvedValue(status);
      const settings = {
        enabled: true,
        entries: [],
      } as unknown as ShellIntegrationSettings;

      const result = await saveShellIntegrationSettings(settings);

      expect(mockedInvoke).toHaveBeenCalledWith("save_shell_integration_settings", {
        shellIntegration: settings,
      });
      expect(result).toEqual(status);
    });

    it("rememberSpawnChoice forwards the entry id and target", async () => {
      mockedInvoke.mockResolvedValue(status);

      const result = await rememberSpawnChoice("entry-1", { kind: "local", shell: "bash" });

      expect(mockedInvoke).toHaveBeenCalledWith("remember_spawn_choice", {
        entryId: "entry-1",
        target: { kind: "local", shell: "bash" },
      });
      expect(result).toEqual(status);
    });

    it("installShellIntegration returns the refreshed status", async () => {
      mockedInvoke.mockResolvedValue(status);

      const result = await installShellIntegration();

      expect(mockedInvoke).toHaveBeenCalledWith("install_shell_integration");
      expect(result).toEqual(status);
    });

    it("uninstallShellIntegration returns the refreshed status", async () => {
      mockedInvoke.mockResolvedValue(status);

      const result = await uninstallShellIntegration();

      expect(mockedInvoke).toHaveBeenCalledWith("uninstall_shell_integration");
      expect(result).toEqual(status);
    });
  });

  // ── Local filesystem ──────────────────────────────────────────────────────
  describe("local filesystem", () => {
    it("localCopyFile forwards src/dest and directory flag", async () => {
      mockedInvoke.mockResolvedValue(undefined);

      await localCopyFile("/a", "/b", true);

      expect(mockedInvoke).toHaveBeenCalledWith("local_copy", {
        srcPath: "/a",
        destPath: "/b",
        isDirectory: true,
      });
    });

    it("localSetPermissions forwards the mode bits", async () => {
      mockedInvoke.mockResolvedValue(undefined);

      await localSetPermissions("/a", 0o644);

      expect(mockedInvoke).toHaveBeenCalledWith("local_set_permissions", {
        path: "/a",
        mode: 0o644,
      });
    });

    it("localSetOwner forwards uid/gid (null leaves a side unchanged)", async () => {
      mockedInvoke.mockResolvedValue(undefined);

      await localSetOwner("/a", null, 20);

      expect(mockedInvoke).toHaveBeenCalledWith("local_set_owner", {
        path: "/a",
        uid: null,
        gid: 20,
      });
    });

    it("localCreateSymlink forwards target and link path", async () => {
      mockedInvoke.mockResolvedValue(undefined);

      await localCreateSymlink("/real", "/link");

      expect(mockedInvoke).toHaveBeenCalledWith("local_create_symlink", {
        target: "/real",
        linkPath: "/link",
      });
    });

    it("localStat returns the file entry", async () => {
      const entry = { name: "f", size: 3 };
      mockedInvoke.mockResolvedValue(entry);

      const result = await localStat("/a/f");

      expect(mockedInvoke).toHaveBeenCalledWith("local_stat", { path: "/a/f" });
      expect(result).toEqual(entry);
    });

    it("watchLocalFile forwards the watch id and path", async () => {
      mockedInvoke.mockResolvedValue(undefined);

      await watchLocalFile("w-1", "/a/f");

      expect(mockedInvoke).toHaveBeenCalledWith("watch_local_file", {
        watchId: "w-1",
        path: "/a/f",
      });
    });

    it("unwatchLocalFile forwards the watch id", async () => {
      mockedInvoke.mockResolvedValue(undefined);

      await unwatchLocalFile("w-1");

      expect(mockedInvoke).toHaveBeenCalledWith("unwatch_local_file", { watchId: "w-1" });
    });

    it("watchLocalDir forwards the watch id and path", async () => {
      mockedInvoke.mockResolvedValue(undefined);

      await watchLocalDir("w-2", "/a");

      expect(mockedInvoke).toHaveBeenCalledWith("watch_local_dir", { watchId: "w-2", path: "/a" });
    });

    it("unwatchLocalDir forwards the watch id", async () => {
      mockedInvoke.mockResolvedValue(undefined);

      await unwatchLocalDir("w-2");

      expect(mockedInvoke).toHaveBeenCalledWith("unwatch_local_dir", { watchId: "w-2" });
    });
  });

  // ── Agent CRUD / lifecycle ────────────────────────────────────────────────
  describe("agent CRUD and lifecycle", () => {
    const agentConfig = { host: "pi", port: 22 } as unknown as RemoteAgentConfig;

    it("applyAgentSettings forwards the settings", async () => {
      mockedInvoke.mockResolvedValue(undefined);
      const settings = { autoUpdate: true } as unknown as AgentSettings;

      await applyAgentSettings("agent-1", settings);

      expect(mockedInvoke).toHaveBeenCalledWith("apply_agent_settings", {
        agentId: "agent-1",
        settings,
      });
    });

    it("requestAgentDeferredUpdate forwards args and returns the result", async () => {
      const outcome = { applied: false, activeSessions: 2 };
      mockedInvoke.mockResolvedValue(outcome);

      const result = await requestAgentDeferredUpdate("agent-1", "/tmp/bin", "1.2.3");

      expect(mockedInvoke).toHaveBeenCalledWith("request_agent_deferred_update", {
        agentId: "agent-1",
        binaryPath: "/tmp/bin",
        version: "1.2.3",
      });
      expect(result).toEqual(outcome);
    });

    it("requestAgentUpdate forwards args and returns the coordinated result", async () => {
      const outcome = {
        applied: true,
        activeSessions: 0,
        notifiedClients: 1,
        allAcked: true,
        remainingClients: [],
      };
      mockedInvoke.mockResolvedValue(outcome);

      const result = await requestAgentUpdate("agent-1");

      expect(mockedInvoke).toHaveBeenCalledWith("request_agent_update", {
        agentId: "agent-1",
        binaryPath: undefined,
        version: undefined,
      });
      expect(result).toEqual(outcome);
    });

    it("disconnectAgent forwards the agent id", async () => {
      mockedInvoke.mockResolvedValue(undefined);

      await disconnectAgent("agent-1");

      expect(mockedInvoke).toHaveBeenCalledWith("disconnect_agent", { agentId: "agent-1" });
    });

    it("getAgentCapabilities returns the capabilities", async () => {
      const caps = { monitoring: true };
      mockedInvoke.mockResolvedValue(caps);

      const result = await getAgentCapabilities("agent-1");

      expect(mockedInvoke).toHaveBeenCalledWith("get_agent_capabilities", { agentId: "agent-1" });
      expect(result).toEqual(caps);
    });

    it("listAgentSessions returns the session list", async () => {
      const sessions = [{ sessionId: "s1", title: "t", type: "ssh", status: "ok", attached: true }];
      mockedInvoke.mockResolvedValue(sessions);

      const result = await listAgentSessions("agent-1");

      expect(mockedInvoke).toHaveBeenCalledWith("list_agent_sessions", { agentId: "agent-1" });
      expect(result).toEqual(sessions);
    });

    it("listAgentHostSessions forwards the agent id (#3369)", async () => {
      const reply = { supported: true, sessions: [] };
      mockedInvoke.mockResolvedValue(reply);

      const result = await listAgentHostSessions("agent-1");

      expect(mockedInvoke).toHaveBeenCalledWith("list_agent_host_sessions", {
        agentId: "agent-1",
      });
      expect(result).toEqual(reply);
    });

    it("takeOverAgentSession forwards the agent and session ids (#3369)", async () => {
      mockedInvoke.mockResolvedValue(undefined);

      await takeOverAgentSession("agent-1", "s-1");

      expect(mockedInvoke).toHaveBeenCalledWith("take_over_agent_session", {
        agentId: "agent-1",
        sessionId: "s-1",
      });
    });

    it("closeAgentSession forwards the agent and session ids", async () => {
      mockedInvoke.mockResolvedValue(undefined);

      await closeAgentSession("agent-1", "s-1");

      expect(mockedInvoke).toHaveBeenCalledWith("close_agent_session", {
        agentId: "agent-1",
        sessionId: "s-1",
      });
    });

    it("listAgentDefinitions returns the definitions", async () => {
      const defs = [{ id: "d1", name: "n", sessionType: "ssh", config: {}, persistent: false }];
      mockedInvoke.mockResolvedValue(defs);

      const result = await listAgentDefinitions("agent-1");

      expect(mockedInvoke).toHaveBeenCalledWith("list_agent_definitions", { agentId: "agent-1" });
      expect(result).toEqual(defs);
    });

    it("saveAgentDefinition forwards the definition and returns the saved record", async () => {
      const saved = { id: "d1", name: "n", sessionType: "ssh", config: {}, persistent: false };
      mockedInvoke.mockResolvedValue(saved);
      const definition: ConnectionCreateParams = {
        name: "n",
        type: "ssh",
        config: {},
        persistent: false,
        folder_id: null,
        terminal_options: null,
        icon: null,
      };

      const result = await saveAgentDefinition("agent-1", definition);

      expect(mockedInvoke).toHaveBeenCalledWith("save_agent_definition", {
        agentId: "agent-1",
        definition,
      });
      expect(result).toEqual(saved);
    });

    it("deleteAgentDefinition forwards the agent and definition ids", async () => {
      mockedInvoke.mockResolvedValue(undefined);

      await deleteAgentDefinition("agent-1", "d-1");

      expect(mockedInvoke).toHaveBeenCalledWith("delete_agent_definition", {
        agentId: "agent-1",
        definitionId: "d-1",
      });
    });

    it("listAgentConnections returns connections and folders", async () => {
      const data = { connections: [], folders: [] };
      mockedInvoke.mockResolvedValue(data);

      const result = await listAgentConnections("agent-1");

      expect(mockedInvoke).toHaveBeenCalledWith("list_agent_connections", { agentId: "agent-1" });
      expect(result).toEqual(data);
    });

    it("updateAgentDefinition forwards the params and returns the record", async () => {
      const updated = { id: "d1", name: "n2", sessionType: "ssh", config: {}, persistent: false };
      mockedInvoke.mockResolvedValue(updated);
      const params = { id: "d1", name: "n2" };

      const result = await updateAgentDefinition("agent-1", params);

      expect(mockedInvoke).toHaveBeenCalledWith("update_agent_definition", {
        agentId: "agent-1",
        params,
      });
      expect(result).toEqual(updated);
    });

    it("updateAgentFolder forwards the params and returns the folder", async () => {
      const folder = { id: "f1", name: "n2", parentId: null, isExpanded: true };
      mockedInvoke.mockResolvedValue(folder);
      const params = { id: "f1", name: "n2" };

      const result = await updateAgentFolder("agent-1", params);

      expect(mockedInvoke).toHaveBeenCalledWith("update_agent_folder", {
        agentId: "agent-1",
        params,
      });
      expect(result).toEqual(folder);
    });

    it("deleteAgentFolder forwards the agent and folder ids", async () => {
      mockedInvoke.mockResolvedValue(undefined);

      await deleteAgentFolder("agent-1", "f-1");

      expect(mockedInvoke).toHaveBeenCalledWith("delete_agent_folder", {
        agentId: "agent-1",
        folderId: "f-1",
      });
    });

    it("updateAgentForce forwards config and deploy config", async () => {
      const outcome = { kind: "deployed", success: true, installedVersion: "1.0.0" };
      mockedInvoke.mockResolvedValue(outcome);
      const deployConfig = { remotePath: "/opt/agent" };

      const result = await updateAgentForce("agent-1", agentConfig, deployConfig);

      expect(mockedInvoke).toHaveBeenCalledWith("update_agent_force", {
        agentId: "agent-1",
        config: agentConfig,
        deployConfig,
      });
      expect(result).toEqual(outcome);
    });

    it("saveRemoteAgent forwards the agent record", async () => {
      mockedInvoke.mockResolvedValue(undefined);
      const agent = {
        id: "agent-1",
        name: "pi",
        config: agentConfig,
        agentSettings: {},
      } as unknown as SavedRemoteAgent;

      await saveRemoteAgent(agent);

      expect(mockedInvoke).toHaveBeenCalledWith("save_remote_agent", { agent });
    });

    it("deleteRemoteAgentFromBackend forwards the id", async () => {
      mockedInvoke.mockResolvedValue(undefined);

      await deleteRemoteAgentFromBackend("agent-1");

      expect(mockedInvoke).toHaveBeenCalledWith("delete_remote_agent", { id: "agent-1" });
    });

    it("reorderRemoteAgents forwards the ordered ids", async () => {
      mockedInvoke.mockResolvedValue(undefined);

      await reorderRemoteAgents(["a", "b"]);

      expect(mockedInvoke).toHaveBeenCalledWith("reorder_remote_agents", { agentIds: ["a", "b"] });
    });

    it("reorderConnections forwards the ordered ids", async () => {
      mockedInvoke.mockResolvedValue(undefined);

      await reorderConnections(["c1", "c2"]);

      expect(mockedInvoke).toHaveBeenCalledWith("reorder_connections", {
        connectionIds: ["c1", "c2"],
      });
    });
  });

  // ── Portable mode + update checker + logging ──────────────────────────────
  describe("portable mode, update checker, logging", () => {
    it("getAppMode returns the mode info", async () => {
      const info = { portable: false, dataDir: "/home/.config" };
      mockedInvoke.mockResolvedValue(info);

      const result = await getAppMode();

      expect(mockedInvoke).toHaveBeenCalledWith("get_app_mode");
      expect(result).toEqual(info);
    });

    it("listConfigFiles forwards the directory", async () => {
      const files = [{ name: "settings.json", present: true }];
      mockedInvoke.mockResolvedValue(files);

      const result = await listConfigFiles("/data");

      expect(mockedInvoke).toHaveBeenCalledWith("list_config_files", { dir: "/data" });
      expect(result).toEqual(files);
    });

    it("resolvePortablePath forwards the path", async () => {
      mockedInvoke.mockResolvedValue("/abs/data");

      const result = await resolvePortablePath("{PORTABLE_DIR}/data");

      expect(mockedInvoke).toHaveBeenCalledWith("resolve_portable_path_cmd", {
        path: "{PORTABLE_DIR}/data",
      });
      expect(result).toBe("/abs/data");
    });

    it("exportConfigToPortable forwards dest and files", async () => {
      const migration = { copied: ["settings.json"], skipped: [] };
      mockedInvoke.mockResolvedValue(migration);

      const result = await exportConfigToPortable("/data", ["settings.json"]);

      expect(mockedInvoke).toHaveBeenCalledWith("export_config_to_portable", {
        destDir: "/data",
        files: ["settings.json"],
      });
      expect(result).toEqual(migration);
    });

    it("importConfigFromPortable forwards src and files", async () => {
      const migration = { copied: ["settings.json"], skipped: [] };
      mockedInvoke.mockResolvedValue(migration);

      const result = await importConfigFromPortable("/data", ["settings.json"]);

      expect(mockedInvoke).toHaveBeenCalledWith("import_config_from_portable", {
        srcDir: "/data",
        files: ["settings.json"],
      });
      expect(result).toEqual(migration);
    });

    it("getAppInfo returns the build info", async () => {
      const info = { version: "0.1.0-dev", gitHash: "abc", isDev: true, buildBranch: "develop" };
      mockedInvoke.mockResolvedValue(info);

      const result = await getAppInfo();

      expect(mockedInvoke).toHaveBeenCalledWith("get_app_info");
      expect(result).toEqual(info);
    });

    it("getThirdPartyNotices returns the bundled notices or null", async () => {
      mockedInvoke.mockResolvedValue(null);

      const result = await getThirdPartyNotices();

      expect(mockedInvoke).toHaveBeenCalledWith("get_third_party_notices");
      expect(result).toBeNull();
    });

    it("checkForUpdates forwards the force flag", async () => {
      const update = { available: false };
      mockedInvoke.mockResolvedValue(update);

      const result = await checkForUpdates(true);

      expect(mockedInvoke).toHaveBeenCalledWith("check_for_updates", { force: true });
      expect(result).toEqual(update);
    });

    it("skipUpdateVersion forwards the version", async () => {
      mockedInvoke.mockResolvedValue(undefined);

      await skipUpdateVersion("1.2.3");

      expect(mockedInvoke).toHaveBeenCalledWith("skip_update_version", { version: "1.2.3" });
    });

    it("clearSkippedVersion invokes the command", async () => {
      mockedInvoke.mockResolvedValue(undefined);

      await clearSkippedVersion();

      expect(mockedInvoke).toHaveBeenCalledWith("clear_skipped_version");
    });

    it("setUpdateAutoCheck forwards the enabled flag", async () => {
      mockedInvoke.mockResolvedValue(undefined);

      await setUpdateAutoCheck(false);

      expect(mockedInvoke).toHaveBeenCalledWith("set_update_auto_check", { enabled: false });
    });

    it("getUpdateSettings returns the settings", async () => {
      const settings = { autoCheck: true, lastCheck: null, skippedVersion: null };
      mockedInvoke.mockResolvedValue(settings);

      const result = await getUpdateSettings();

      expect(mockedInvoke).toHaveBeenCalledWith("get_update_settings");
      expect(result).toEqual(settings);
    });

    it("setFileLogLevel forwards the level", async () => {
      mockedInvoke.mockResolvedValue(undefined);

      await setFileLogLevel("debug");

      expect(mockedInvoke).toHaveBeenCalledWith("set_file_log_level", { level: "debug" });
    });

    it("getLogFilePath returns the log path", async () => {
      mockedInvoke.mockResolvedValue("/logs/app.log");

      const result = await getLogFilePath();

      expect(mockedInvoke).toHaveBeenCalledWith("get_log_file_path");
      expect(result).toBe("/logs/app.log");
    });

    it("sessionLoggingStart forwards args and returns the transcript path", async () => {
      mockedInvoke.mockResolvedValue("/logs/session.log");

      const result = await sessionLoggingStart("s-1", "/logs/session.log", true);

      expect(mockedInvoke).toHaveBeenCalledWith("session_logging_start", {
        sessionId: "s-1",
        path: "/logs/session.log",
        timestamps: true,
      });
      expect(result).toBe("/logs/session.log");
    });

    it("sessionLoggingStop returns the transcript path or null", async () => {
      mockedInvoke.mockResolvedValue(null);

      const result = await sessionLoggingStop("s-1");

      expect(mockedInvoke).toHaveBeenCalledWith("session_logging_stop", { sessionId: "s-1" });
      expect(result).toBeNull();
    });

    it("sessionLoggingStatus returns the status or null", async () => {
      const status = { path: "/logs/session.log", timestamps: false };
      mockedInvoke.mockResolvedValue(status);

      const result = await sessionLoggingStatus("s-1");

      expect(mockedInvoke).toHaveBeenCalledWith("session_logging_status", { sessionId: "s-1" });
      expect(result).toEqual(status);
    });

    it("setSessionLineEnding forwards the line ending", async () => {
      mockedInvoke.mockResolvedValue(undefined);

      await setSessionLineEnding("s-1", "crlf");

      expect(mockedInvoke).toHaveBeenCalledWith("set_session_line_ending", {
        sessionId: "s-1",
        lineEnding: "crlf",
      });
    });
  });

  // ── Plugin CRUD ───────────────────────────────────────────────────────────
  describe("plugin CRUD", () => {
    it("listPlugins returns the installed plugins", async () => {
      const plugins = [{ id: "p1", enabled: true }];
      mockedInvoke.mockResolvedValue(plugins);

      const result = await listPlugins();

      expect(mockedInvoke).toHaveBeenCalledWith("list_plugins");
      expect(result).toEqual(plugins);
    });

    it("listTrustedPublishers returns the publishers", async () => {
      const publishers = [{ keyId: "k1", name: "acme" }];
      mockedInvoke.mockResolvedValue(publishers);

      const result = await listTrustedPublishers();

      expect(mockedInvoke).toHaveBeenCalledWith("list_trusted_publishers");
      expect(result).toEqual(publishers);
    });

    it("revokeTrustedPublisher forwards the key id", async () => {
      mockedInvoke.mockResolvedValue(undefined);

      await revokeTrustedPublisher("k1");

      expect(mockedInvoke).toHaveBeenCalledWith("revoke_trusted_publisher", { keyId: "k1" });
    });

    it("uninstallPlugin forwards the plugin id under the `id` key (#3488)", async () => {
      mockedInvoke.mockResolvedValue(undefined);

      await uninstallPlugin("p1");

      expect(mockedInvoke).toHaveBeenCalledWith("uninstall_plugin", { id: "p1" });
    });

    it("enablePlugin forwards the plugin id under the `id` key (#3488)", async () => {
      mockedInvoke.mockResolvedValue(undefined);

      await enablePlugin("p1");

      expect(mockedInvoke).toHaveBeenCalledWith("enable_plugin", { id: "p1" });
    });

    it("disablePlugin forwards the plugin id under the `id` key (#3488)", async () => {
      mockedInvoke.mockResolvedValue(undefined);

      await disablePlugin("p1");

      expect(mockedInvoke).toHaveBeenCalledWith("disable_plugin", { id: "p1" });
    });
  });

  // ── Misc ──────────────────────────────────────────────────────────────────
  describe("miscellaneous wrappers", () => {
    it("probeConnectionPath forwards the probe id and settings", async () => {
      mockedInvoke.mockResolvedValue(undefined);

      await probeConnectionPath("probe-1", { host: "pi" });

      expect(mockedInvoke).toHaveBeenCalledWith("probe_connection_path_cmd", {
        probeId: "probe-1",
        settings: { host: "pi" },
      });
    });

    it("cancelConnectionPathProbe returns whether a probe was active", async () => {
      mockedInvoke.mockResolvedValue(true);

      const result = await cancelConnectionPathProbe("probe-1");

      expect(mockedInvoke).toHaveBeenCalledWith("cancel_connection_path_probe", {
        probeId: "probe-1",
      });
      expect(result).toBe(true);
    });

    it("importSshConfigConnections returns the parsed connections", async () => {
      const hosts = [{ alias: "pi", host: "pi.local" }];
      mockedInvoke.mockResolvedValue(hosts);

      const result = await importSshConfigConnections();

      expect(mockedInvoke).toHaveBeenCalledWith("import_ssh_config_connections");
      expect(result).toEqual(hosts);
    });

    it("moveConnectionToFile forwards ids and sources and returns the moved connection", async () => {
      const moved = { id: "c1", name: "n" };
      mockedInvoke.mockResolvedValue(moved);

      const result = await moveConnectionToFile("c1", null, "/ext.json");

      expect(mockedInvoke).toHaveBeenCalledWith("move_connection_to_file", {
        connectionId: "c1",
        currentSource: null,
        targetSource: "/ext.json",
      });
      expect(result).toEqual(moved);
    });

    it("getRecoveryWarnings returns the warnings", async () => {
      const warnings = [{ message: "recovered" }];
      mockedInvoke.mockResolvedValue(warnings);

      const result = await getRecoveryWarnings();

      expect(mockedInvoke).toHaveBeenCalledWith("get_recovery_warnings");
      expect(result).toEqual(warnings);
    });

    it("getDefaultShell returns the detected shell", async () => {
      mockedInvoke.mockResolvedValue("/bin/zsh");

      const result = await getDefaultShell();

      expect(mockedInvoke).toHaveBeenCalledWith("get_default_shell");
      expect(result).toBe("/bin/zsh");
    });

    it("listLocalSessions returns the local sessions", async () => {
      const sessions = [{ id: "s1", title: "t", connectionType: "local", alive: true }];
      mockedInvoke.mockResolvedValue(sessions);

      const result = await listLocalSessions();

      expect(mockedInvoke).toHaveBeenCalledWith("list_local_sessions");
      expect(result).toEqual(sessions);
    });

    it("startPersistentSession forwards args and returns the session id", async () => {
      mockedInvoke.mockResolvedValue("s-1");

      const result = await startPersistentSession("c1", "ssh", { host: "pi" }, "agent-1");

      expect(mockedInvoke).toHaveBeenCalledWith("start_persistent_session", {
        connectionId: "c1",
        typeId: "ssh",
        settings: { host: "pi" },
        agentId: "agent-1",
      });
      expect(result).toBe("s-1");
    });

    it("stopPersistentSession forwards the connection id", async () => {
      mockedInvoke.mockResolvedValue(undefined);

      await stopPersistentSession("c1");

      expect(mockedInvoke).toHaveBeenCalledWith("stop_persistent_session", { connectionId: "c1" });
    });

    it("attachPersistentTab forwards ids and returns the tab count", async () => {
      mockedInvoke.mockResolvedValue(2);

      const result = await attachPersistentTab("c1", "tab-1");

      expect(mockedInvoke).toHaveBeenCalledWith("attach_persistent_tab", {
        connectionId: "c1",
        tabId: "tab-1",
      });
      expect(result).toBe(2);
    });

    it("detachPersistentTab forwards ids and returns the tab count", async () => {
      mockedInvoke.mockResolvedValue(1);

      const result = await detachPersistentTab("s-1", "tab-1");

      expect(mockedInvoke).toHaveBeenCalledWith("detach_persistent_tab", {
        sessionId: "s-1",
        tabId: "tab-1",
      });
      expect(result).toBe(1);
    });

    it("isSshKeyEncrypted forwards the path and returns the flag", async () => {
      mockedInvoke.mockResolvedValue(true);

      const result = await isSshKeyEncrypted("/home/.ssh/id_rsa");

      expect(mockedInvoke).toHaveBeenCalledWith("is_ssh_key_encrypted", {
        path: "/home/.ssh/id_rsa",
      });
      expect(result).toBe(true);
    });

    it("resetCredentialStore invokes the command", async () => {
      mockedInvoke.mockResolvedValue(undefined);

      await resetCredentialStore();

      expect(mockedInvoke).toHaveBeenCalledWith("reset_credential_store");
    });

    it("setAutoLockTimeout forwards the minutes (including null)", async () => {
      mockedInvoke.mockResolvedValue(undefined);

      await setAutoLockTimeout(null);

      expect(mockedInvoke).toHaveBeenCalledWith("set_auto_lock_timeout", { minutes: null });
    });

    it("storeCredential forwards the connection id, type and value", async () => {
      mockedInvoke.mockResolvedValue(undefined);

      await storeCredential("c1", "password", "secret");

      expect(mockedInvoke).toHaveBeenCalledWith("store_credential", {
        connectionId: "c1",
        credentialType: "password",
        value: "secret",
      });
    });
  });

  // ── X-server ──────────────────────────────────────────────────────────────
  describe("X-server wrappers", () => {
    it("xServerStatus returns the status report", async () => {
      const report = { state: "running" };
      mockedInvoke.mockResolvedValue(report);

      const result = await xServerStatus();

      expect(mockedInvoke).toHaveBeenCalledWith("x_server_status");
      expect(result).toEqual(report);
    });

    it("xServerStop invokes the command", async () => {
      mockedInvoke.mockResolvedValue(undefined);

      await xServerStop();

      expect(mockedInvoke).toHaveBeenCalledWith("x_server_stop");
    });

    it("xServerEnsure returns the final status report", async () => {
      const report = { state: "running" };
      mockedInvoke.mockResolvedValue(report);

      const result = await xServerEnsure();

      expect(mockedInvoke).toHaveBeenCalledWith("x_server_ensure");
      expect(result).toEqual(report);
    });

    it("xServerInstallDependency invokes the command", async () => {
      mockedInvoke.mockResolvedValue(undefined);

      await xServerInstallDependency();

      expect(mockedInvoke).toHaveBeenCalledWith("x_server_install_dependency");
    });

    it("xServerConnectConsentReply forwards the id and decision", async () => {
      mockedInvoke.mockResolvedValue(true);

      const result = await xServerConnectConsentReply("consent-1", "enable");

      expect(mockedInvoke).toHaveBeenCalledWith("x_server_connect_consent_reply", {
        id: "consent-1",
        decision: "enable",
      });
      expect(result).toBe(true);
    });
  });

  // ── Error propagation ─────────────────────────────────────────────────────
  // A representative slice across categories: a rejecting `invoke` must
  // propagate unchanged out of the wrapper (no swallow, no rewrap).
  describe("error propagation", () => {
    it("xServerEnsure rejects with the backend XServerError", async () => {
      mockedInvoke.mockRejectedValue({ kind: "downloadFailed", message: "network down" });

      await expect(xServerEnsure()).rejects.toEqual({
        kind: "downloadFailed",
        message: "network down",
      });
    });

    it("isSshKeyEncrypted rejects when the key file cannot be read", async () => {
      mockedInvoke.mockRejectedValue("permission denied");

      await expect(isSshKeyEncrypted("/home/.ssh/id_rsa")).rejects.toEqual("permission denied");
    });

    it("checkForUpdates propagates a network error", async () => {
      mockedInvoke.mockRejectedValue("github unreachable");

      await expect(checkForUpdates(false)).rejects.toEqual("github unreachable");
    });

    it("installShellIntegration propagates a registration failure", async () => {
      mockedInvoke.mockRejectedValue("registry write failed");

      await expect(installShellIntegration()).rejects.toEqual("registry write failed");
    });

    it("remoteDesktopConnect propagates a connect failure", async () => {
      mockedInvoke.mockRejectedValue("handshake failed");

      await expect(remoteDesktopConnect("vnc", {})).rejects.toEqual("handshake failed");
    });

    it("updateAgentForce propagates a deploy failure", async () => {
      mockedInvoke.mockRejectedValue("sftp upload failed");

      await expect(
        updateAgentForce("agent-1", {} as unknown as RemoteAgentConfig, {})
      ).rejects.toEqual("sftp upload failed");
    });

    it("uninstallPlugin propagates a filesystem error", async () => {
      mockedInvoke.mockRejectedValue("plugin dir locked");

      await expect(uninstallPlugin("p1")).rejects.toEqual("plugin dir locked");
    });

    it("sessionListFiles propagates a browse error", async () => {
      mockedInvoke.mockRejectedValue("not a directory");

      await expect(sessionListFiles("s-1", "/nope")).rejects.toEqual("not a directory");
    });
  });
});
