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
}));

// Mock the sub-hooks to isolate routing logic
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
import { currentFileBrowsersView } from "@/store/fileBrowsersBridge";
import { seedFileBrowsers, setupFileBrowsersRegion } from "@/test/fileBrowsersRegionTestHarness";
import type { FileEntry } from "@/types/connection";
import { useFileBrowser } from "./useFileBrowser";

setupFileBrowsersRegion();

// The active pane is owned by the authoritative `file-browser` region (#2283).

describe("useFileBrowser routing", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
  });

  it("the active pane transitions correctly through the region", () => {
    useAppStore.getState().setFileBrowserMode("local");
    expect(currentFileBrowsersView().mode).toBe("local");

    useAppStore.getState().setFileBrowserMode("session");
    expect(currentFileBrowsersView().mode).toBe("session");

    useAppStore.getState().setFileBrowserMode("none");
    expect(currentFileBrowsersView().mode).toBe("none");
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
    seedFileBrowsers({ mode: "none" });
    let result: ReturnType<typeof useFileBrowser> | undefined;

    act(() => {
      root.render(createElement(FileBrowserHarness, { onResult: (r) => (result = r) }));
    });

    expect(result!.mode).toBe("none");
    expect(result!.fileEntries).toEqual([]);
    expect(result!.isConnected).toBe(false);
  });

  // The active pane and each pane's per-render fields (listing, cwd, loading,
  // error) are sourced from the authoritative `file-browser` region (#2283); the
  // file *actions* and `isConnected` still come from the per-mode hooks (mocked
  // above).
  const listing = (name: string) =>
    [{ name, path: `/${name}`, isDirectory: false }] as unknown as FileEntry[];

  it('returns mode "local" with local file entries', () => {
    seedFileBrowsers({
      mode: "local",
      local: { path: "/local", entries: listing("local-file.txt"), loading: false, error: null },
    });
    let result: ReturnType<typeof useFileBrowser> | undefined;

    act(() => {
      root.render(createElement(FileBrowserHarness, { onResult: (r) => (result = r) }));
    });

    expect(result!.mode).toBe("local");
    expect(result!.fileEntries[0].name).toBe("local-file.txt");
    // The actions/isConnected still come from the per-mode hook.
    expect(result!.isConnected).toBe(true);
  });

  it('returns mode "session" with session file entries', () => {
    seedFileBrowsers({
      mode: "session",
      session: {
        path: "/session",
        entries: listing("session-file.txt"),
        loading: false,
        error: null,
      },
    });
    let result: ReturnType<typeof useFileBrowser> | undefined;

    act(() => {
      root.render(createElement(FileBrowserHarness, { onResult: (r) => (result = r) }));
    });

    expect(result!.mode).toBe("session");
    expect(result!.fileEntries[0].name).toBe("session-file.txt");
    expect(result!.isConnected).toBe(true);
  });
});
