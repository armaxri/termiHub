/**
 * Regression tests for FileBrowser mutating/clipboard action feedback (#1399).
 *
 * The design-system rule "every action gives feedback" requires that the
 * rename, new-folder, new-file, Copy Name and Copy Path actions each surface a
 * success toast on success (or "Copied …" for the clipboard actions) and a
 * recoverable `toast.error` on failure — never resolving silently or only
 * logging to the console.
 *
 * Rename feedback already landed with #1348; these tests lock it in alongside
 * the newly-added feedback so a future edit cannot silently regress any of the
 * five actions.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { flushAsync } from "@/test/flushAsync";
import { createRoot, Root } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store/appStore";
import { setupFileBrowsersRegion } from "@/test/fileBrowsersRegionTestHarness";
import { FileBrowser } from "./FileBrowser";
import { TooltipProvider } from "@/components/ui";
import type { TerminalTab, LeafPanel } from "@/types/terminal";
import { seedLayoutState } from "@/test/layoutState";

const toastSuccess = vi.fn();
const toastError = vi.fn();

// Mock the Toast module itself (not the @/components/ui barrel) so the toast
// calls made from FileBrowser are captured regardless of import path.
vi.mock("@/components/ui/Toast", async () => {
  const actual =
    await vi.importActual<typeof import("@/components/ui/Toast")>("@/components/ui/Toast");
  return {
    ...actual,
    toast: {
      success: (...args: unknown[]) => toastSuccess(...args),
      error: (...args: unknown[]) => toastError(...args),
      info: vi.fn(),
      loading: vi.fn(),
      dismiss: vi.fn(),
    },
  };
});

const writeClipboardMock = vi.fn((_text: string): Promise<void> => Promise.resolve());
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  writeText: (text: string) => writeClipboardMock(text),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onDragDropEvent: vi.fn(() => Promise.resolve(vi.fn())),
  }),
}));

vi.mock("@/themes", () => ({
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(() => vi.fn()),
}));

vi.mock("@/services/events", () => ({
  onVscodeEditComplete: vi.fn(() => Promise.resolve(vi.fn())),
  onLocalDirChanged: vi.fn(() => Promise.resolve(vi.fn())),
}));

vi.mock("@/services/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/api")>();
  return {
    ...actual,
    getHomeDir: vi.fn(() => Promise.resolve("/home/test")),
  };
});

const mockedInvoke = vi.mocked(invoke);

let container: HTMLDivElement;
let root: Root;

const entries = [
  { name: "report.pdf", path: "/home/report.pdf", isDirectory: false, size: 10, modified: "" },
  { name: "mydir", path: "/home/mydir", isDirectory: true, size: 0, modified: "" },
];

function makeTab(overrides: Partial<TerminalTab>): TerminalTab {
  return {
    id: "tab-1",
    sessionId: "sess-1",
    title: "Test Tab",
    connectionType: "local",
    contentType: "terminal",
    config: { type: "local", config: {} },
    panelId: "panel-1",
    isActive: true,
    ...overrides,
  };
}

function setActiveTab(tab: TerminalTab) {
  const panel: LeafPanel = { type: "leaf", id: tab.panelId, tabs: [tab], activeTabId: tab.id };
  seedLayoutState({ activePanelId: tab.panelId, rootPanel: panel });
}

async function renderLocal() {
  setActiveTab(makeTab({ connectionType: "local", config: { type: "local", config: {} } }));
  useAppStore.setState({ sidebarView: "files", tabCwds: { "tab-1": "/home" } });
  await act(async () => {
    root.render(
      <TooltipProvider delayDuration={0}>
        <FileBrowser />
      </TooltipProvider>
    );
  });
  await flushAsync();
}

function row(name: string): HTMLElement {
  return container.querySelector(`[data-testid="file-row-${name}"]`) as HTMLElement;
}

const q = (testId: string) => document.querySelector(`[data-testid="${testId}"]`) as HTMLElement;

/** Type a value into an uncontrolled/controlled input and dispatch `input`. */
async function setInputValue(input: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value"
    )!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** Focus the report.pdf file row then press F2 to start an inline rename. */
async function startRenameOnReport() {
  await act(async () => {
    row("report.pdf").click();
  });
  const list = container.querySelector('[data-testid="file-browser-list"]') as HTMLElement;
  await act(async () => {
    list.dispatchEvent(new KeyboardEvent("keydown", { key: "F2", bubbles: true }));
  });
  await flushAsync();
}

async function commitRenameTo(newName: string) {
  const input = container.querySelector(
    '[data-testid="file-row-rename-input"]'
  ) as HTMLInputElement;
  await setInputValue(input, newName);
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  await flushAsync();
}

setupFileBrowsersRegion();

describe("FileBrowser — mutating/clipboard action feedback (#1399)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    toastSuccess.mockClear();
    toastError.mockClear();
    writeClipboardMock.mockClear();
    writeClipboardMock.mockImplementation(() => Promise.resolve());
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "local_list_dir") return Promise.resolve(entries);
      return Promise.resolve(undefined);
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  // --- Rename (feedback landed with #1348; locked in here) ---

  it("shows a success toast when a rename succeeds", async () => {
    await renderLocal();
    await startRenameOnReport();
    await commitRenameTo("renamed.pdf");

    expect(mockedInvoke).toHaveBeenCalledWith("local_rename", {
      oldPath: "/home/report.pdf",
      newPath: "/home/renamed.pdf",
    });
    expect(toastSuccess).toHaveBeenCalledTimes(1);
    expect(String(toastSuccess.mock.calls[0][0])).toContain("renamed.pdf");
    expect(toastError).not.toHaveBeenCalled();
  });

  it("shows an error toast when a rename fails", async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "local_list_dir") return Promise.resolve(entries);
      if (cmd === "local_rename") return Promise.reject(new Error("permission denied"));
      return Promise.resolve(undefined);
    });
    await renderLocal();
    await startRenameOnReport();
    await commitRenameTo("renamed.pdf");

    expect(toastSuccess).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(String(toastError.mock.calls[0][0])).toContain("permission denied");
  });

  // --- New folder ---

  async function createFolderNamed(name: string) {
    await act(async () => {
      q("file-browser-new-folder").click();
    });
    const input = q("file-browser-new-folder-input") as HTMLInputElement;
    await setInputValue(input, name);
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await flushAsync();
  }

  it("shows a success toast when a new folder is created", async () => {
    await renderLocal();
    await createFolderNamed("newdir");

    expect(mockedInvoke).toHaveBeenCalledWith("local_mkdir", { path: "/home/newdir" });
    expect(toastSuccess).toHaveBeenCalledTimes(1);
    expect(String(toastSuccess.mock.calls[0][0])).toContain("newdir");
    expect(toastError).not.toHaveBeenCalled();
  });

  it("shows an error toast when new folder creation fails", async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "local_list_dir") return Promise.resolve(entries);
      if (cmd === "local_mkdir") return Promise.reject(new Error("exists"));
      return Promise.resolve(undefined);
    });
    await renderLocal();
    await createFolderNamed("newdir");

    expect(toastSuccess).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(String(toastError.mock.calls[0][0])).toContain("newdir");
  });

  // --- New file ---

  async function createFileNamed(name: string) {
    await act(async () => {
      q("file-browser-new-file").click();
    });
    const input = q("file-browser-new-file-input") as HTMLInputElement;
    await setInputValue(input, name);
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await flushAsync();
  }

  it("shows a success toast when a new file is created", async () => {
    await renderLocal();
    await createFileNamed("notes.txt");

    expect(mockedInvoke).toHaveBeenCalledWith("local_write_file", {
      path: "/home/notes.txt",
      content: "",
    });
    expect(toastSuccess).toHaveBeenCalledTimes(1);
    expect(String(toastSuccess.mock.calls[0][0])).toContain("notes.txt");
    expect(toastError).not.toHaveBeenCalled();
  });

  it("shows an error toast when new file creation fails", async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "local_list_dir") return Promise.resolve(entries);
      if (cmd === "local_write_file") return Promise.reject(new Error("no space"));
      return Promise.resolve(undefined);
    });
    await renderLocal();
    await createFileNamed("notes.txt");

    expect(toastSuccess).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(String(toastError.mock.calls[0][0])).toContain("notes.txt");
  });

  // --- Copy Name / Copy Path ---

  async function invokeContextAction(name: string, actionTestId: string) {
    await act(async () => {
      row(name).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    });
    await act(async () => {
      q(actionTestId).click();
    });
    await flushAsync();
  }

  it("copies the name and shows a 'Copied name' toast", async () => {
    await renderLocal();
    await invokeContextAction("report.pdf", "context-file-copy-name");

    expect(writeClipboardMock).toHaveBeenCalledWith("report.pdf");
    expect(toastSuccess).toHaveBeenCalledTimes(1);
    expect(String(toastSuccess.mock.calls[0][0]).toLowerCase()).toContain("name");
    expect(toastError).not.toHaveBeenCalled();
  });

  it("shows an error toast when copying the name fails", async () => {
    writeClipboardMock.mockImplementation(() => Promise.reject(new Error("clipboard blocked")));
    await renderLocal();
    await invokeContextAction("report.pdf", "context-file-copy-name");

    expect(toastSuccess).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledTimes(1);
  });

  it("copies the path and shows a 'Copied path' toast", async () => {
    await renderLocal();
    await invokeContextAction("report.pdf", "context-file-copy-path");

    expect(writeClipboardMock).toHaveBeenCalledWith("/home/report.pdf");
    expect(toastSuccess).toHaveBeenCalledTimes(1);
    expect(String(toastSuccess.mock.calls[0][0]).toLowerCase()).toContain("path");
    expect(toastError).not.toHaveBeenCalled();
  });

  it("shows an error toast when copying the path fails", async () => {
    writeClipboardMock.mockImplementation(() => Promise.reject(new Error("clipboard blocked")));
    await renderLocal();
    await invokeContextAction("report.pdf", "context-file-copy-path");

    expect(toastSuccess).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledTimes(1);
  });
});
