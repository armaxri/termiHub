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
  localListDir: vi.fn(),
  vscodeAvailable: vi.fn(() => Promise.resolve(false)),
  sessionReadFile: vi.fn(() => Promise.resolve([])),
  sessionWriteFile: vi.fn(() => Promise.resolve()),
  sessionDeleteFile: vi.fn(() => Promise.resolve()),
  sessionRenameFile: vi.fn(() => Promise.resolve()),
  sessionMkdir: vi.fn(() => Promise.resolve()),
  sessionDownload: vi.fn(() => Promise.resolve(0)),
  sessionUpload: vi.fn(() => Promise.resolve(0)),
  sessionVscodeOpenRemote: vi.fn(() => Promise.resolve()),
  localDelete: vi.fn(() => Promise.resolve()),
  // Default: reject → session is byte-based (Docker / FTP / agent). The
  // SFTP-backed suite overrides this to resolve.
  sessionHasExecCapability: vi.fn(() => Promise.reject(new Error("not sftp-backed"))),
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
import {
  seedFileBrowsers,
  setupFileBrowsersRegion,
} from "@/test/fileBrowsersRegionTestHarness";

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
    seedFileBrowsers({ session: { path: "/remote/dir", entries: [], loading: false, error: null } });

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
      expect.any(Array)
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
      expect.any(Array)
    );
  });

  it("does nothing when sessionFileBrowserId is null", async () => {
    useAppStore.setState({ sessionFileBrowserId: null });
    seedFileBrowsers({ session: { path: "/remote/dir", entries: [], loading: false, error: null } });

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
  sessionVscodeOpenRemote,
  sessionReadFile,
  sessionHasExecCapability,
  localDelete,
} from "@/services/api";
import { dispatchTransferIntentBestEffort } from "@/store/transfersBridge";

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
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  type SessionFs = ReturnType<typeof useSessionFileSystem>;

  async function mountHook(): Promise<SessionFs> {
    useAppStore.setState({ sessionFileBrowserId: "ssh-1" });
    seedFileBrowsers({ session: { path: "/remote/dir", entries: [], loading: false, error: null } });
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

  // #2469: a session→session copy between two SFTP-backed sessions must route
  // through the dedicated download + upload transfer channel (via a local temp
  // file), so it registers two tracked Transfer Queue rows instead of a silent
  // byte round-trip. Both halves seed the region-fed queue with the remote path
  // (#1531) and the user-facing file name (#1573), never the temp copy.
  it("routes an SFTP session→session copy through tracked download + upload", async () => {
    // The start commands seed the queue only once the backend returns the
    // transfer id (onRegistered), so fire it to exercise the seed path.
    vi.mocked(sessionDownload).mockImplementation(async (_s, _r, _l, onRegistered) => {
      onRegistered?.("t-dl");
      return 0;
    });
    vi.mocked(sessionUpload).mockImplementation(async (_s, _l, _r, onRegistered) => {
      onRegistered?.("t-ul");
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

    // Download the source to a local temp copy, then upload the temp copy to the
    // destination — the two tracked transfers the queue renders.
    expect(vi.mocked(sessionDownload)).toHaveBeenCalledWith(
      "ssh-1",
      "/remote/src/file.bin",
      expect.stringMatching(/termihub-paste-\d+-file\.bin$/),
      expect.any(Function)
    );
    expect(vi.mocked(sessionUpload)).toHaveBeenCalledWith(
      "ssh-1",
      expect.stringMatching(/termihub-paste-\d+-file\.bin$/),
      "/remote/dir/file.bin",
      expect.any(Function)
    );

    // Both halves seed a tracked row: the download names/paths the source, the
    // upload names/paths the destination — both the user-facing name, not temp.
    expect(vi.mocked(dispatchTransferIntentBestEffort)).toHaveBeenCalledWith("transfer.seed", {
      seed: {
        id: "t-dl",
        sessionId: "ssh-1",
        direction: "download",
        name: "file.bin",
        path: "/remote/src/file.bin",
      },
    });
    expect(vi.mocked(dispatchTransferIntentBestEffort)).toHaveBeenCalledWith("transfer.seed", {
      seed: {
        id: "t-ul",
        sessionId: "ssh-1",
        direction: "upload",
        name: "file.bin",
        path: "/remote/dir/file.bin",
      },
    });

    // The local temp copy is cleaned up, and the byte round-trip is not used.
    expect(vi.mocked(localDelete)).toHaveBeenCalledWith(
      expect.stringMatching(/termihub-paste-\d+-file\.bin$/),
      false
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
    // Reject → the session is byte-based (Docker / FTP / agent).
    vi.mocked(sessionHasExecCapability).mockRejectedValue(new Error("not sftp-backed"));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  type SessionFs = ReturnType<typeof useSessionFileSystem>;

  async function mountHook(): Promise<SessionFs> {
    useAppStore.setState({ sessionFileBrowserId: "docker-1" });
    seedFileBrowsers({ session: { path: "/remote/dir", entries: [], loading: false, error: null } });
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

  it("makes openInVscode a no-op (VS Code remote open unavailable)", async () => {
    const api = await mountHook();
    await act(async () => {
      await api.openInVscode("/remote/dir/file.txt");
    });
    expect(vi.mocked(sessionVscodeOpenRemote)).not.toHaveBeenCalled();
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
      expect.any(Array)
    );
    expect(vi.mocked(sessionDownload)).not.toHaveBeenCalled();
    expect(vi.mocked(sessionUpload)).not.toHaveBeenCalled();
  });
});
