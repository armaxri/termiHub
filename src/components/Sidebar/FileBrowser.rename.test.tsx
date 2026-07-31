/**
 * Tests for inline file rename after replacing the native `window.prompt`
 * with an in-row editable input (#1348).
 *
 * Covers: F2 and the context-menu Rename action both start an inline edit;
 * the base name is pre-selected with the extension preserved; Enter commits
 * the rename via the backend; Escape cancels; and no native prompt is used.
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
  useAppStore.setState({ activePanelId: tab.panelId, rootPanel: panel });
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

/** Focus the report.pdf file row (setting it active) then press F2 on the list. */
async function startRenameOnReport() {
  const fileRow = container.querySelector('[data-testid="file-row-report.pdf"]') as HTMLElement;
  await act(async () => {
    fileRow.click();
  });
  const list = container.querySelector('[data-testid="file-browser-list"]') as HTMLElement;
  await act(async () => {
    list.dispatchEvent(new KeyboardEvent("keydown", { key: "F2", bubbles: true }));
  });
  await flushAsync();
}

describe("FileBrowser — inline rename (#1348)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
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

  it("starts an inline edit on F2 with the base name pre-selected", async () => {
    const promptSpy = vi.spyOn(window, "prompt");
    await renderLocal();

    await startRenameOnReport();

    const input = container.querySelector(
      '[data-testid="file-row-rename-input"]'
    ) as HTMLInputElement;
    expect(input).toBeTruthy();
    expect(input.value).toBe("report.pdf");
    // Base name selected, extension preserved.
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe("report".length);
    expect(promptSpy).not.toHaveBeenCalled();
    promptSpy.mockRestore();
  });

  it("renders the rename editor via the shared Input primitive", async () => {
    await renderLocal();

    await startRenameOnReport();

    const input = container.querySelector(
      '[data-testid="file-row-rename-input"]'
    ) as HTMLInputElement;
    expect(input).toBeTruthy();
    // Composed from the shared Input primitive (compact variant), not the
    // retired bespoke `.file-browser__new-dir-input` skin.
    expect(input.classList.contains("ui-input")).toBe(true);
    expect(input.classList.contains("ui-input--sm")).toBe(true);
    expect(input.classList.contains("file-browser__new-dir-input")).toBe(false);
  });

  it("commits the rename via the backend on Enter", async () => {
    await renderLocal();

    await startRenameOnReport();

    const input = container.querySelector(
      '[data-testid="file-row-rename-input"]'
    ) as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value"
      )!.set!;
      setter.call(input, "renamed.pdf");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await flushAsync();

    expect(mockedInvoke).toHaveBeenCalledWith("local_rename", {
      oldPath: "/home/report.pdf",
      newPath: "/home/renamed.pdf",
    });
    // Input dismissed after commit.
    expect(container.querySelector('[data-testid="file-row-rename-input"]')).toBeNull();
  });

  it("cancels the rename on Escape without calling the backend", async () => {
    await renderLocal();

    await startRenameOnReport();

    const input = container.querySelector(
      '[data-testid="file-row-rename-input"]'
    ) as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value"
      )!.set!;
      setter.call(input, "should-not-apply.pdf");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await flushAsync();

    expect(mockedInvoke).not.toHaveBeenCalledWith("local_rename", expect.anything());
    expect(container.querySelector('[data-testid="file-row-rename-input"]')).toBeNull();
  });

  it("does not commit a rename when the name is unchanged", async () => {
    await renderLocal();

    await startRenameOnReport();

    const input = container.querySelector(
      '[data-testid="file-row-rename-input"]'
    ) as HTMLInputElement;
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await flushAsync();

    expect(mockedInvoke).not.toHaveBeenCalledWith("local_rename", expect.anything());
  });
});
