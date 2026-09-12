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
  localMkdir: vi.fn(() => Promise.resolve()),
  localDelete: vi.fn(() => Promise.resolve()),
  localRename: vi.fn(() => Promise.resolve()),
  localSetPermissions: vi.fn(() => Promise.resolve()),
  localWriteFile: vi.fn(() => Promise.resolve()),
  localCopyFile: vi.fn(() => Promise.resolve()),
  vscodeAvailable: vi.fn(() => Promise.resolve(false)),
  vscodeOpenLocal: vi.fn(() => Promise.resolve()),
  sftpDownload: vi.fn(() => Promise.resolve()),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: vi.fn(() => Promise.resolve(null)),
  open: vi.fn(() => Promise.resolve(null)),
}));

import { useAppStore } from "@/store/appStore";
import { currentFileBrowsersView } from "@/store/fileBrowsersBridge";
import { seedFileBrowsers, setupFileBrowsersRegion } from "@/test/fileBrowsersRegionTestHarness";

setupFileBrowsersRegion();

// Test the navigateUp path-logic which is pure string manipulation.
// We extract and test the logic directly rather than through the hook
// to avoid complex React rendering for essentially pure functions.
function navigateUpLogic(currentPath: string): string | null {
  if (currentPath === "/") return null; // no-op
  if (/^[A-Za-z]:\/?$/.test(currentPath)) return null; // Windows drive root
  const noTrailing = currentPath.endsWith("/") ? currentPath.slice(0, -1) : currentPath;
  const parts = noTrailing.split("/");
  parts.pop();
  let parentPath = parts.join("/") || "/";
  if (/^[A-Za-z]:$/.test(parentPath)) {
    parentPath = parentPath + "/";
  }
  return parentPath;
}

describe("useLocalFileSystem — navigateUp path logic", () => {
  describe("Unix paths", () => {
    it("navigates up from a nested path", () => {
      expect(navigateUpLogic("/home/user/documents")).toBe("/home/user");
    });

    it("navigates up from a single-depth path", () => {
      expect(navigateUpLogic("/home")).toBe("/");
    });

    it("returns null (no-op) from root /", () => {
      expect(navigateUpLogic("/")).toBeNull();
    });

    it("handles trailing slash", () => {
      expect(navigateUpLogic("/home/user/")).toBe("/home");
    });

    it("navigates up from deeply nested path", () => {
      expect(navigateUpLogic("/a/b/c/d/e")).toBe("/a/b/c/d");
    });
  });

  describe("Windows paths", () => {
    it("returns null from drive root C:/", () => {
      expect(navigateUpLogic("C:/")).toBeNull();
    });

    it("returns null from bare drive letter C:", () => {
      expect(navigateUpLogic("C:")).toBeNull();
    });

    it("navigates up from Windows nested path", () => {
      expect(navigateUpLogic("C:/Users/user")).toBe("C:/Users");
    });

    it("converts bare drive letter parent back to drive root C:/", () => {
      // e.g. navigating up from "C:/Users" should yield "C:/"
      expect(navigateUpLogic("C:/Users")).toBe("C:/");
    });
  });
});

describe("useLocalFileSystem — createDirectory path construction", () => {
  // Test the path construction logic inline to avoid complex hook rendering.
  function buildNewDirPath(currentPath: string, name: string): string {
    const base = currentPath.endsWith("/") ? currentPath.slice(0, -1) : currentPath;
    return base ? `${base}/${name}` : `/${name}`;
  }

  it("constructs path correctly from /home/user", () => {
    expect(buildNewDirPath("/home/user", "projects")).toBe("/home/user/projects");
  });

  it("constructs path from root /", () => {
    expect(buildNewDirPath("/", "newdir")).toBe("/newdir");
  });

  it("handles trailing slash in currentPath", () => {
    expect(buildNewDirPath("/home/user/", "docs")).toBe("/home/user/docs");
  });
});

describe("useLocalFileSystem — renameEntry path construction", () => {
  function buildRenamePath(oldPath: string, newName: string): string {
    const parentDir = oldPath.split("/").slice(0, -1).join("/") || "/";
    return parentDir === "/" ? `/${newName}` : `${parentDir}/${newName}`;
  }

  it("renames file in nested directory", () => {
    expect(buildRenamePath("/home/user/old.txt", "new.txt")).toBe("/home/user/new.txt");
  });

  it("renames file in root directory", () => {
    expect(buildRenamePath("/old.txt", "new.txt")).toBe("/new.txt");
  });

  it("renames file in deeply nested directory", () => {
    expect(buildRenamePath("/a/b/c/old.txt", "new.txt")).toBe("/a/b/c/new.txt");
  });
});

describe("useLocalFileSystem — store integration", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
  });

  it("the local pane path defaults to a string", () => {
    // The region initializes the local pane path, just verify it's a string
    expect(typeof currentFileBrowsersView().local.path).toBe("string");
  });

  it("navigateLocal commits the path to the region", async () => {
    // navigateLocal is async: it calls localListDir then reports the path
    await useAppStore.getState().navigateLocal("/test/path");
    await Promise.resolve();
    expect(currentFileBrowsersView().local.path).toBe("/test/path");
  });
});

import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { localCopyFile } from "@/services/api";
import { useLocalFileSystem } from "./useLocalFileSystem";

describe("useLocalFileSystem — uploadFileFromPath API call", () => {
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

  it("calls localCopyFile with the correct destination path", async () => {
    seedFileBrowsers({
      local: { path: "/destination/dir", entries: [], loading: false, error: null },
    });

    let uploadFn: ((path: string) => Promise<void>) | undefined;
    function Harness() {
      const { uploadFileFromPath } = useLocalFileSystem();
      uploadFn = uploadFileFromPath;
      return null;
    }

    await act(async () => {
      root.render(React.createElement(Harness));
    });

    await act(async () => {
      await uploadFn!("/source/photo.jpg");
    });

    expect(vi.mocked(localCopyFile)).toHaveBeenCalledWith(
      "/source/photo.jpg",
      "/destination/dir/photo.jpg",
      false
    );
  });

  it("skips copy when source and destination are the same path", async () => {
    seedFileBrowsers({ local: { path: "/source", entries: [], loading: false, error: null } });

    let uploadFn: ((path: string) => Promise<void>) | undefined;
    function Harness() {
      const { uploadFileFromPath } = useLocalFileSystem();
      uploadFn = uploadFileFromPath;
      return null;
    }

    await act(async () => {
      root.render(React.createElement(Harness));
    });

    await act(async () => {
      await uploadFn!("/source/photo.jpg");
    });

    expect(vi.mocked(localCopyFile)).not.toHaveBeenCalled();
  });

  it("handles Windows-style backslash source path", async () => {
    seedFileBrowsers({ local: { path: "/uploads", entries: [], loading: false, error: null } });

    let uploadFn: ((path: string) => Promise<void>) | undefined;
    function Harness() {
      const { uploadFileFromPath } = useLocalFileSystem();
      uploadFn = uploadFileFromPath;
      return null;
    }

    await act(async () => {
      root.render(React.createElement(Harness));
    });

    await act(async () => {
      await uploadFn!("C:\\Users\\Alice\\report.docx");
    });

    expect(vi.mocked(localCopyFile)).toHaveBeenCalledWith(
      "C:\\Users\\Alice\\report.docx",
      "/uploads/report.docx",
      false
    );
  });
});

// ── Full hook-surface coverage: each action wires the right api call ───────────
// These render the real hook (not the extracted pure helpers above) so the
// useCallback closures and their store/api plumbing are exercised end-to-end.
import { save } from "@tauri-apps/plugin-dialog";
import type { FileEntry } from "@/types/connection";
import {
  localMkdir,
  localWriteFile,
  localDelete,
  localRename,
  localSetPermissions,
  vscodeOpenLocal,
} from "@/services/api";

describe("useLocalFileSystem — action wiring", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  type LocalFs = ReturnType<typeof useLocalFileSystem>;

  async function mountHook(path = "/home/user", entries: FileEntry[] = []): Promise<LocalFs> {
    seedFileBrowsers({ local: { path, entries, loading: false, error: null } });
    let api: LocalFs | undefined;
    function Harness() {
      api = useLocalFileSystem();
      return null;
    }
    await act(async () => {
      root.render(React.createElement(Harness));
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

  it("exposes stable static props (always connected, permissions supported)", async () => {
    const api = await mountHook();
    expect(api.isConnected).toBe(true);
    expect(api.supportsPermissions).toBe(true);
    // uploadFile is a no-op on the local pane (files are already local).
    await expect(api.uploadFile()).resolves.toBeUndefined();
  });

  it("createDirectory calls localMkdir with the joined path", async () => {
    const api = await mountHook("/home/user");
    await act(async () => {
      await api.createDirectory("projects");
    });
    expect(vi.mocked(localMkdir)).toHaveBeenCalledWith("/home/user/projects");
  });

  it("createDirectory joins correctly at root", async () => {
    const api = await mountHook("/");
    await act(async () => {
      await api.createDirectory("newdir");
    });
    expect(vi.mocked(localMkdir)).toHaveBeenCalledWith("/newdir");
  });

  it("createFile writes an empty file at the joined path", async () => {
    const api = await mountHook("/home/user");
    await act(async () => {
      await api.createFile("notes.txt");
    });
    expect(vi.mocked(localWriteFile)).toHaveBeenCalledWith("/home/user/notes.txt", "");
  });

  it("deleteEntry forwards the path and isDirectory flag", async () => {
    const api = await mountHook();
    await act(async () => {
      await api.deleteEntry("/home/user/old", true);
    });
    expect(vi.mocked(localDelete)).toHaveBeenCalledWith("/home/user/old", true);
  });

  it("renameEntry rebuilds the sibling path from the parent directory", async () => {
    const api = await mountHook();
    await act(async () => {
      await api.renameEntry("/home/user/old.txt", "new.txt");
    });
    expect(vi.mocked(localRename)).toHaveBeenCalledWith(
      "/home/user/old.txt",
      "/home/user/new.txt"
    );
  });

  it("setPermissions forwards path and mode", async () => {
    const api = await mountHook();
    await act(async () => {
      await api.setPermissions("/home/user/script.sh", 0o755);
    });
    expect(vi.mocked(localSetPermissions)).toHaveBeenCalledWith("/home/user/script.sh", 0o755);
  });

  it("openInVscode opens the local path", async () => {
    const api = await mountHook();
    await act(async () => {
      await api.openInVscode("/home/user/file.ts");
    });
    expect(vi.mocked(vscodeOpenLocal)).toHaveBeenCalledWith("/home/user/file.ts");
  });

  it("downloadFile copies to the chosen save target, honouring the entry's isDirectory", async () => {
    vi.mocked(save).mockResolvedValueOnce("/dest/copy");
    const api = await mountHook("/home/user", [
      {
        name: "docs",
        path: "/home/user/docs",
        isDirectory: true,
        size: 0,
        modified: "",
        permissions: null,
        writable: null,
      },
    ]);
    await act(async () => {
      await api.downloadFile("/home/user/docs", "docs");
    });
    expect(vi.mocked(localCopyFile)).toHaveBeenCalledWith("/home/user/docs", "/dest/copy", true);
  });

  it("downloadFile is a no-op when the save dialog is cancelled", async () => {
    vi.mocked(save).mockResolvedValueOnce(null);
    const api = await mountHook();
    await act(async () => {
      await api.downloadFile("/home/user/file.txt", "file.txt");
    });
    expect(vi.mocked(localCopyFile)).not.toHaveBeenCalled();
  });

  it("copyEntry stores a local copy clipboard", async () => {
    const api = await mountHook("/home/user");
    act(() => {
      api.copyEntry([
        {
          name: "a.txt",
          path: "/home/user/a.txt",
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
    expect(clip?.sourceMode).toBe("local");
    expect(clip?.sourcePath).toBe("/home/user");
  });

  it("cutEntry stores a local cut clipboard", async () => {
    const api = await mountHook("/home/user");
    act(() => {
      api.cutEntry([
        {
          name: "a.txt",
          path: "/home/user/a.txt",
          isDirectory: false,
          size: 1,
          modified: "",
          permissions: null,
          writable: null,
        },
      ]);
    });
    const clip = currentFileBrowsersView().clipboard;
    expect(clip?.operation).toBe("cut");
    expect(clip?.sourceMode).toBe("local");
  });

  it("pasteEntry copies a local→local clipboard via localCopyFile", async () => {
    const api = await mountHook("/dest");
    act(() => {
      useAppStore.getState().setFileClipboard({
        entries: [
          {
            name: "a.txt",
            path: "/src/a.txt",
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
      });
    });
    await act(async () => {
      await api.pasteEntry();
    });
    expect(vi.mocked(localCopyFile)).toHaveBeenCalledWith("/src/a.txt", "/dest/a.txt", false);
  });

  it("pasteEntry moves a local→local cut clipboard via localRename and clears it", async () => {
    const api = await mountHook("/dest");
    act(() => {
      useAppStore.getState().setFileClipboard({
        entries: [
          {
            name: "a.txt",
            path: "/src/a.txt",
            isDirectory: false,
            size: 1,
            modified: "",
            permissions: null,
            writable: null,
          },
        ],
        operation: "cut",
        sourceMode: "local",
        sourcePath: "/src",
      });
    });
    await act(async () => {
      await api.pasteEntry();
    });
    expect(vi.mocked(localRename)).toHaveBeenCalledWith("/src/a.txt", "/dest/a.txt");
    expect(currentFileBrowsersView().clipboard).toBeNull();
  });

  it("pasteEntry is a no-op with an empty clipboard", async () => {
    const api = await mountHook();
    act(() => {
      useAppStore.getState().setFileClipboard(null);
    });
    await act(async () => {
      await api.pasteEntry();
    });
    expect(vi.mocked(localCopyFile)).not.toHaveBeenCalled();
    expect(vi.mocked(localRename)).not.toHaveBeenCalled();
  });

  it("navigateTo commits the target path to the region", async () => {
    const api = await mountHook("/home/user");
    await act(async () => {
      api.navigateTo("/var/log");
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(currentFileBrowsersView().local.path).toBe("/var/log");
  });

  it("navigateUp walks to the parent and commits it", async () => {
    const api = await mountHook("/home/user/docs");
    await act(async () => {
      api.navigateUp();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(currentFileBrowsersView().local.path).toBe("/home/user");
  });

  it("navigateUp is a no-op at root /", async () => {
    const api = await mountHook("/");
    await act(async () => {
      api.navigateUp();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(currentFileBrowsersView().local.path).toBe("/");
  });
});
