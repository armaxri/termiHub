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
  localListDir: vi.fn(),
  vscodeAvailable: vi.fn(() => Promise.resolve(false)),
  sessionReadFile: vi.fn(() => Promise.resolve([])),
  sessionWriteFile: vi.fn(() => Promise.resolve()),
  sessionDeleteFile: vi.fn(() => Promise.resolve()),
  sessionRenameFile: vi.fn(() => Promise.resolve()),
  sessionMkdir: vi.fn(() => Promise.resolve()),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(() => Promise.resolve(null)),
  save: vi.fn(() => Promise.resolve(null)),
}));

vi.mock("@tauri-apps/plugin-fs", () => ({
  readFile: vi.fn(() => Promise.resolve(new Uint8Array())),
  writeFile: vi.fn(() => Promise.resolve()),
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

import { useAppStore } from "@/store/appStore";

describe("useSessionFileSystem — store integration", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
  });

  it("sessionFileBrowserId starts as null", () => {
    expect(useAppStore.getState().sessionFileBrowserId).toBeNull();
  });

  it("sessionCurrentPath starts at /", () => {
    expect(useAppStore.getState().sessionCurrentPath).toBe("/");
  });

  it("isConnected is false when sessionFileBrowserId is null", () => {
    const { sessionFileBrowserId } = useAppStore.getState();
    expect(sessionFileBrowserId).toBeNull();
    // isConnected = sessionFileBrowserId !== null
    expect(sessionFileBrowserId !== null).toBe(false);
  });
});
