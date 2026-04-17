import { describe, it, expect, vi, beforeEach } from "vitest";

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

  it("localCurrentPath defaults to home or /", () => {
    // The store initializes localCurrentPath, just verify it's a string
    const { localCurrentPath } = useAppStore.getState();
    expect(typeof localCurrentPath).toBe("string");
  });

  it("navigateLocal updates localCurrentPath in store", async () => {
    // navigateLocal is async: it calls localListDir then sets the path
    await useAppStore.getState().navigateLocal("/test/path");
    expect(useAppStore.getState().localCurrentPath).toBe("/test/path");
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
    useAppStore.setState({ localCurrentPath: "/destination/dir" });

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
    useAppStore.setState({ localCurrentPath: "/source" });

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
    useAppStore.setState({ localCurrentPath: "/uploads" });

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
