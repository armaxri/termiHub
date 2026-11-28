/**
 * The Upload button uploads several picked files at once (#6165): each one is
 * its own transfer, through the same name-conflict question as a drop (#5157),
 * decided before the next file starts. Driven through the real FileBrowser on a
 * session pane with the Tauri IPC mocked.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { flushAsync } from "@/test/flushAsync";
import { createRoot, Root } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store/appStore";
import { seedFileBrowsers, setupFileBrowsersRegion } from "@/test/fileBrowsersRegionTestHarness";
import { setupVirtualListSizing } from "@/test/virtualListSize";
import { FileBrowser } from "./FileBrowser";
import { TooltipProvider } from "@/components/ui";
import type { TerminalTab, LeafPanel } from "@/types/terminal";
import { seedLayoutState } from "@/test/layoutState";
import { findFileBrowserAction } from "@/test/fileBrowserMenu";

const picked = vi.hoisted(() => ({ paths: [] as string[] }));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(() => Promise.resolve(picked.paths)),
  save: vi.fn(() => Promise.resolve(null)),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ onDragDropEvent: vi.fn(() => Promise.resolve(vi.fn())) }),
}));

vi.mock("@/themes", () => ({
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(() => vi.fn()),
}));

vi.mock("@/services/events", () => ({
  onVscodeEditComplete: vi.fn(() => Promise.resolve(vi.fn())),
  onLocalDirChanged: vi.fn(() => Promise.resolve(vi.fn())),
}));

const mockedInvoke = vi.mocked(invoke);

const remote = [
  { name: "notes.txt", path: "/srv/notes.txt", isDirectory: false, size: 4, modified: "" },
];

let container: HTMLDivElement;
let root: Root;

async function renderSession() {
  const tab: TerminalTab = {
    id: "tab-1",
    sessionId: "ssh-1",
    title: "Box",
    connectionType: "ssh",
    contentType: "terminal",
    config: { type: "ssh", config: { host: "box", port: 22, username: "me" } },
    panelId: "panel-1",
    isActive: true,
  };
  const panel: LeafPanel = { type: "leaf", id: tab.panelId, tabs: [tab], activeTabId: tab.id };
  seedLayoutState({ activePanelId: tab.panelId, rootPanel: panel });
  useAppStore.setState({
    sidebarView: "files",
    sessionFileBrowserId: "ssh-1",
    connectionTypes: [
      {
        typeId: "ssh",
        displayName: "SSH",
        icon: "folder",
        schema: { groups: [] },
        capabilities: { monitoring: false, fileBrowser: true, resize: false, persistent: false },
      },
    ],
  } as never);
  seedFileBrowsers({
    mode: "session",
    session: { path: "/srv", entries: remote, loading: false, error: null },
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

const byTestId = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement;
const uploads = () =>
  mockedInvoke.mock.calls
    .filter(([cmd]) => cmd === "session_upload_local_file")
    .map(([, args]) => args as { localPath: string; remotePath: string });

async function click(el: HTMLElement) {
  await act(async () => {
    el.click();
  });
  await flushAsync();
}

setupFileBrowsersRegion();
setupVirtualListSizing();

describe("FileBrowser — Upload several files at once (#6165)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "session_list_files") return Promise.resolve(remote);
      if (cmd === "local_stat") return Promise.reject(new Error("not found"));
      return Promise.resolve(null);
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("uploads every picked file as its own transfer", async () => {
    picked.paths = ["/tmp/a.txt", "/tmp/b.txt"];
    await renderSession();
    await click((await findFileBrowserAction("file-browser-upload"))!);
    await flushAsync();
    expect(uploads()).toEqual([
      { sessionId: "ssh-1", localPath: "/tmp/a.txt", remotePath: "/srv/a.txt" },
      { sessionId: "ssh-1", localPath: "/tmp/b.txt", remotePath: "/srv/b.txt" },
    ]);
  });

  it("asks about the one name that exists, then uploads the next", async () => {
    picked.paths = ["/tmp/notes.txt", "/tmp/other.txt"];
    await renderSession();
    await click((await findFileBrowserAction("file-browser-upload"))!);
    // One question at a time: nothing uploads while it waits.
    expect(byTestId("file-move-conflict-dialog").textContent).toContain("Upload and replace?");
    expect(uploads()).toEqual([]);
    await click(byTestId("file-move-conflict-cancel")); // Skip
    await flushAsync();
    expect(uploads()).toEqual([
      { sessionId: "ssh-1", localPath: "/tmp/other.txt", remotePath: "/srv/other.txt" },
    ]);
  });
});
