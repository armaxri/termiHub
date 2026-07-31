/**
 * Tests that the file-browser inline editors (New File, New Folder, and the
 * inline rename) compose from the shared `Input` primitive rather than the
 * retired bespoke `.file-browser__new-dir-input` skin (#1390).
 *
 * Covers: the New File / New Folder toolbar actions open an inline editor that
 * renders via the shared primitive (compact `size="sm"` variant), and the
 * editors preserve their Enter-commits / Escape-cancels behavior.
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

async function click(testId: string) {
  const el = container.querySelector(`[data-testid="${testId}"]`) as HTMLElement;
  await act(async () => {
    el.click();
  });
  await flushAsync();
}

function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("FileBrowser — inline editors use the shared Input primitive (#1390)", () => {
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

  it("renders the New File editor via the shared Input primitive", async () => {
    await renderLocal();
    await click("file-browser-new-file");

    const input = container.querySelector(
      '[data-testid="file-browser-new-file-input"]'
    ) as HTMLInputElement;
    expect(input).toBeTruthy();
    expect(input.classList.contains("ui-input")).toBe(true);
    expect(input.classList.contains("ui-input--sm")).toBe(true);
    expect(input.classList.contains("file-browser__new-dir-input")).toBe(false);
  });

  it("renders the New Folder editor via the shared Input primitive", async () => {
    await renderLocal();
    await click("file-browser-new-folder");

    const input = container.querySelector(
      '[data-testid="file-browser-new-folder-input"]'
    ) as HTMLInputElement;
    expect(input).toBeTruthy();
    expect(input.classList.contains("ui-input")).toBe(true);
    expect(input.classList.contains("ui-input--sm")).toBe(true);
    expect(input.classList.contains("file-browser__new-dir-input")).toBe(false);
  });

  it("commits a new file on Enter and dismisses the editor", async () => {
    await renderLocal();
    await click("file-browser-new-file");

    const input = container.querySelector(
      '[data-testid="file-browser-new-file-input"]'
    ) as HTMLInputElement;
    await act(async () => {
      typeInto(input, "notes.txt");
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await flushAsync();

    expect(mockedInvoke).toHaveBeenCalledWith("local_write_file", {
      path: "/home/notes.txt",
      content: "",
    });
    expect(container.querySelector('[data-testid="file-browser-new-file-input"]')).toBeNull();
  });

  it("cancels the New Folder editor on Escape without creating anything", async () => {
    await renderLocal();
    await click("file-browser-new-folder");

    const input = container.querySelector(
      '[data-testid="file-browser-new-folder-input"]'
    ) as HTMLInputElement;
    await act(async () => {
      typeInto(input, "should-not-apply");
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await flushAsync();

    expect(mockedInvoke).not.toHaveBeenCalledWith("local_mkdir", expect.anything());
    expect(container.querySelector('[data-testid="file-browser-new-folder-input"]')).toBeNull();
  });
});
