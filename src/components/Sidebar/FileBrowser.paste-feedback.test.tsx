/**
 * Regression tests for the plain file-browser Paste feedback (#3458).
 *
 * The toolbar / context-menu Paste used to call the local `pasteEntry` fire-and-
 * forget: a failed local rename/copy became an unhandled promise rejection with
 * no toast, and a successful one was silent. Paste now runs through the same
 * engine as drag-to-move and Move to… (`useFileMoveTransfer`): same guards, same
 * overwrite confirmation, and a loading → success/error toast from the pane's
 * paste. Every test here also fails if any promise rejection goes unhandled.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { flushAsync } from "@/test/flushAsync";
import { createRoot, Root } from "react-dom/client";
import { invoke, type InvokeArgs } from "@tauri-apps/api/core";
import { useAppStore } from "@/store/appStore";
import type { FileClipboard } from "@/store/appStore";
import { currentFileBrowsersView } from "@/store/fileBrowsersBridge";
import { setupFileBrowsersRegion } from "@/test/fileBrowsersRegionTestHarness";
import { setupVirtualListSizing } from "@/test/virtualListSize";
import { FileBrowser } from "./FileBrowser";
import { TooltipProvider } from "@/components/ui";
import type { TerminalTab, LeafPanel } from "@/types/terminal";
import { seedLayoutState } from "@/test/layoutState";

const toastSuccess = vi.fn();
const toastError = vi.fn();
const toastInfo = vi.fn();

vi.mock("@/components/ui/Toast", async () => {
  const actual =
    await vi.importActual<typeof import("@/components/ui/Toast")>("@/components/ui/Toast");
  return {
    ...actual,
    toast: {
      success: (...args: unknown[]) => toastSuccess(...args),
      error: (...args: unknown[]) => toastError(...args),
      info: (...args: unknown[]) => toastInfo(...args),
      loading: vi.fn(() => "toast-id"),
      dismiss: vi.fn(),
    },
  };
});

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

const homeEntries = [
  { name: "a.txt", path: "/home/a.txt", isDirectory: false, size: 1, modified: "" },
  { name: "docs", path: "/home/docs", isDirectory: true, size: 0, modified: "" },
];

/** Commands that should reject, keyed by command name. */
let failing: Record<string, string> = {};

/** Every rejection nobody handled while a test ran. */
let unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => {
  unhandled.push(reason);
};

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

async function renderLocal() {
  const tab = makeTab({});
  const panel: LeafPanel = { type: "leaf", id: tab.panelId, tabs: [tab], activeTabId: tab.id };
  seedLayoutState({ activePanelId: tab.panelId, rootPanel: panel });
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

const q = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement;

function calls(cmd: string) {
  return mockedInvoke.mock.calls.filter(([c]) => c === cmd).map(([, args]) => args);
}

function setClipboard(name: string, dir: string, operation: "copy" | "cut", isDirectory = false) {
  const clip: FileClipboard = {
    entries: [
      { name, path: `${dir}/${name}`, isDirectory, size: 1, modified: "", permissions: null },
    ],
    operation,
    sourceMode: "local",
    sourcePath: dir,
  };
  act(() => {
    useAppStore.getState().setFileClipboard(clip);
  });
}

async function clickPaste() {
  await act(async () => {
    q("file-browser-paste").click();
  });
  await flushAsync();
  // Give any stray rejection a turn to surface as `unhandledRejection`.
  await new Promise((r) => setImmediate(r));
}

setupFileBrowsersRegion();
setupVirtualListSizing();

describe("FileBrowser — plain Paste feedback (#3458)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    failing = {};
    unhandled = [];
    process.on("unhandledRejection", onUnhandled);
    mockedInvoke.mockImplementation((cmd: string, args?: InvokeArgs) => {
      if (failing[cmd]) return Promise.reject(failing[cmd]);
      if (cmd === "local_list_dir") {
        const path = (args as { path?: string } | undefined)?.path;
        return Promise.resolve(path === "/home" ? homeEntries : []);
      }
      return Promise.resolve(undefined);
    });
  });

  afterEach(() => {
    process.off("unhandledRejection", onUnhandled);
    expect(unhandled).toEqual([]);
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("shows a success toast after a local copy-paste", async () => {
    await renderLocal();
    setClipboard("x.txt", "/src", "copy");
    await clickPaste();
    expect(calls("local_copy")).toEqual([
      { srcPath: "/src/x.txt", destPath: "/home/x.txt", isDirectory: false },
    ]);
    expect(toastSuccess).toHaveBeenCalledWith(
      'Pasted "x.txt" to /home',
      expect.objectContaining({ id: "toast-id" })
    );
    expect(toastError).not.toHaveBeenCalled();
  });

  it("clears a cut clipboard after a successful local cut-paste", async () => {
    await renderLocal();
    setClipboard("x.txt", "/src", "cut");
    await clickPaste();
    expect(calls("local_rename")).toEqual([{ oldPath: "/src/x.txt", newPath: "/home/x.txt" }]);
    expect(toastSuccess).toHaveBeenCalledTimes(1);
    expect(currentFileBrowsersView().clipboard).toBeNull();
  });

  it("shows the typed error, keeps the cut clipboard, and never rejects unhandled", async () => {
    failing = { local_rename: "Permission denied (os error 13)" };
    await renderLocal();
    setClipboard("x.txt", "/src", "cut");
    await clickPaste();
    expect(toastError).toHaveBeenCalledWith(
      'Paste "x.txt" failed: Permission denied (os error 13)',
      expect.objectContaining({ id: "toast-id" })
    );
    expect(toastSuccess).not.toHaveBeenCalled();
    // The user can retry: a failed cut keeps its clipboard.
    expect(currentFileBrowsersView().clipboard?.entries[0].name).toBe("x.txt");
  });

  it("shows an error toast for a failed local copy-paste", async () => {
    failing = { local_copy: "No space left on device" };
    await renderLocal();
    setClipboard("x.txt", "/src", "copy");
    await clickPaste();
    expect(toastError).toHaveBeenCalledWith(
      'Paste "x.txt" failed: No space left on device',
      expect.anything()
    );
  });

  it("asks before replacing an existing name, and only pastes on confirm", async () => {
    await renderLocal();
    setClipboard("a.txt", "/src", "copy");
    await clickPaste();
    expect(q("file-move-conflict-dialog")).toBeTruthy();
    expect(q("file-move-conflict-dialog").textContent).toContain("Paste and Replace?");
    expect(q("file-move-conflict-dialog").textContent).toContain('"a.txt" already exists');
    expect(calls("local_copy")).toEqual([]);
    await act(async () => {
      q("file-move-conflict-confirm").click();
    });
    await flushAsync();
    expect(calls("local_copy")).toEqual([
      { srcPath: "/src/a.txt", destPath: "/home/a.txt", isDirectory: false },
    ]);
    expect(toastSuccess).toHaveBeenCalledTimes(1);
  });

  it("refuses pasting a folder into itself without touching the disk", async () => {
    useAppStore.setState({ tabCwds: { "tab-1": "/home" } });
    await renderLocal();
    // A cut of /home's parent folder, pasted into /home (its own descendant).
    setClipboard("home", "", "cut", true);
    await clickPaste();
    expect(toastError).toHaveBeenCalledWith('Cannot move "home" into itself');
    expect(calls("local_rename")).toEqual([]);
  });

  it("says so instead of silently pasting items into the folder they came from", async () => {
    await renderLocal();
    setClipboard("a.txt", "/home", "cut");
    await clickPaste();
    expect(toastInfo).toHaveBeenCalledWith('"a.txt" is already in /home');
    expect(calls("local_rename")).toEqual([]);
  });

  it("reports an unsupported remote→local paste instead of doing nothing", async () => {
    await renderLocal();
    act(() => {
      useAppStore.getState().setFileClipboard({
        entries: [
          { name: "r.txt", path: "/srv/r.txt", isDirectory: false, size: 1, modified: "" },
        ],
        operation: "copy",
        sourceMode: "session",
        sourcePath: "/srv",
        terminalSessionId: "ssh-1",
      });
    });
    await clickPaste();
    expect(toastError).toHaveBeenCalledWith(
      "Pasting remote items into a local folder is not supported"
    );
    expect(toastSuccess).not.toHaveBeenCalled();
  });
});
