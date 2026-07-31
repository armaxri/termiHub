/**
 * Regression tests for FileBrowser VS Code action feedback (#1342).
 *
 * The design-system rule "every action gives feedback" — and the #1342
 * acceptance criterion "no user-facing failure path ends at console.error" —
 * require that the two VS Code-related flows surface a toast instead of only
 * logging to the (user-inaccessible) console:
 *
 *   1. Remote edit-complete (VS Code re-uploads an edited remote file): a
 *      failure used to be a silent `console.error`, hiding a save that never
 *      landed. It must raise a recoverable error toast (and confirm success).
 *   2. "Open in VS Code" context action: a launch failure used to be a silent
 *      `console.error`. It must raise a recoverable error toast.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { flushAsync } from "@/test/flushAsync";
import { createRoot, Root } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store/appStore";
import { FileBrowser } from "./FileBrowser";
import { TooltipProvider } from "@/components/ui";
import type { TerminalTab, LeafPanel } from "@/types/terminal";

const toastSuccess = vi.fn();
const toastError = vi.fn();

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

// Capture the edit-complete callback FileBrowser registers so tests can drive
// it directly (it is fired by the backend when a VS Code re-upload finishes).
const vscodeEvents = vi.hoisted(() => ({
  cb: null as null | ((remotePath: string, success: boolean, err?: string) => void),
}));
vi.mock("@/services/events", () => ({
  onVscodeEditComplete: vi.fn(
    (cb: (remotePath: string, success: boolean, err?: string) => void) => {
      vscodeEvents.cb = cb;
      return Promise.resolve(vi.fn());
    }
  ),
  onLocalDirChanged: vi.fn(() => Promise.resolve(vi.fn())),
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
  useAppStore.setState({ activePanelId: tab.panelId, rootPanel: panel });
}

async function renderLocal() {
  setActiveTab(makeTab({ connectionType: "local", config: { type: "local", config: {} } }));
  useAppStore.setState({
    sidebarView: "files",
    tabCwds: { "tab-1": "/home" },
    vscodeAvailable: true,
  });
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

describe("FileBrowser — VS Code action feedback (#1342)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    toastSuccess.mockClear();
    toastError.mockClear();
    vscodeEvents.cb = null;
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

  // --- Remote edit-complete (re-upload) ---

  it("shows an error toast when a VS Code remote edit fails to re-upload", async () => {
    await renderLocal();
    expect(vscodeEvents.cb).toBeTypeOf("function");

    await act(async () => {
      vscodeEvents.cb!("/home/report.pdf", false, "disk full");
    });
    await flushAsync();

    expect(toastError).toHaveBeenCalledTimes(1);
    expect(String(toastError.mock.calls[0][0])).toContain("report.pdf");
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it("confirms with a success toast when a VS Code remote edit re-uploads", async () => {
    await renderLocal();
    expect(vscodeEvents.cb).toBeTypeOf("function");

    await act(async () => {
      vscodeEvents.cb!("/home/report.pdf", true);
    });
    await flushAsync();

    expect(toastSuccess).toHaveBeenCalledTimes(1);
    expect(String(toastSuccess.mock.calls[0][0])).toContain("report.pdf");
    expect(toastError).not.toHaveBeenCalled();
  });

  // --- "Open in VS Code" context action ---

  it("shows an error toast when opening a file in VS Code fails", async () => {
    // Reject the backend launch so the context action hits its failure path.
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "local_list_dir") return Promise.resolve(entries);
      if (cmd === "vscode_open_local") return Promise.reject(new Error("code not found"));
      return Promise.resolve(undefined);
    });
    await renderLocal();

    await act(async () => {
      row("report.pdf").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    });
    await act(async () => {
      q("context-file-vscode").click();
    });
    await flushAsync();

    expect(toastError).toHaveBeenCalledTimes(1);
    expect(String(toastError.mock.calls[0][0])).toContain("report.pdf");
    expect(toastSuccess).not.toHaveBeenCalled();
  });
});
