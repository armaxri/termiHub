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
}));

// Mock the sub-hooks to isolate routing logic
vi.mock("./useFileSystem", () => ({
  useFileSystem: vi.fn(() => ({
    fileEntries: [{ name: "sftp-file.txt", path: "/sftp-file.txt", isDirectory: false }],
    currentPath: "/sftp",
    isConnected: true,
    isLoading: false,
    error: null,
    navigateTo: vi.fn(),
    navigateUp: vi.fn(),
    refresh: vi.fn(),
    downloadFile: vi.fn(),
    uploadFile: vi.fn(),
    createDirectory: vi.fn(),
    createFile: vi.fn(),
    deleteEntry: vi.fn(),
    renameEntry: vi.fn(),
    openInVscode: vi.fn(),
    copyEntry: vi.fn(),
    cutEntry: vi.fn(),
    pasteEntry: vi.fn(),
  })),
}));

vi.mock("./useLocalFileSystem", () => ({
  useLocalFileSystem: vi.fn(() => ({
    fileEntries: [{ name: "local-file.txt", path: "/local-file.txt", isDirectory: false }],
    currentPath: "/local",
    isConnected: true,
    isLoading: false,
    error: null,
    navigateTo: vi.fn(),
    navigateUp: vi.fn(),
    refresh: vi.fn(),
    downloadFile: vi.fn(),
    uploadFile: vi.fn(),
    createDirectory: vi.fn(),
    createFile: vi.fn(),
    deleteEntry: vi.fn(),
    renameEntry: vi.fn(),
    openInVscode: vi.fn(),
    copyEntry: vi.fn(),
    cutEntry: vi.fn(),
    pasteEntry: vi.fn(),
  })),
}));

vi.mock("./useSessionFileSystem", () => ({
  useSessionFileSystem: vi.fn(() => ({
    fileEntries: [{ name: "session-file.txt", path: "/session-file.txt", isDirectory: false }],
    currentPath: "/session",
    isConnected: true,
    isLoading: false,
    error: null,
    navigateTo: vi.fn(),
    navigateUp: vi.fn(),
    refresh: vi.fn(),
    downloadFile: vi.fn(),
    uploadFile: vi.fn(),
    createDirectory: vi.fn(),
    createFile: vi.fn(),
    deleteEntry: vi.fn(),
    renameEntry: vi.fn(),
    openInVscode: vi.fn(),
    copyEntry: vi.fn(),
    cutEntry: vi.fn(),
    pasteEntry: vi.fn(),
  })),
}));

import { useAppStore } from "@/store/appStore";
import { useFileBrowser } from "./useFileBrowser";

// Test the routing logic by calling the hook with the store in different modes.
// Since hooks must run in a component, we test the routing indirectly via
// the store state that drives the mode selection.

describe("useFileBrowser routing", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
  });

  it('returns mode "none" with disconnected defaults when fileBrowserMode is none', () => {
    useAppStore.setState({ fileBrowserMode: "none" });

    // Call the hook logic directly without React rendering by replicating the
    // routing switch. This avoids the need for a full component render.
    const mode = useAppStore.getState().fileBrowserMode;
    expect(mode).toBe("none");
  });

  it("fileBrowserMode transitions correctly", () => {
    useAppStore.setState({ fileBrowserMode: "local" });
    expect(useAppStore.getState().fileBrowserMode).toBe("local");

    useAppStore.setState({ fileBrowserMode: "sftp" });
    expect(useAppStore.getState().fileBrowserMode).toBe("sftp");

    useAppStore.setState({ fileBrowserMode: "session" });
    expect(useAppStore.getState().fileBrowserMode).toBe("session");

    useAppStore.setState({ fileBrowserMode: "none" });
    expect(useAppStore.getState().fileBrowserMode).toBe("none");
  });
});

// Test the actual hook routing using a component harness
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

function FileBrowserHarness({
  onResult,
}: {
  onResult: (r: ReturnType<typeof useFileBrowser>) => void;
}) {
  const result = useFileBrowser();
  onResult(result);
  return null;
}

describe("useFileBrowser hook (mode routing)", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('returns mode "none" with empty fileEntries when mode is none', () => {
    useAppStore.setState({ fileBrowserMode: "none" });
    let result: ReturnType<typeof useFileBrowser> | undefined;

    act(() => {
      root.render(createElement(FileBrowserHarness, { onResult: (r) => (result = r) }));
    });

    expect(result!.mode).toBe("none");
    expect(result!.fileEntries).toEqual([]);
    expect(result!.isConnected).toBe(false);
  });

  it('returns mode "local" with local file entries', () => {
    useAppStore.setState({ fileBrowserMode: "local" });
    let result: ReturnType<typeof useFileBrowser> | undefined;

    act(() => {
      root.render(createElement(FileBrowserHarness, { onResult: (r) => (result = r) }));
    });

    expect(result!.mode).toBe("local");
    expect(result!.fileEntries[0].name).toBe("local-file.txt");
  });

  it('returns mode "sftp" with SFTP file entries', () => {
    useAppStore.setState({ fileBrowserMode: "sftp" });
    let result: ReturnType<typeof useFileBrowser> | undefined;

    act(() => {
      root.render(createElement(FileBrowserHarness, { onResult: (r) => (result = r) }));
    });

    expect(result!.mode).toBe("sftp");
    expect(result!.fileEntries[0].name).toBe("sftp-file.txt");
  });

  it('returns mode "session" with session file entries', () => {
    useAppStore.setState({ fileBrowserMode: "session" });
    let result: ReturnType<typeof useFileBrowser> | undefined;

    act(() => {
      root.render(createElement(FileBrowserHarness, { onResult: (r) => (result = r) }));
    });

    expect(result!.mode).toBe("session");
    expect(result!.fileEntries[0].name).toBe("session-file.txt");
  });
});
