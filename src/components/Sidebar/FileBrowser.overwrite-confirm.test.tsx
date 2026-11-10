/**
 * Rename, New File and OS drop never replace an existing entry without asking
 * (#5157): each goes through the same exists-check and "{Verb} and Replace?"
 * dialog as move/paste, and an upload also offers Keep Both / Skip. Driven
 * through the real FileBrowser on the local pane with the Tauri IPC mocked.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { flushAsync } from "@/test/flushAsync";
import { createRoot, Root } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store/appStore";
import { setupFileBrowsersRegion } from "@/test/fileBrowsersRegionTestHarness";
import { setupVirtualListSizing } from "@/test/virtualListSize";
import { FileBrowser } from "./FileBrowser";
import { TooltipProvider } from "@/components/ui";
import type { TerminalTab, LeafPanel } from "@/types/terminal";
import { seedLayoutState } from "@/test/layoutState";

type DragDropHandler = (event: {
  payload: { type: string; paths?: string[]; position?: { x: number; y: number } };
}) => void;
let dragDropHandler: DragDropHandler | null = null;

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onDragDropEvent: vi.fn((handler: DragDropHandler) => {
      dragDropHandler = handler;
      return Promise.resolve(vi.fn());
    }),
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
  return { ...actual, getHomeDir: vi.fn(() => Promise.resolve("/home/test")) };
});

const mockedInvoke = vi.mocked(invoke);

let container: HTMLDivElement;
let root: Root;

const entries = [
  { name: "report.pdf", path: "/home/report.pdf", isDirectory: false, size: 10, modified: "" },
  { name: "notes.txt", path: "/home/notes.txt", isDirectory: false, size: 4, modified: "" },
];

function setActiveTab() {
  const tab: TerminalTab = {
    id: "tab-1",
    sessionId: "sess-1",
    title: "Test Tab",
    connectionType: "local",
    contentType: "terminal",
    config: { type: "local", config: {} },
    panelId: "panel-1",
    isActive: true,
  };
  const panel: LeafPanel = { type: "leaf", id: tab.panelId, tabs: [tab], activeTabId: tab.id };
  seedLayoutState({ activePanelId: tab.panelId, rootPanel: panel });
}

async function renderLocal() {
  setActiveTab();
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

const byTestId = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement;

async function click(el: HTMLElement) {
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

async function submit(input: HTMLInputElement, value: string) {
  await act(async () => {
    typeInto(input, value);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  await flushAsync();
}

async function renameReportTo(newName: string) {
  await click(byTestId("file-row-report.pdf"));
  const list = byTestId("file-browser-list");
  await act(async () => {
    list.dispatchEvent(new KeyboardEvent("keydown", { key: "F2", bubbles: true }));
  });
  await flushAsync();
  await submit(byTestId("file-row-rename-input") as HTMLInputElement, newName);
}

async function createFile(name: string) {
  await click(byTestId("file-browser-new-file"));
  await submit(byTestId("file-browser-new-file-input") as HTMLInputElement, name);
}

async function osDrop(paths: string[]) {
  expect(dragDropHandler).not.toBeNull();
  await act(async () => {
    dragDropHandler!({ payload: { type: "drop", paths, position: { x: 0, y: 0 } } });
  });
  await flushAsync();
}

const dialog = () => byTestId("file-move-conflict-dialog");
const callsTo = (cmd: string) => mockedInvoke.mock.calls.filter(([c]) => c === cmd);

setupFileBrowsersRegion();
setupVirtualListSizing();

describe("FileBrowser — confirm before replacing an existing entry (#5157)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    dragDropHandler = null;
    useAppStore.setState(useAppStore.getInitialState());
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "local_list_dir") return Promise.resolve(entries);
      if (cmd === "local_stat") return Promise.reject(new Error("not found"));
      return Promise.resolve(null);
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  describe("rename", () => {
    it("renames at once (no-clobber) when the name is free", async () => {
      await renderLocal();
      await renameReportTo("fresh.pdf");
      expect(dialog()).toBeNull();
      expect(mockedInvoke).toHaveBeenCalledWith("local_rename", {
        oldPath: "/home/report.pdf",
        newPath: "/home/fresh.pdf",
        overwrite: false,
      });
    });

    it("asks 'Rename and Replace?' for an existing name and replaces on confirm", async () => {
      await renderLocal();
      await renameReportTo("notes.txt");
      expect(callsTo("local_rename")).toHaveLength(0);
      expect(dialog().textContent).toContain("Rename and Replace?");
      expect(dialog().textContent).toContain('"notes.txt" already exists in /home');
      // Rename offers no Keep Both.
      expect(byTestId("file-move-conflict-alternate")).toBeNull();
      await click(byTestId("file-move-conflict-confirm"));
      expect(mockedInvoke).toHaveBeenCalledWith("local_rename", {
        oldPath: "/home/report.pdf",
        newPath: "/home/notes.txt",
        overwrite: true,
      });
    });

    it("renames nothing when the prompt is cancelled", async () => {
      await renderLocal();
      await renameReportTo("notes.txt");
      await click(byTestId("file-move-conflict-cancel"));
      expect(callsTo("local_rename")).toHaveLength(0);
      expect(dialog()).toBeNull();
    });
  });

  describe("New File", () => {
    it("creates exclusively, without a prompt, when the name is free", async () => {
      await renderLocal();
      await createFile("todo.txt");
      expect(dialog()).toBeNull();
      expect(mockedInvoke).toHaveBeenCalledWith("local_write_file", {
        path: "/home/todo.txt",
        content: "",
        exclusive: true,
      });
    });

    it("asks 'Create and Replace?' for an existing name and replaces on confirm", async () => {
      await renderLocal();
      await createFile("notes.txt");
      expect(callsTo("local_write_file")).toHaveLength(0);
      expect(dialog().textContent).toContain("Create and Replace?");
      await click(byTestId("file-move-conflict-confirm"));
      expect(mockedInvoke).toHaveBeenCalledWith("local_write_file", {
        path: "/home/notes.txt",
        content: "",
        exclusive: false,
      });
    });

    it("writes nothing when the prompt is cancelled", async () => {
      await renderLocal();
      await createFile("notes.txt");
      await click(byTestId("file-move-conflict-cancel"));
      expect(callsTo("local_write_file")).toHaveLength(0);
    });
  });

  describe("OS drop (upload)", () => {
    it("copies at once when the name is free", async () => {
      await renderLocal();
      await osDrop(["/tmp/new.txt"]);
      expect(dialog()).toBeNull();
      expect(mockedInvoke).toHaveBeenCalledWith(
        "local_copy_start",
        expect.objectContaining({ srcPath: "/tmp/new.txt", destPath: "/home/new.txt" })
      );
    });

    it("offers Replace / Keep Both / Skip for an existing name", async () => {
      await renderLocal();
      await osDrop(["/tmp/notes.txt"]);
      expect(callsTo("local_copy_start")).toHaveLength(0);
      expect(dialog().textContent).toContain("Upload and Replace?");
      expect(byTestId("file-move-conflict-cancel").textContent).toBe("Skip");
      expect(byTestId("file-move-conflict-alternate").textContent).toBe("Keep Both");
    });

    it("Replace copies over the existing name", async () => {
      await renderLocal();
      await osDrop(["/tmp/notes.txt"]);
      await click(byTestId("file-move-conflict-confirm"));
      expect(mockedInvoke).toHaveBeenCalledWith(
        "local_copy_start",
        expect.objectContaining({ srcPath: "/tmp/notes.txt", destPath: "/home/notes.txt" })
      );
    });

    it("Keep Both copies under a free name", async () => {
      await renderLocal();
      await osDrop(["/tmp/notes.txt"]);
      await click(byTestId("file-move-conflict-alternate"));
      expect(mockedInvoke).toHaveBeenCalledWith(
        "local_copy_start",
        expect.objectContaining({ srcPath: "/tmp/notes.txt", destPath: "/home/notes (1).txt" })
      );
    });

    it("Skip copies nothing, then the next dropped file still lands", async () => {
      await renderLocal();
      await osDrop(["/tmp/notes.txt", "/tmp/other.txt"]);
      // One prompt at a time: the second file waits for the first decision.
      expect(callsTo("local_copy_start")).toHaveLength(0);
      await click(byTestId("file-move-conflict-cancel"));
      await flushAsync();
      const copies = callsTo("local_copy_start");
      expect(copies).toHaveLength(1);
      expect(copies[0][1]).toMatchObject({
        srcPath: "/tmp/other.txt",
        destPath: "/home/other.txt",
      });
    });
  });
});
