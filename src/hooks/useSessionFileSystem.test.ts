import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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

vi.mock("@/services/api", () => ({
  sftpOpen: vi.fn(),
  sftpClose: vi.fn(),
  sftpListDir: vi.fn(),
  localListDir: vi.fn(() => Promise.resolve([])),
  vscodeAvailable: vi.fn(() => Promise.resolve(false)),
  sessionListFiles: vi.fn(() => Promise.resolve([])),
  sessionReadFile: vi.fn(() => Promise.resolve(new Uint8Array())),
  sessionWriteFile: vi.fn(() => Promise.resolve()),
  sessionDeleteFile: vi.fn(() => Promise.resolve()),
  sessionRenameFile: vi.fn(() => Promise.resolve()),
  sessionMkdir: vi.fn(() => Promise.resolve()),
  sessionCopy: vi.fn(() => Promise.resolve()),
  sessionSetPermissions: vi.fn(() => Promise.resolve()),
  sessionDownload: vi.fn(() => Promise.resolve(0)),
  sessionUpload: vi.fn(() => Promise.resolve(0)),
  sessionCopyRemote: vi.fn(() => Promise.resolve(0)),
  sessionVscodeOpenRemote: vi.fn(() => Promise.resolve()),
  localDelete: vi.fn(() => Promise.resolve()),
  // Default: reject → session is byte-based (Docker / FTP / agent). The
  // SFTP-backed suite overrides this to resolve.
  sessionHasExecCapability: vi.fn(() => Promise.reject(new Error("not sftp-backed"))),
  // Default: false → session is NOT queue-capable (Docker / agent), so transfers
  // use the byte-based fallback. The SFTP and FTP suites override this to true
  // (PROD-010).
  sessionSupportsTransferQueue: vi.fn(() => Promise.resolve(false)),
  // The real marker class so `error instanceof TransferTerminalError` in
  // runTransfer resolves correctly (#1286).
  TransferTerminalError: class TransferTerminalError extends Error {
    readonly phase: "cancelled" | "error";
    constructor(phase: "cancelled" | "error", message: string) {
      super(message);
      this.name = "TransferTerminalError";
      this.phase = phase;
    }
  },
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(() => Promise.resolve(null)),
  save: vi.fn(() => Promise.resolve("/local/save.txt")),
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

vi.mock("@tauri-apps/plugin-fs", () => ({
  readFile: vi.fn(() => Promise.resolve(new Uint8Array())),
  writeFile: vi.fn(() => Promise.resolve()),
}));

// The Transfer Queue seed goes through the transfers bridge (see
// transferFeedback.seedTransferQueueRow), so this is the seam that proves a
// session→session paste registers tracked rows in the region-fed queue (#2469).
vi.mock("@/store/transfersBridge", () => ({
  dispatchTransferIntentBestEffort: vi.fn(),
}));

// Local temp path used by an SFTP-backed session→session copy (download → temp
// → upload). Deterministic join so the temp path is assertable.
vi.mock("@tauri-apps/api/path", () => ({
  tempDir: vi.fn(() => Promise.resolve("/tmp")),
  join: vi.fn((...parts: string[]) => Promise.resolve(parts.join("/"))),
}));

// navigateUp logic extracted from useSessionFileSystem
function navigateUpSession(currentPath: string): string | null {
  if (currentPath === "/") return null; // no-op
  const parentPath = currentPath.split("/").slice(0, -1).join("/") || "/";
  return parentPath;
}

describe("useSessionFileSystem — navigateUp path logic", () => {
  it("navigates up from a nested path", () => {
    expect(navigateUpSession("/home/user/docs")).toBe("/home/user");
  });

  it("navigates up from single-depth path", () => {
    expect(navigateUpSession("/home")).toBe("/");
  });

  it("returns null (no-op) at root /", () => {
    expect(navigateUpSession("/")).toBeNull();
  });
});

// Path construction logic for createDirectory
function buildSessionDirPath(currentPath: string, name: string): string {
  return currentPath === "/" ? `/${name}` : `${currentPath}/${name}`;
}

// Path construction for renameEntry
function buildSessionRenamePath(oldPath: string, newName: string): string {
  const parentDir = oldPath.split("/").slice(0, -1).join("/") || "/";
  return parentDir === "/" ? `/${newName}` : `${parentDir}/${newName}`;
}

describe("useSessionFileSystem — path construction", () => {
  describe("createDirectory", () => {
    it("creates path from root", () => {
      expect(buildSessionDirPath("/", "newdir")).toBe("/newdir");
    });

    it("creates path from nested directory", () => {
      expect(buildSessionDirPath("/home/user", "projects")).toBe("/home/user/projects");
    });
  });

  describe("renameEntry", () => {
    it("renames in nested directory", () => {
      expect(buildSessionRenamePath("/home/user/old.txt", "new.txt")).toBe("/home/user/new.txt");
    });

    it("renames in root directory", () => {
      expect(buildSessionRenamePath("/old.txt", "new.txt")).toBe("/new.txt");
    });
  });
});

import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { sessionWriteFile } from "@/services/api";
import { useSessionFileSystem } from "./useSessionFileSystem";
import { useAppStore } from "@/store/appStore";
import { currentFileBrowsersView } from "@/store/fileBrowsersBridge";
import { seedFileBrowsers, setupFileBrowsersRegion } from "@/test/fileBrowsersRegionTestHarness";

setupFileBrowsersRegion();

describe("useSessionFileSystem — uploadFileFromPath API call", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    vi.clearAllMocks();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("calls sessionWriteFile with the correct remote path", async () => {
    useAppStore.setState({ sessionFileBrowserId: "sess-1" });
    seedFileBrowsers({
      session: { path: "/remote/dir", entries: [], loading: false, error: null },
    });

    let uploadFn: ((path: string) => Promise<void>) | undefined;
    function Harness() {
      const { uploadFileFromPath } = useSessionFileSystem();
      uploadFn = uploadFileFromPath;
      return null;
    }

    await act(async () => {
      root.render(React.createElement(Harness));
    });

    await act(async () => {
      await uploadFn!("/local/data.csv");
    });

    expect(vi.mocked(sessionWriteFile)).toHaveBeenCalledWith(
      "sess-1",
      "/remote/dir/data.csv",
      expect.any(Uint8Array)
    );
  });

  it("calls sessionWriteFile with root-level path when sessionCurrentPath is /", async () => {
    useAppStore.setState({ sessionFileBrowserId: "sess-1" });
    seedFileBrowsers({ session: { path: "/", entries: [], loading: false, error: null } });

    let uploadFn: ((path: string) => Promise<void>) | undefined;
    function Harness() {
      const { uploadFileFromPath } = useSessionFileSystem();
      uploadFn = uploadFileFromPath;
      return null;
    }

    await act(async () => {
      root.render(React.createElement(Harness));
    });

    await act(async () => {
      await uploadFn!("/local/config.json");
    });

    expect(vi.mocked(sessionWriteFile)).toHaveBeenCalledWith(
      "sess-1",
      "/config.json",
      expect.any(Uint8Array)
    );
  });

  it("does nothing when sessionFileBrowserId is null", async () => {
    useAppStore.setState({ sessionFileBrowserId: null });
    seedFileBrowsers({
      session: { path: "/remote/dir", entries: [], loading: false, error: null },
    });

    let uploadFn: ((path: string) => Promise<void>) | undefined;
    function Harness() {
      const { uploadFileFromPath } = useSessionFileSystem();
      uploadFn = uploadFileFromPath;
      return null;
    }

    await act(async () => {
      root.render(React.createElement(Harness));
    });

    await act(async () => {
      await uploadFn!("/local/file.txt");
    });

    expect(vi.mocked(sessionWriteFile)).not.toHaveBeenCalled();
  });
});

describe("useSessionFileSystem — store integration", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
  });

  it("sessionFileBrowserId starts as null", () => {
    expect(useAppStore.getState().sessionFileBrowserId).toBeNull();
  });

  it("the session pane path starts at /", () => {
    expect(currentFileBrowsersView().session.path).toBe("/");
  });

  it("isConnected is false when sessionFileBrowserId is null", () => {
    const { sessionFileBrowserId } = useAppStore.getState();
    expect(sessionFileBrowserId).toBeNull();
    // isConnected = sessionFileBrowserId !== null
    expect(sessionFileBrowserId !== null).toBe(false);
  });
});

// SFTP-capability gating (#2421): an SFTP-backed session (SSH) drives the
// dedicated transfer channel + VS Code remote open; a byte-based backend
// (Docker / FTP / agent) falls back to session_read_file / session_write_file
// and has no VS Code remote open. The transport is detected by the
// session_has_exec_capability probe (resolve → SFTP-backed, reject → byte-based).
import {
  sessionDownload,
  sessionUpload,
  sessionCopyRemote,
  sessionVscodeOpenRemote,
  sessionReadFile,
  sessionHasExecCapability,
  sessionSupportsTransferQueue,
} from "@/services/api";
import { dispatchTransferIntentBestEffort } from "@/store/transfersBridge";
import { toast } from "@/components/ui";

describe("useSessionFileSystem — SFTP-backed transport (probe resolves)", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    vi.clearAllMocks();
    // Resolve → the session is SFTP-backed (the boolean is exec capability).
    vi.mocked(sessionHasExecCapability).mockResolvedValue(true);
    // SFTP is queue-capable, so download/upload route through the queue engine.
    vi.mocked(sessionSupportsTransferQueue).mockResolvedValue(true);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  type SessionFs = ReturnType<typeof useSessionFileSystem>;

  async function mountHook(): Promise<SessionFs> {
    useAppStore.setState({ sessionFileBrowserId: "ssh-1" });
    seedFileBrowsers({
      session: { path: "/remote/dir", entries: [], loading: false, error: null },
    });
    let api: SessionFs | undefined;
    function Harness() {
      api = useSessionFileSystem();
      return null;
    }
    await act(async () => {
      root.render(React.createElement(Harness));
    });
    // Flush the capability probe so sftpCapable settles before the action runs.
    await act(async () => {
      await Promise.resolve();
    });
    return api!;
  }

  it("routes downloadFile through the dedicated session_download channel", async () => {
    const api = await mountHook();
    await act(async () => {
      await api.downloadFile("/remote/dir/file.txt", "file.txt");
    });
    expect(vi.mocked(sessionDownload)).toHaveBeenCalledWith(
      "ssh-1",
      "/remote/dir/file.txt",
      "/local/save.txt",
      expect.any(Function)
    );
    expect(vi.mocked(sessionReadFile)).not.toHaveBeenCalled();
  });

  it("routes uploadFileFromPath through the dedicated session_upload channel", async () => {
    const api = await mountHook();
    await act(async () => {
      await api.uploadFileFromPath("/local/data.csv");
    });
    expect(vi.mocked(sessionUpload)).toHaveBeenCalledWith(
      "ssh-1",
      "/local/data.csv",
      "/remote/dir/data.csv",
      expect.any(Function)
    );
  });

  it("wires openInVscode to session_vscode_open_remote", async () => {
    const api = await mountHook();
    await act(async () => {
      await api.openInVscode("/remote/dir/file.txt");
    });
    expect(vi.mocked(sessionVscodeOpenRemote)).toHaveBeenCalledWith(
      "ssh-1",
      "/remote/dir/file.txt"
    );
  });

  // PROD-0013: a session→session copy between two SFTP-backed sessions streams
  // directly source→destination through the desktop as ONE tracked transfer —
  // no local temp file, no byte round-trip. This replaces the pre-PROD-0013
  // download-to-temp + upload dance (two rows + a local disk copy, #2469). The
  // single row seeds the region-fed queue keyed on the destination, with the
  // destination remote path (#1531) and user-facing file name (#1573).
  it("routes an SFTP session→session copy through a single direct remote copy", async () => {
    // sessionCopyRemote seeds the queue only once the backend returns the
    // transfer id (onRegistered), so fire it to exercise the seed path.
    vi.mocked(sessionCopyRemote).mockImplementation(async (_ss, _sp, _ds, _dp, onRegistered) => {
      onRegistered?.("t-copy");
      return 0;
    });

    const api = await mountHook();
    useAppStore.getState().setFileClipboard({
      entries: [
        {
          name: "file.bin",
          path: "/remote/src/file.bin",
          isDirectory: false,
          size: 10,
          modified: "",
          permissions: null,
          writable: null,
        },
      ],
      operation: "copy",
      sourceMode: "session",
      sourcePath: "/remote/src",
      terminalSessionId: "ssh-1",
    });

    await act(async () => {
      await api.pasteEntry();
    });

    // ONE direct source→destination copy — no temp download/upload legs.
    expect(vi.mocked(sessionCopyRemote)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sessionCopyRemote)).toHaveBeenCalledWith(
      "ssh-1",
      "/remote/src/file.bin",
      "ssh-1",
      "/remote/dir/file.bin",
      expect.any(Function)
    );
    expect(vi.mocked(sessionDownload)).not.toHaveBeenCalled();
    expect(vi.mocked(sessionUpload)).not.toHaveBeenCalled();

    // Exactly one tracked row, keyed on the destination (where the file lands),
    // named/pathed from the destination remote path — not a temp copy.
    expect(vi.mocked(dispatchTransferIntentBestEffort)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(dispatchTransferIntentBestEffort)).toHaveBeenCalledWith("transfer.seed", {
      seed: {
        id: "t-copy",
        sessionId: "ssh-1",
        direction: "upload",
        name: "file.bin",
        path: "/remote/dir/file.bin",
      },
    });

    // No local staging file, and the byte round-trip is not used.
    expect(vi.mocked(sessionReadFile)).not.toHaveBeenCalled();

    // #2906: the tracked SFTP path defers its terminal toast to the
    // transfer-progress event path, so the paste helper must NOT raise its own
    // success toast (no double-toast).
    expect(vi.mocked(toast.success)).not.toHaveBeenCalled();
  });

  // A cross-session SFTP↔SFTP paste routes the direct copy between the two
  // distinct sessions (source id ≠ destination id) exactly once (PROD-0013).
  it("routes a cross-session SFTP copy directly between the two sessions", async () => {
    vi.mocked(sessionCopyRemote).mockResolvedValue(0);

    const api = await mountHook();
    useAppStore.getState().setFileClipboard({
      entries: [
        {
          name: "file.bin",
          path: "/remote/src/file.bin",
          isDirectory: false,
          size: 10,
          modified: "",
          permissions: null,
          writable: null,
        },
      ],
      operation: "copy",
      sourceMode: "session",
      sourcePath: "/remote/src",
      terminalSessionId: "ssh-src",
    });

    await act(async () => {
      await api.pasteEntry();
    });

    // Cross-session: read from ssh-src, write to the active ssh-1 destination.
    expect(vi.mocked(sessionCopyRemote)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sessionCopyRemote)).toHaveBeenCalledWith(
      "ssh-src",
      "/remote/src/file.bin",
      "ssh-1",
      "/remote/dir/file.bin",
      expect.any(Function)
    );
    expect(vi.mocked(sessionReadFile)).not.toHaveBeenCalled();
  });
});

describe("useSessionFileSystem — byte-based transport (probe rejects)", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    vi.clearAllMocks();
    // Reject → the session is byte-based (Docker / agent).
    vi.mocked(sessionHasExecCapability).mockRejectedValue(new Error("not sftp-backed"));
    // Not queue-capable → transfers use the blocking byte-based fallback.
    vi.mocked(sessionSupportsTransferQueue).mockResolvedValue(false);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  type SessionFs = ReturnType<typeof useSessionFileSystem>;

  async function mountHook(): Promise<SessionFs> {
    useAppStore.setState({ sessionFileBrowserId: "docker-1" });
    seedFileBrowsers({
      session: { path: "/remote/dir", entries: [], loading: false, error: null },
    });
    let api: SessionFs | undefined;
    function Harness() {
      api = useSessionFileSystem();
      return null;
    }
    await act(async () => {
      root.render(React.createElement(Harness));
    });
    await act(async () => {
      await Promise.resolve();
    });
    return api!;
  }

  it("falls back to session_read_file for downloadFile (no dedicated channel)", async () => {
    const api = await mountHook();
    await act(async () => {
      await api.downloadFile("/remote/dir/file.txt", "file.txt");
    });
    expect(vi.mocked(sessionReadFile)).toHaveBeenCalledWith("docker-1", "/remote/dir/file.txt");
    expect(vi.mocked(sessionDownload)).not.toHaveBeenCalled();
  });

  // UX-017: a byte-based download is a blocking round-trip with no
  // transfer-progress event, so it must surface its own success/error toast.
  it("surfaces a success toast when a byte-based download succeeds", async () => {
    const api = await mountHook();
    await act(async () => {
      await api.downloadFile("/remote/dir/file.txt", "file.txt");
    });
    expect(vi.mocked(toast.success)).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(toast.success).mock.calls[0][0])).toContain("file.txt");
    expect(vi.mocked(toast.error)).not.toHaveBeenCalled();
  });

  it("surfaces an error toast when a byte-based download fails", async () => {
    vi.mocked(sessionReadFile).mockRejectedValueOnce(new Error("permission denied"));
    const api = await mountHook();
    await act(async () => {
      await api.downloadFile("/remote/dir/file.txt", "file.txt");
    });
    expect(vi.mocked(toast.success)).not.toHaveBeenCalled();
    expect(vi.mocked(toast.error)).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(toast.error).mock.calls[0][0])).toContain("permission denied");
  });

  it("makes openInVscode a no-op (VS Code remote open unavailable)", async () => {
    const api = await mountHook();
    await act(async () => {
      await api.openInVscode("/remote/dir/file.txt");
    });
    expect(vi.mocked(sessionVscodeOpenRemote)).not.toHaveBeenCalled();
  });

  // #2906: a byte-based upload is a blocking round-trip with no
  // transfer-progress event, so it must surface its own success/error toast
  // rather than completing silently.
  it("surfaces a success toast when a byte-based upload succeeds", async () => {
    const api = await mountHook();
    await act(async () => {
      await api.uploadFileFromPath("/local/data.csv");
    });
    expect(vi.mocked(sessionWriteFile)).toHaveBeenCalledWith(
      "docker-1",
      "/remote/dir/data.csv",
      expect.any(Uint8Array)
    );
    expect(vi.mocked(toast.success)).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(toast.success).mock.calls[0][0])).toContain("data.csv");
    expect(vi.mocked(toast.error)).not.toHaveBeenCalled();
  });

  it("surfaces an error toast when a byte-based upload fails", async () => {
    vi.mocked(sessionWriteFile).mockRejectedValueOnce(new Error("disk full"));
    const api = await mountHook();
    await act(async () => {
      await api.uploadFileFromPath("/local/data.csv");
    });
    expect(vi.mocked(toast.success)).not.toHaveBeenCalled();
    expect(vi.mocked(toast.error)).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(toast.error).mock.calls[0][0])).toContain("disk full");
  });

  // #2906: a byte-based paste has no dedicated channel, so the previous
  // event-deferring wrapper left success silent — it must now toast itself.
  it("surfaces a success toast when a byte-based paste succeeds", async () => {
    const api = await mountHook();
    useAppStore.getState().setFileClipboard({
      entries: [
        {
          name: "file.bin",
          path: "/remote/src/file.bin",
          isDirectory: false,
          size: 10,
          modified: "",
          permissions: null,
          writable: null,
        },
      ],
      operation: "copy",
      sourceMode: "session",
      sourcePath: "/remote/src",
      terminalSessionId: "docker-1",
    });

    await act(async () => {
      await api.pasteEntry();
    });

    expect(vi.mocked(sessionWriteFile)).toHaveBeenCalledWith(
      "docker-1",
      "/remote/dir/file.bin",
      expect.any(Uint8Array)
    );
    expect(vi.mocked(toast.success)).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(toast.success).mock.calls[0][0])).toContain("file.bin");
    expect(vi.mocked(toast.error)).not.toHaveBeenCalled();
  });

  it("surfaces an error toast when a byte-based paste fails", async () => {
    vi.mocked(sessionReadFile).mockRejectedValueOnce(new Error("no such file"));
    const api = await mountHook();
    useAppStore.getState().setFileClipboard({
      entries: [
        {
          name: "file.bin",
          path: "/remote/src/file.bin",
          isDirectory: false,
          size: 10,
          modified: "",
          permissions: null,
          writable: null,
        },
      ],
      operation: "copy",
      sourceMode: "session",
      sourcePath: "/remote/src",
      terminalSessionId: "docker-1",
    });

    await act(async () => {
      await api.pasteEntry();
    });

    expect(vi.mocked(toast.success)).not.toHaveBeenCalled();
    expect(vi.mocked(toast.error)).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(toast.error).mock.calls[0][0])).toContain("no such file");
  });

  // #3458: a failed plain paste must resolve (never an unhandled rejection),
  // report the typed error, and keep a cut clipboard so the user can retry.
  it("resolves a failed same-session cut paste and keeps the cut clipboard", async () => {
    vi.mocked(sessionRenameFile).mockRejectedValueOnce(new Error("permission denied"));
    const api = await mountHook();
    useAppStore.getState().setFileClipboard({
      entries: [
        {
          name: "file.bin",
          path: "/remote/src/file.bin",
          isDirectory: false,
          size: 10,
          modified: "",
          permissions: null,
          writable: null,
        },
      ],
      operation: "cut",
      sourceMode: "session",
      sourcePath: "/remote/src",
      terminalSessionId: "docker-1",
    });

    await act(async () => {
      await expect(api.pasteEntry()).resolves.toBeUndefined();
    });

    expect(vi.mocked(toast.error)).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(toast.error).mock.calls[0][0])).toContain("permission denied");
    expect(currentFileBrowsersView().clipboard?.operation).toBe("cut");
  });

  // #3458: a file picker that fails to open is reported, not rejected unhandled.
  it("reports an upload file picker that fails to open", async () => {
    const { open } = await import("@tauri-apps/plugin-dialog");
    vi.mocked(open).mockRejectedValueOnce(new Error("dialog unavailable"));
    const api = await mountHook();
    await act(async () => {
      await expect(api.uploadFile()).resolves.toBeUndefined();
    });
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith("Upload failed: dialog unavailable");
    expect(vi.mocked(sessionWriteFile)).not.toHaveBeenCalled();
  });

  // #2469: a byte-based backend has no dedicated transfer channel, so a
  // session→session copy stays a read/write round-trip (no tracked transfer).
  it("falls back to read/write for a session→session copy (no tracked transfer)", async () => {
    const api = await mountHook();
    useAppStore.getState().setFileClipboard({
      entries: [
        {
          name: "file.bin",
          path: "/remote/src/file.bin",
          isDirectory: false,
          size: 10,
          modified: "",
          permissions: null,
          writable: null,
        },
      ],
      operation: "copy",
      sourceMode: "session",
      sourcePath: "/remote/src",
      terminalSessionId: "docker-1",
    });

    await act(async () => {
      await api.pasteEntry();
    });

    expect(vi.mocked(sessionReadFile)).toHaveBeenCalledWith("docker-1", "/remote/src/file.bin");
    expect(vi.mocked(sessionWriteFile)).toHaveBeenCalledWith(
      "docker-1",
      "/remote/dir/file.bin",
      expect.any(Uint8Array)
    );
    expect(vi.mocked(sessionDownload)).not.toHaveBeenCalled();
    expect(vi.mocked(sessionUpload)).not.toHaveBeenCalled();
  });
});

// ── Mutation wiring: each transport-agnostic action targets the session id ─────
// createDirectory / createFile / delete / rename / setPermissions and the
// clipboard actions behave identically regardless of SFTP capability, so they
// are exercised once with a resolved (SFTP-backed) probe.
import {
  sessionMkdir,
  sessionDeleteFile,
  sessionRenameFile,
  sessionSetPermissions,
} from "@/services/api";

describe("useSessionFileSystem — mutation + clipboard wiring", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  type SessionFs = ReturnType<typeof useSessionFileSystem>;

  async function mountHook(path = "/remote/dir"): Promise<SessionFs> {
    useAppStore.setState({ sessionFileBrowserId: "ssh-1" });
    seedFileBrowsers({ session: { path, entries: [], loading: false, error: null } });
    let api: SessionFs | undefined;
    function Harness() {
      api = useSessionFileSystem();
      return null;
    }
    await act(async () => {
      root.render(React.createElement(Harness));
    });
    await act(async () => {
      await Promise.resolve();
    });
    return api!;
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    vi.clearAllMocks();
    vi.mocked(sessionHasExecCapability).mockResolvedValue(true);
    vi.mocked(sessionSupportsTransferQueue).mockResolvedValue(true);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("supportsPermissions tracks the resolved SFTP-backed probe", async () => {
    const api = await mountHook();
    expect(api.isConnected).toBe(true);
    expect(api.supportsPermissions).toBe(true);
  });

  it("createDirectory calls sessionMkdir with the joined remote path", async () => {
    const api = await mountHook("/remote/dir");
    await act(async () => {
      await api.createDirectory("sub");
    });
    expect(vi.mocked(sessionMkdir)).toHaveBeenCalledWith("ssh-1", "/remote/dir/sub");
  });

  it("createFile writes an empty byte array at the joined remote path", async () => {
    const api = await mountHook("/remote/dir");
    await act(async () => {
      await api.createFile("empty.txt");
    });
    expect(vi.mocked(sessionWriteFile)).toHaveBeenCalledWith("ssh-1", "/remote/dir/empty.txt", []);
  });

  it("deleteEntry forwards the path to sessionDeleteFile", async () => {
    const api = await mountHook();
    await act(async () => {
      await api.deleteEntry("/remote/dir/old", false);
    });
    expect(vi.mocked(sessionDeleteFile)).toHaveBeenCalledWith("ssh-1", "/remote/dir/old");
  });

  it("renameEntry rebuilds the sibling path from the parent directory", async () => {
    const api = await mountHook();
    await act(async () => {
      await api.renameEntry("/remote/dir/old.txt", "new.txt");
    });
    expect(vi.mocked(sessionRenameFile)).toHaveBeenCalledWith(
      "ssh-1",
      "/remote/dir/old.txt",
      "/remote/dir/new.txt"
    );
  });

  it("setPermissions forwards session id, path and mode", async () => {
    const api = await mountHook();
    await act(async () => {
      await api.setPermissions("/remote/dir/script.sh", 0o750);
    });
    expect(vi.mocked(sessionSetPermissions)).toHaveBeenCalledWith(
      "ssh-1",
      "/remote/dir/script.sh",
      0o750
    );
  });

  it("copyEntry stores a session copy clipboard tagged with the session id", async () => {
    const api = await mountHook("/remote/dir");
    act(() => {
      api.copyEntry([
        {
          name: "a.txt",
          path: "/remote/dir/a.txt",
          isDirectory: false,
          size: 1,
          modified: "",
          permissions: null,
          writable: null,
        },
      ]);
    });
    const clip = currentFileBrowsersView().clipboard;
    expect(clip?.operation).toBe("copy");
    expect(clip?.sourceMode).toBe("session");
    expect(clip?.terminalSessionId).toBe("ssh-1");
    expect(clip?.sourcePath).toBe("/remote/dir");
  });

  it("cutEntry stores a session cut clipboard", async () => {
    const api = await mountHook("/remote/dir");
    act(() => {
      api.cutEntry([
        {
          name: "a.txt",
          path: "/remote/dir/a.txt",
          isDirectory: false,
          size: 1,
          modified: "",
          permissions: null,
          writable: null,
        },
      ]);
    });
    expect(currentFileBrowsersView().clipboard?.operation).toBe("cut");
  });

  it("pasteEntry moves a same-session cut via a single sessionRenameFile", async () => {
    const api = await mountHook("/remote/dir");
    useAppStore.getState().setFileClipboard({
      entries: [
        {
          name: "a.txt",
          path: "/remote/src/a.txt",
          isDirectory: false,
          size: 1,
          modified: "",
          permissions: null,
          writable: null,
        },
      ],
      operation: "cut",
      sourceMode: "session",
      sourcePath: "/remote/src",
      terminalSessionId: "ssh-1",
    });
    await act(async () => {
      await api.pasteEntry();
    });
    expect(vi.mocked(sessionRenameFile)).toHaveBeenCalledWith(
      "ssh-1",
      "/remote/src/a.txt",
      "/remote/dir/a.txt"
    );
    expect(currentFileBrowsersView().clipboard).toBeNull();
  });

  it("pasteEntry with an explicit clipboard + destDir renames into that folder and keeps the user clipboard", async () => {
    const api = await mountHook("/remote/dir");
    useAppStore.getState().setFileClipboard(null);
    await act(async () => {
      await api.pasteEntry({
        clipboard: {
          entries: [
            {
              name: "a.txt",
              path: "/remote/dir/a.txt",
              isDirectory: false,
              size: 1,
              modified: "",
              permissions: null,
              writable: null,
            },
          ],
          operation: "cut",
          sourceMode: "session",
          sourcePath: "/remote/dir",
          terminalSessionId: "ssh-1",
        },
        destDir: "/remote/dir/sub",
        verb: "Move",
      });
    });
    expect(vi.mocked(sessionRenameFile)).toHaveBeenCalledWith(
      "ssh-1",
      "/remote/dir/a.txt",
      "/remote/dir/sub/a.txt"
    );
    expect(currentFileBrowsersView().clipboard).toBeNull();
  });

  it("pasteEntry uploads a local→session clipboard over the SFTP channel", async () => {
    const api = await mountHook("/remote/dir");
    useAppStore.getState().setFileClipboard({
      entries: [
        {
          name: "a.txt",
          path: "/local/a.txt",
          isDirectory: false,
          size: 1,
          modified: "",
          permissions: null,
          writable: null,
        },
      ],
      operation: "copy",
      sourceMode: "local",
      sourcePath: "/local",
    });
    await act(async () => {
      await api.pasteEntry();
    });
    expect(vi.mocked(sessionUpload)).toHaveBeenCalledWith(
      "ssh-1",
      "/local/a.txt",
      "/remote/dir/a.txt",
      expect.any(Function)
    );
  });

  it("navigateTo commits the target path to the session pane", async () => {
    const api = await mountHook("/remote/dir");
    await act(async () => {
      api.navigateTo("/remote/other");
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(currentFileBrowsersView().session.path).toBe("/remote/other");
  });
});

// PROD-010: an FTP session is a queue-capable byte backend — the exec probe
// REJECTS (it is not SFTP-backed, so no VS Code / chmod), but the
// session_supports_transfer_queue probe RESOLVES true, so download/upload route
// through the rich queue engine (session_download / session_upload) exactly like
// SFTP rather than the blocking byte-based fallback. Critically, the frontend
// passes only the session id + paths — never the FTP config/credentials, which
// the backend resolves server-side.
describe("useSessionFileSystem — FTP transport (queue-capable, not SFTP)", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    vi.clearAllMocks();
    // Not SFTP-backed → no exec channel (no VS Code / chmod)…
    vi.mocked(sessionHasExecCapability).mockRejectedValue(new Error("not sftp-backed"));
    // …but FTP IS queue-capable → download/upload use the rich queue engine.
    vi.mocked(sessionSupportsTransferQueue).mockResolvedValue(true);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  type SessionFs = ReturnType<typeof useSessionFileSystem>;

  async function mountHook(): Promise<SessionFs> {
    useAppStore.setState({ sessionFileBrowserId: "ftp-1" });
    seedFileBrowsers({
      session: { path: "/remote/dir", entries: [], loading: false, error: null },
    });
    let api: SessionFs | undefined;
    function Harness() {
      api = useSessionFileSystem();
      return null;
    }
    await act(async () => {
      root.render(React.createElement(Harness));
    });
    // Flush both capability probes so transferQueueCapable settles.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    return api!;
  }

  it("routes downloadFile through the queue engine (session_download), not the byte fallback", async () => {
    const api = await mountHook();
    await act(async () => {
      await api.downloadFile("/remote/dir/file.txt", "file.txt");
    });
    // Queue path, with only session id + paths — no FTP config/credentials.
    expect(vi.mocked(sessionDownload)).toHaveBeenCalledWith(
      "ftp-1",
      "/remote/dir/file.txt",
      "/local/save.txt",
      expect.any(Function)
    );
    expect(vi.mocked(sessionDownload).mock.calls[0]).toHaveLength(4);
    expect(vi.mocked(sessionReadFile)).not.toHaveBeenCalled();
  });

  it("routes uploadFileFromPath through the queue engine (session_upload), not the byte fallback", async () => {
    const api = await mountHook();
    await act(async () => {
      await api.uploadFileFromPath("/local/data.csv");
    });
    expect(vi.mocked(sessionUpload)).toHaveBeenCalledWith(
      "ftp-1",
      "/local/data.csv",
      "/remote/dir/data.csv",
      expect.any(Function)
    );
    // Only session id + paths cross the boundary — never the FTP config.
    expect(vi.mocked(sessionUpload).mock.calls[0]).toHaveLength(4);
    expect(vi.mocked(sessionWriteFile)).not.toHaveBeenCalled();
  });

  it("routes a local→session paste upload through the queue engine", async () => {
    const api = await mountHook();
    useAppStore.getState().setFileClipboard({
      entries: [
        {
          name: "a.txt",
          path: "/local/a.txt",
          isDirectory: false,
          size: 1,
          modified: "",
          permissions: null,
          writable: null,
        },
      ],
      operation: "copy",
      sourceMode: "local",
      sourcePath: "/local",
    });
    await act(async () => {
      await api.pasteEntry();
    });
    expect(vi.mocked(sessionUpload)).toHaveBeenCalledWith(
      "ftp-1",
      "/local/a.txt",
      "/remote/dir/a.txt",
      expect.any(Function)
    );
    expect(vi.mocked(sessionWriteFile)).not.toHaveBeenCalled();
  });

  it("leaves VS Code remote open unavailable (FTP is not SFTP-backed)", async () => {
    const api = await mountHook();
    await act(async () => {
      await api.openInVscode("/remote/dir/file.txt");
    });
    expect(vi.mocked(sessionVscodeOpenRemote)).not.toHaveBeenCalled();
    // chmod/chown/symlink stay SFTP-only.
    expect(api.supportsPermissions).toBe(false);
  });
});

// PROD-004: pasting a DIRECTORY must copy the whole subtree, not silently drop
// its contents. Same-backend copies route through the recursive server-side
// `copy()` capability (#3201, `session_copy`); cross-session / byte-based /
// local→session pastes recreate the destination tree (`session_mkdir`) and copy
// each child, reusing the session transfer queue (#3237).
import { sessionCopy, sessionListFiles, localListDir } from "@/services/api";
import type { FileEntry } from "@/types/connection";

function dirEntry(name: string, path: string): FileEntry {
  return {
    name,
    path,
    isDirectory: true,
    size: 0,
    modified: "",
    permissions: null,
    writable: null,
  };
}
function fileEntry(name: string, path: string): FileEntry {
  return {
    name,
    path,
    isDirectory: false,
    size: 1,
    modified: "",
    permissions: null,
    writable: null,
  };
}

describe("useSessionFileSystem — recursive directory paste (PROD-004)", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  type SessionFs = ReturnType<typeof useSessionFileSystem>;

  async function mountHook(sessionId: string): Promise<SessionFs> {
    useAppStore.setState({ sessionFileBrowserId: sessionId });
    seedFileBrowsers({
      session: { path: "/remote/dir", entries: [], loading: false, error: null },
    });
    let api: SessionFs | undefined;
    function Harness() {
      api = useSessionFileSystem();
      return null;
    }
    await act(async () => {
      root.render(React.createElement(Harness));
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    return api!;
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    vi.clearAllMocks();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("routes a same-session SFTP directory copy through the recursive copy() capability", async () => {
    vi.mocked(sessionHasExecCapability).mockResolvedValue(true);
    vi.mocked(sessionSupportsTransferQueue).mockResolvedValue(true);
    const api = await mountHook("ssh-1");
    useAppStore.getState().setFileClipboard({
      entries: [dirEntry("folder", "/remote/src/folder")],
      operation: "copy",
      sourceMode: "session",
      sourcePath: "/remote/src",
      terminalSessionId: "ssh-1",
    });

    await act(async () => {
      await api.pasteEntry();
    });

    // ONE server-side recursive copy — no per-file enumeration, no single-file
    // stream of the directory path (the pre-fix silent-skip bug).
    expect(vi.mocked(sessionCopy)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sessionCopy)).toHaveBeenCalledWith(
      "ssh-1",
      "/remote/src/folder",
      "/remote/dir/folder"
    );
    expect(vi.mocked(sessionCopyRemote)).not.toHaveBeenCalled();
    expect(vi.mocked(sessionReadFile)).not.toHaveBeenCalled();
    // The source directory is never enumerated — the copy is one server-side op.
    // (A post-paste refresh may list the *destination* dir, which is fine.)
    expect(vi.mocked(sessionListFiles)).not.toHaveBeenCalledWith(
      expect.anything(),
      "/remote/src/folder"
    );
    // Untracked single op → the paste helper owns the success toast.
    expect(vi.mocked(toast.success)).toHaveBeenCalledTimes(1);
  });

  it("recursively copies a cross-session SFTP directory, recreating the tree and copying each file", async () => {
    vi.mocked(sessionHasExecCapability).mockResolvedValue(true);
    vi.mocked(sessionSupportsTransferQueue).mockResolvedValue(true);
    vi.mocked(sessionCopyRemote).mockResolvedValue(0);
    vi.mocked(sessionListFiles).mockImplementation(async (_id, path) => {
      if (path === "/remote/src/folder") {
        return [
          fileEntry("a.txt", "/remote/src/folder/a.txt"),
          dirEntry("sub", "/remote/src/folder/sub"),
        ];
      }
      if (path === "/remote/src/folder/sub") {
        return [fileEntry("b.txt", "/remote/src/folder/sub/b.txt")];
      }
      return [];
    });

    const api = await mountHook("ssh-1");
    useAppStore.getState().setFileClipboard({
      entries: [dirEntry("folder", "/remote/src/folder")],
      operation: "copy",
      sourceMode: "session",
      sourcePath: "/remote/src",
      terminalSessionId: "ssh-src",
    });

    await act(async () => {
      await api.pasteEntry();
    });

    // No same-backend fast path across two sessions.
    expect(vi.mocked(sessionCopy)).not.toHaveBeenCalled();
    // Destination tree recreated.
    expect(vi.mocked(sessionMkdir)).toHaveBeenCalledWith("ssh-1", "/remote/dir/folder");
    expect(vi.mocked(sessionMkdir)).toHaveBeenCalledWith("ssh-1", "/remote/dir/folder/sub");
    // Each file streamed directly source→destination (both SFTP-backed).
    expect(vi.mocked(sessionCopyRemote)).toHaveBeenCalledWith(
      "ssh-src",
      "/remote/src/folder/a.txt",
      "ssh-1",
      "/remote/dir/folder/a.txt",
      expect.any(Function)
    );
    expect(vi.mocked(sessionCopyRemote)).toHaveBeenCalledWith(
      "ssh-src",
      "/remote/src/folder/sub/b.txt",
      "ssh-1",
      "/remote/dir/folder/sub/b.txt",
      expect.any(Function)
    );
  });

  it("recursively copies a same-session directory over a byte-based backend via read/write", async () => {
    vi.mocked(sessionHasExecCapability).mockRejectedValue(new Error("not sftp-backed"));
    vi.mocked(sessionSupportsTransferQueue).mockResolvedValue(false);
    vi.mocked(sessionListFiles).mockImplementation(async (_id, path) => {
      if (path === "/remote/src/folder") return [fileEntry("a.txt", "/remote/src/folder/a.txt")];
      return [];
    });

    const api = await mountHook("docker-1");
    useAppStore.getState().setFileClipboard({
      entries: [dirEntry("folder", "/remote/src/folder")],
      operation: "copy",
      sourceMode: "session",
      sourcePath: "/remote/src",
      terminalSessionId: "docker-1",
    });

    await act(async () => {
      await api.pasteEntry();
    });

    // Byte backends have no server-side copy(); recurse via mkdir + read/write.
    expect(vi.mocked(sessionCopy)).not.toHaveBeenCalled();
    expect(vi.mocked(sessionMkdir)).toHaveBeenCalledWith("docker-1", "/remote/dir/folder");
    expect(vi.mocked(sessionReadFile)).toHaveBeenCalledWith("docker-1", "/remote/src/folder/a.txt");
    expect(vi.mocked(sessionWriteFile)).toHaveBeenCalledWith(
      "docker-1",
      "/remote/dir/folder/a.txt",
      expect.any(Uint8Array)
    );
  });

  it("recursively uploads a local directory, recreating the tree and uploading each file", async () => {
    vi.mocked(sessionHasExecCapability).mockResolvedValue(true);
    vi.mocked(sessionSupportsTransferQueue).mockResolvedValue(true);
    vi.mocked(localListDir).mockImplementation(async (path) => {
      if (path === "/local/proj") return [fileEntry("x.txt", "/local/proj/x.txt")];
      return [];
    });

    const api = await mountHook("ssh-1");
    useAppStore.getState().setFileClipboard({
      entries: [dirEntry("proj", "/local/proj")],
      operation: "copy",
      sourceMode: "local",
      sourcePath: "/local",
    });

    await act(async () => {
      await api.pasteEntry();
    });

    expect(vi.mocked(sessionMkdir)).toHaveBeenCalledWith("ssh-1", "/remote/dir/proj");
    expect(vi.mocked(localListDir)).toHaveBeenCalledWith("/local/proj");
    // Queue-capable destination → each local file uploads via session_upload.
    expect(vi.mocked(sessionUpload)).toHaveBeenCalledWith(
      "ssh-1",
      "/local/proj/x.txt",
      "/remote/dir/proj/x.txt",
      expect.any(Function)
    );
  });
});
