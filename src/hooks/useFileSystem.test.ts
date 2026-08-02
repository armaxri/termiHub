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
  sftpListDir: vi.fn(() => Promise.resolve([])),
  localListDir: vi.fn(),
  vscodeAvailable: vi.fn(() => Promise.resolve(false)),
  sftpDownload: vi.fn(() => Promise.resolve()),
  sftpUpload: vi.fn(() => Promise.resolve()),
  sftpMkdir: vi.fn(() => Promise.resolve()),
  sftpDelete: vi.fn(() => Promise.resolve()),
  sftpRename: vi.fn(() => Promise.resolve()),
  sftpWriteFileContent: vi.fn(() => Promise.resolve()),
  vscodeOpenRemote: vi.fn(() => Promise.resolve()),
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
  save: vi.fn(() => Promise.resolve(null)),
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

// Test the SFTP navigateUp path logic — same algorithm as the local version,
// but without Windows drive-root handling.
function navigateUpSftp(currentPath: string): string | null {
  if (currentPath === "/") return null; // no-op
  const parentPath = currentPath.split("/").slice(0, -1).join("/") || "/";
  return parentPath;
}

describe("useFileSystem (SFTP) — navigateUp path logic", () => {
  it("navigates up from a nested path", () => {
    expect(navigateUpSftp("/home/user/documents")).toBe("/home/user");
  });

  it("navigates up from a single-depth path", () => {
    expect(navigateUpSftp("/home")).toBe("/");
  });

  it("returns null (no-op) at root /", () => {
    expect(navigateUpSftp("/")).toBeNull();
  });

  it("navigates up from deeply nested path", () => {
    expect(navigateUpSftp("/var/log/nginx/access")).toBe("/var/log/nginx");
  });
});

// Pure logic tests for uploadFileFromPath remote path building
function buildSftpRemotePath(currentPath: string, localPath: string): string {
  const parts = localPath.replace(/\\/g, "/").split("/");
  const fileName = parts[parts.length - 1] || "upload";
  return currentPath === "/" ? `/${fileName}` : `${currentPath}/${fileName}`;
}

describe("useFileSystem (SFTP) — uploadFileFromPath path logic", () => {
  it("builds remote path at root", () => {
    expect(buildSftpRemotePath("/", "/home/user/report.pdf")).toBe("/report.pdf");
  });

  it("builds remote path in subdirectory", () => {
    expect(buildSftpRemotePath("/uploads", "/home/user/image.png")).toBe("/uploads/image.png");
  });

  it("handles Windows-style backslash local paths", () => {
    expect(buildSftpRemotePath("/remote", "C:\\Users\\Alice\\doc.txt")).toBe("/remote/doc.txt");
  });

  it("falls back to 'upload' when no filename segment", () => {
    expect(buildSftpRemotePath("/remote", "")).toBe("/remote/upload");
  });
});

import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { sftpUpload } from "@/services/api";
import { useFileSystem } from "./useFileSystem";
import { useAppStore } from "@/store/appStore";
import { currentTransfersView } from "@/store/transfersBridge";
import { installTransferHarness, type FakeTransferTransport } from "@/test/transferHarness";

describe("useFileSystem (SFTP) — uploadFileFromPath API call", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let transport: FakeTransferTransport;
  let teardown: () => void;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    ({ transport, teardown } = installTransferHarness());
    vi.clearAllMocks();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    teardown();
  });

  it("calls sftpUpload with the correct remote path", async () => {
    useAppStore.setState({ sftpSessionId: "sess-1", currentPath: "/uploads" });

    let uploadFn: ((path: string) => Promise<void>) | undefined;
    function Harness() {
      const { uploadFileFromPath } = useFileSystem();
      uploadFn = uploadFileFromPath;
      return null;
    }

    await act(async () => {
      root.render(React.createElement(Harness));
    });

    await act(async () => {
      await uploadFn!("/local/image.png");
    });

    expect(vi.mocked(sftpUpload)).toHaveBeenCalledWith(
      "sess-1",
      "/local/image.png",
      "/uploads/image.png",
      // Seed callback for the Transfer Queue row (#1632).
      expect.any(Function)
    );
  });

  it("calls sftpUpload with root-level remote path when currentPath is /", async () => {
    useAppStore.setState({ sftpSessionId: "sess-1", currentPath: "/" });

    let uploadFn: ((path: string) => Promise<void>) | undefined;
    function Harness() {
      const { uploadFileFromPath } = useFileSystem();
      uploadFn = uploadFileFromPath;
      return null;
    }

    await act(async () => {
      root.render(React.createElement(Harness));
    });

    await act(async () => {
      await uploadFn!("/local/report.pdf");
    });

    expect(vi.mocked(sftpUpload)).toHaveBeenCalledWith(
      "sess-1",
      "/local/report.pdf",
      "/report.pdf",
      // Seed callback for the Transfer Queue row (#1632).
      expect.any(Function)
    );
  });

  it("seeds a Transfer Queue row from the registration callback (#1632)", async () => {
    useAppStore.setState({ sftpSessionId: "sess-1", currentPath: "/uploads" });

    // Simulate the backend returning a transferId, but emitting NO
    // transfer-progress event (the memory-pressure drop). The row must still
    // appear in the authoritative region, proving panel-open no longer depends
    // on the event stream. The seed is a reliable `transfer.seed` intent (#2229).
    vi.mocked(sftpUpload).mockImplementationOnce(
      async (_sessionId, _localPath, remotePath, onRegistered) => {
        onRegistered?.("tid-1632");
        void remotePath;
        return 0;
      }
    );

    let uploadFn: ((path: string) => Promise<void>) | undefined;
    function Harness() {
      const { uploadFileFromPath } = useFileSystem();
      uploadFn = uploadFileFromPath;
      return null;
    }
    await act(async () => {
      root.render(React.createElement(Harness));
    });
    await act(async () => {
      await uploadFn!("/local/report.pdf");
      await Promise.resolve();
    });

    expect(transport.kinds()).toContain("transfer.seed");
    expect(currentTransfersView().queue["tid-1632"]).toMatchObject({
      id: "tid-1632",
      sessionId: "sess-1",
      direction: "upload",
      name: "report.pdf",
      path: "/uploads/report.pdf",
      state: "queued",
    });
  });

  it("does nothing when sftpSessionId is null", async () => {
    useAppStore.setState({ sftpSessionId: null, currentPath: "/uploads" });

    let uploadFn: ((path: string) => Promise<void>) | undefined;
    function Harness() {
      const { uploadFileFromPath } = useFileSystem();
      uploadFn = uploadFileFromPath;
      return null;
    }

    await act(async () => {
      root.render(React.createElement(Harness));
    });

    await act(async () => {
      await uploadFn!("/local/file.txt");
    });

    expect(vi.mocked(sftpUpload)).not.toHaveBeenCalled();
  });
});

describe("useFileSystem (SFTP) — store integration", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
  });

  it("navigateSftp updates currentPath when sftpSessionId is set", async () => {
    // navigateSftp requires an active session — set one before navigating
    useAppStore.setState({ sftpSessionId: "sftp-test-123" });
    await useAppStore.getState().navigateSftp("/remote/dir");
    expect(useAppStore.getState().currentPath).toBe("/remote/dir");
  });

  it("sftpSessionId starts as null", () => {
    expect(useAppStore.getState().sftpSessionId).toBeNull();
  });

  it("isConnected is false when sftpSessionId is null", () => {
    const { sftpSessionId } = useAppStore.getState();
    expect(sftpSessionId).toBeNull();
  });
});

// D2 (#1143): a failed transfer must surface an error to the user via toast
// rather than resolving silently or producing an unhandled rejection.
import { sftpDownload, TransferTerminalError } from "@/services/api";
import { open, save } from "@tauri-apps/plugin-dialog";
import { toast } from "@/components/ui";

describe("useFileSystem (SFTP) — transfer-error feedback (D2, #1143)", () => {
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

  async function renderHook(): Promise<ReturnType<typeof useFileSystem>> {
    let api: ReturnType<typeof useFileSystem> | undefined;
    function Harness() {
      api = useFileSystem();
      return null;
    }
    await act(async () => {
      root.render(React.createElement(Harness));
    });
    return api!;
  }

  it("surfaces a toast error (not an unhandled rejection) when an upload fails", async () => {
    useAppStore.setState({ sftpSessionId: "sess-1", currentPath: "/uploads" });
    vi.mocked(open).mockResolvedValueOnce("/local/file.txt");
    vi.mocked(sftpUpload).mockRejectedValueOnce(new Error("permission denied"));

    const api = await renderHook();

    // Must resolve (swallow the rejection), not throw an unhandled rejection.
    await act(async () => {
      await expect(api.uploadFile()).resolves.toBeUndefined();
    });

    expect(vi.mocked(toast.error)).toHaveBeenCalled();
    expect(vi.mocked(toast.error).mock.calls[0][0]).toContain("permission denied");
  });

  it("surfaces a toast error when uploadFileFromPath (OS drop) fails", async () => {
    useAppStore.setState({ sftpSessionId: "sess-1", currentPath: "/uploads" });
    vi.mocked(sftpUpload).mockRejectedValueOnce(new Error("disk full"));

    const api = await renderHook();

    await act(async () => {
      await expect(api.uploadFileFromPath("/local/big.bin")).resolves.toBeUndefined();
    });

    expect(vi.mocked(toast.error)).toHaveBeenCalled();
    expect(vi.mocked(toast.error).mock.calls[0][0]).toContain("disk full");
  });

  it("surfaces a toast error when a download fails", async () => {
    useAppStore.setState({ sftpSessionId: "sess-1", currentPath: "/" });
    vi.mocked(save).mockResolvedValueOnce("/local/save.txt");
    vi.mocked(sftpDownload).mockRejectedValueOnce(new Error("no such file"));

    const api = await renderHook();

    await act(async () => {
      await expect(api.downloadFile("/remote/save.txt", "save.txt")).resolves.toBeUndefined();
    });

    expect(vi.mocked(toast.error)).toHaveBeenCalled();
    expect(vi.mocked(toast.error).mock.calls[0][0]).toContain("no such file");
  });

  it("surfaces a toast error when a paste (copy) transfer fails", async () => {
    useAppStore.setState({ sftpSessionId: "sess-1", currentPath: "/dest" });
    useAppStore.getState().setFileClipboard({
      entries: [
        {
          name: "file.txt",
          path: "/src/file.txt",
          isDirectory: false,
          size: 1,
          modified: "",
          permissions: null,
          writable: null,
        },
      ],
      operation: "copy",
      sourceMode: "local",
      sourcePath: "/src",
      sftpSessionId: null,
    });
    vi.mocked(sftpUpload).mockRejectedValueOnce(new Error("connection reset"));

    const api = await renderHook();

    await act(async () => {
      await expect(api.pasteEntry()).resolves.toBeUndefined();
    });

    expect(vi.mocked(toast.error)).toHaveBeenCalled();
    expect(vi.mocked(toast.error).mock.calls[0][0]).toContain("connection reset");
  });

  it("does not toast an error on a successful upload", async () => {
    useAppStore.setState({ sftpSessionId: "sess-1", currentPath: "/uploads" });
    vi.mocked(open).mockResolvedValueOnce("/local/file.txt");
    vi.mocked(sftpUpload).mockResolvedValueOnce(0);

    const api = await renderHook();

    await act(async () => {
      await api.uploadFile();
    });

    expect(vi.mocked(toast.error)).not.toHaveBeenCalled();
  });
});

// #1286: the terminal success/error toast is owned exclusively by the
// `transfer-progress` event path (useTransferEvents) so a single transfer
// yields exactly one terminal toast. `runTransfer` must therefore show only a
// pending toast and dismiss it on completion — never emit its own terminal
// success/error toast (which would double up with the event path).
describe("useFileSystem (SFTP) — no double terminal toast (#1286)", () => {
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

  async function renderHook(): Promise<ReturnType<typeof useFileSystem>> {
    let api: ReturnType<typeof useFileSystem> | undefined;
    function Harness() {
      api = useFileSystem();
      return null;
    }
    await act(async () => {
      root.render(React.createElement(Harness));
    });
    return api!;
  }

  it("does not emit a terminal success toast on a successful upload (event path owns it)", async () => {
    useAppStore.setState({ sftpSessionId: "sess-1", currentPath: "/uploads" });
    vi.mocked(open).mockResolvedValueOnce("/local/file.txt");
    vi.mocked(sftpUpload).mockResolvedValueOnce(0);

    const api = await renderHook();

    await act(async () => {
      await api.uploadFile();
    });

    // Pending feedback only; the terminal toast comes from useTransferEvents.
    expect(vi.mocked(toast.loading)).toHaveBeenCalled();
    expect(vi.mocked(toast.success)).not.toHaveBeenCalled();
    expect(vi.mocked(toast.dismiss)).toHaveBeenCalled();
  });

  it("does not emit a terminal success toast on a successful download", async () => {
    useAppStore.setState({ sftpSessionId: "sess-1", currentPath: "/" });
    vi.mocked(save).mockResolvedValueOnce("/local/save.txt");
    vi.mocked(sftpDownload).mockResolvedValueOnce(0);

    const api = await renderHook();

    await act(async () => {
      await api.downloadFile("/remote/save.txt", "save.txt");
    });

    expect(vi.mocked(toast.success)).not.toHaveBeenCalled();
    expect(vi.mocked(toast.dismiss)).toHaveBeenCalled();
  });

  it("defers to the event path on a TransferTerminalError (no runTransfer error toast)", async () => {
    useAppStore.setState({ sftpSessionId: "sess-1", currentPath: "/uploads" });
    vi.mocked(open).mockResolvedValueOnce("/local/file.txt");
    // A terminal `error` phase surfaced via awaitTransfer — the event path
    // (useTransferEvents) already toasts it, so runTransfer must not re-toast.
    vi.mocked(sftpUpload).mockRejectedValueOnce(
      new TransferTerminalError("error", "connection reset")
    );

    const api = await renderHook();

    await act(async () => {
      await expect(api.uploadFile()).resolves.toBeUndefined();
    });

    expect(vi.mocked(toast.error)).not.toHaveBeenCalled();
    expect(vi.mocked(toast.dismiss)).toHaveBeenCalled();
  });

  it("stays quiet on a cancelled transfer (TransferTerminalError 'cancelled')", async () => {
    useAppStore.setState({ sftpSessionId: "sess-1", currentPath: "/uploads" });
    vi.mocked(open).mockResolvedValueOnce("/local/file.txt");
    vi.mocked(sftpUpload).mockRejectedValueOnce(
      new TransferTerminalError("cancelled", "Transfer cancelled")
    );

    const api = await renderHook();

    await act(async () => {
      await expect(api.uploadFile()).resolves.toBeUndefined();
    });

    expect(vi.mocked(toast.error)).not.toHaveBeenCalled();
    expect(vi.mocked(toast.success)).not.toHaveBeenCalled();
    expect(vi.mocked(toast.dismiss)).toHaveBeenCalled();
  });
});
