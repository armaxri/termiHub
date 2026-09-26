/**
 * Dual-pane transfer view (PROD-007, #3558): local and remote listings side by
 * side, copy via buttons / F5 / drag between panes (through the transfer engine),
 * a replace confirmation on name clashes, keyboard navigation, and the remote
 * session's transfer queue rows with their controls.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, type ComponentProps } from "react";
import { createRoot, Root } from "react-dom/client";
import type * as DndCore from "@dnd-kit/core";
import type { FileEntry } from "@/types/connection";
import type { TransferEntry } from "@/types/transfer";

const api = vi.hoisted(() => ({
  getHomeDir: vi.fn(),
  localListDir: vi.fn(),
  sessionListFiles: vi.fn(),
  sessionSupportsTransferQueue: vi.fn(),
}));
vi.mock("@/services/api", async () => {
  const actual = await vi.importActual<typeof import("@/services/api")>("@/services/api");
  return { ...actual, ...api };
});

const engine = vi.hoisted(() => ({ copyBetweenPanes: vi.fn() }));
vi.mock("@/services/paneTransfer", () => engine);

const transfers = vi.hoisted(() => ({ queue: {} as Record<string, TransferEntry> }));
vi.mock("@/store/useProjectedTransfers", () => ({
  useProjectedTransfers: () => ({ queue: transfers.queue }),
}));
vi.mock("@/store/useProjectedAgents", () => ({
  useProjectedAgents: () => ({ remoteAgents: [] }),
}));
const controls = vi.hoisted(() => ({
  handlePause: vi.fn(),
  handleResume: vi.fn(),
  handleCancel: vi.fn(),
  handleRetry: vi.fn(),
}));
vi.mock("@/hooks/useTransferControls", () => ({ useTransferControls: () => controls }));
vi.mock("@/utils/frontendLog", () => ({ frontendLog: vi.fn() }));
const bookmarksApi = vi.hoisted(() => ({
  listFileBookmarks: vi.fn(),
  addFileBookmark: vi.fn(),
  renameFileBookmark: vi.fn(),
  removeFileBookmark: vi.fn(),
  onFileBookmarksRekeyed: vi.fn(() => Promise.resolve(() => {})),
}));
vi.mock("@/services/fileBookmarksApi", () => bookmarksApi);

let dndProps: ComponentProps<typeof DndCore.DndContext> | null = null;
vi.mock("@dnd-kit/core", async () => {
  const actual = await vi.importActual<typeof DndCore>("@dnd-kit/core");
  return {
    ...actual,
    DndContext: (props: ComponentProps<typeof actual.DndContext>) => {
      dndProps = props;
      return <actual.DndContext {...props} />;
    },
  };
});

import { TooltipProvider } from "@/components/ui";
import { useAppStore } from "@/store/appStore";
import { useFileBookmarksStore } from "@/store/fileBookmarksStore";
import type { FileBookmark } from "@/types/fileBookmark";
import type { TabContent, TransferViewMeta } from "@/types/terminal";
import { TransferView } from "./TransferView";

let container: HTMLDivElement;
let root: Root;

function entry(path: string, isDirectory = false): FileEntry {
  return {
    name: path.split("/").pop()!,
    path,
    isDirectory,
    size: 10,
    modified: "",
    permissions: null,
    writable: null,
  };
}

const LOCAL: Record<string, FileEntry[]> = {
  "/home/me": [entry("/home/me/docs", true), entry("/home/me/a.txt"), entry("/home/me/b.txt")],
  "/home/me/docs": [entry("/home/me/docs/inner.md")],
  "/home": [entry("/home/me", true)],
};
const REMOTE: Record<string, FileEntry[]> = {
  "~": [entry("/srv/app/a.txt"), entry("/srv/app/logs", true)],
  "/srv/app": [entry("/srv/app/a.txt"), entry("/srv/app/logs", true)],
};

function q(testId: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testId}"]`);
}

async function flush() {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function render(meta: TransferViewMeta) {
  await act(async () => {
    root.render(
      <TooltipProvider>
        <TransferView meta={meta} isVisible={true} />
      </TooltipProvider>
    );
  });
  await flush();
}

function key(el: HTMLElement, k: string, init: KeyboardEventInit = {}) {
  act(() => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, ...init }));
  });
}

async function click(testId: string, init: MouseEventInit = {}) {
  const el = q(testId) as HTMLElement;
  expect(el).not.toBeNull();
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, ...init }));
  });
  await flush();
}

const sshTab = {
  id: "tab-ssh",
  sessionId: "s1",
  title: "prod",
  connectionType: "ssh",
  contentType: "terminal",
  config: { type: "ssh", config: { host: "prod" } },
} as TabContent;

beforeEach(() => {
  vi.clearAllMocks();
  dndProps = null;
  transfers.queue = {};
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  api.getHomeDir.mockResolvedValue("/home/me");
  api.localListDir.mockImplementation(async (p: string) => LOCAL[p] ?? []);
  api.sessionListFiles.mockImplementation(async (_s: string, p: string) => REMOTE[p] ?? []);
  api.sessionSupportsTransferQueue.mockResolvedValue(true);
  engine.copyBetweenPanes.mockResolvedValue(true);
  bookmarksApi.listFileBookmarks.mockResolvedValue([]);
  useFileBookmarksStore.setState({ bookmarks: [], loaded: true });
  useAppStore.setState({
    tabContent: { [sshTab.id]: sshTab },
    connectionTypes: [
      { typeId: "ssh", capabilities: { fileBrowser: true } },
    ] as unknown as ReturnType<typeof useAppStore.getState>["connectionTypes"],
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

describe("TransferView", () => {
  it("lists the local home and the remote session side by side", async () => {
    await render({ remoteTabId: "tab-ssh" });
    expect(q("transfer-pane-local-row-a.txt")).not.toBeNull();
    expect(api.sessionListFiles).toHaveBeenCalledWith("s1", "~");
    // The remote `~` resolves to the listed directory.
    expect((q("transfer-pane-remote-path") as HTMLInputElement).value).toBe("/srv/app");
    expect(q("transfer-pane-remote-row-logs")).not.toBeNull();
  });

  it("asks for a remote when none is attached", async () => {
    await render({ remoteTabId: null });
    expect(q("transfer-view-no-remote")?.textContent).toContain("Choose a remote");
    expect(api.sessionListFiles).not.toHaveBeenCalled();
    expect((q("transfer-view-copy-to-remote") as HTMLButtonElement).disabled).toBe(true);
  });

  it("copies the local selection to the remote folder", async () => {
    await render({ remoteTabId: "tab-ssh" });
    await click("transfer-pane-local-row-b.txt");
    await click("transfer-view-copy-to-remote");
    expect(engine.copyBetweenPanes).toHaveBeenCalledWith({
      from: "local",
      entries: [LOCAL["/home/me"][2]],
      destDir: "/srv/app",
      remote: { sessionId: "s1", queueCapable: true },
    });
    // The destination is re-listed once the copy finished.
    expect(api.sessionListFiles).toHaveBeenLastCalledWith("s1", "/srv/app");
  });

  it("confirms before replacing an item that exists at the destination", async () => {
    await render({ remoteTabId: "tab-ssh" });
    await click("transfer-pane-local-row-a.txt");
    await click("transfer-view-copy-to-remote");
    expect(engine.copyBetweenPanes).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("a.txt already exists in /srv/app");
    await click("transfer-view-replace-confirm");
    expect(engine.copyBetweenPanes).toHaveBeenCalledTimes(1);
  });

  it("navigates and copies from the keyboard", async () => {
    await render({ remoteTabId: "tab-ssh" });
    const list = q("transfer-pane-local-list") as HTMLElement;
    list.focus();
    // Enter on the first row (the docs folder) opens it.
    key(list, "Enter");
    await flush();
    expect(api.localListDir).toHaveBeenLastCalledWith("/home/me/docs");
    expect(q("transfer-pane-local-row-inner.md")).not.toBeNull();
    // Backspace goes back up.
    key(list, "Backspace");
    await flush();
    expect(api.localListDir).toHaveBeenLastCalledWith("/home/me");
    // ArrowDown ×2 selects b.txt; F5 copies it to the remote pane.
    key(list, "ArrowDown");
    key(list, "ArrowDown");
    const option = q("transfer-pane-local-row-b.txt") as HTMLElement;
    expect(option.getAttribute("aria-selected")).toBe("true");
    expect(list.getAttribute("aria-activedescendant")).toBe(option.id);
    key(list, "F5");
    await flush();
    expect(engine.copyBetweenPanes).toHaveBeenCalledWith(
      expect.objectContaining({ from: "local", entries: [LOCAL["/home/me"][2]] })
    );
  });

  it("copies rows dropped onto the other pane", async () => {
    await render({ remoteTabId: "tab-ssh" });
    const dragged = [REMOTE["/srv/app"][1]];
    await act(async () => {
      dndProps?.onDragEnd?.({
        active: { data: { current: { side: "remote", entries: dragged } } },
        over: { data: { current: { side: "local" } } },
      } as unknown as DndCore.DragEndEvent);
    });
    await flush();
    expect(engine.copyBetweenPanes).toHaveBeenCalledWith(
      expect.objectContaining({ from: "remote", entries: dragged, destDir: "/home/me" })
    );
  });

  it("ignores a drop back onto the pane the rows came from", async () => {
    await render({ remoteTabId: "tab-ssh" });
    await act(async () => {
      dndProps?.onDragEnd?.({
        active: { data: { current: { side: "local", entries: [LOCAL["/home/me"][1]] } } },
        over: { data: { current: { side: "local" } } },
      } as unknown as DndCore.DragEndEvent);
    });
    expect(engine.copyBetweenPanes).not.toHaveBeenCalled();
  });

  it("shows the remote session's transfers with cancel", async () => {
    transfers.queue = {
      t1: {
        id: "t1",
        sessionId: "s1",
        direction: "upload",
        name: "big.iso",
        state: "active",
        transferred: 5,
        totalBytes: 10,
        percent: 50,
        speedBytesPerSec: null,
        etaSeconds: null,
        updatedAt: 0,
      },
      t2: {
        id: "t2",
        sessionId: "other",
        direction: "upload",
        name: "elsewhere",
        state: "active",
        transferred: 0,
        totalBytes: null,
        percent: null,
        speedBytesPerSec: null,
        etaSeconds: null,
        updatedAt: 0,
      },
    };
    await render({ remoteTabId: "tab-ssh" });
    const footer = q("transfer-view-transfers") as HTMLElement;
    expect(footer.textContent).toContain("big.iso");
    expect(footer.textContent).not.toContain("elsewhere");
    const cancel = footer.querySelector('[aria-label*="Cancel"]') as HTMLButtonElement;
    expect(cancel).not.toBeNull();
    await act(async () => {
      cancel.click();
    });
    expect(controls.handleCancel).toHaveBeenCalledWith("t1");
  });

  describe("bookmarks (#3562)", () => {
    const mark = (id: string, scope: string, path: string): FileBookmark => ({
      id,
      scope,
      path,
      name: id,
      createdAt: "2026-09-26T00:00:00Z",
    });

    async function openBookmarks(side: "local" | "remote") {
      const trigger = q(`transfer-pane-${side}-bookmarks`) as HTMLButtonElement;
      expect(trigger).not.toBeNull();
      await act(async () => {
        trigger.focus();
        trigger.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true })
        );
      });
      for (let i = 0; i < 20 && !q("file-bookmarks-menu"); i++) await flush();
      expect(q("file-bookmarks-menu")).not.toBeNull();
    }

    async function pick(testId: string) {
      const el = q(testId) as HTMLElement;
      expect(el).not.toBeNull();
      await act(async () => {
        el.click();
      });
      await flush();
    }

    beforeEach(() => {
      useAppStore.setState({ tabContent: { [sshTab.id]: { ...sshTab, connectionId: "c1" } } });
      useFileBookmarksStore.setState({
        bookmarks: [
          mark("docs", "local", "/home/me/docs"),
          mark("logs", "connection:c1", "/srv/app/logs"),
          mark("other", "connection:c2", "/etc"),
        ],
        loaded: true,
      });
    });

    it("the local pane lists the local bookmarks and jumps to one", async () => {
      await render({ remoteTabId: "tab-ssh" });
      await openBookmarks("local");
      expect(q("file-bookmark-item-logs")).toBeNull();
      await pick("file-bookmark-item-docs");
      expect(api.localListDir).toHaveBeenLastCalledWith("/home/me/docs");
      expect((q("transfer-pane-local-path") as HTMLInputElement).value).toBe("/home/me/docs");
    });

    it("the remote pane lists the remote connection's bookmarks and jumps to one", async () => {
      await render({ remoteTabId: "tab-ssh" });
      await openBookmarks("remote");
      expect(q("file-bookmark-item-docs")).toBeNull();
      expect(q("file-bookmark-item-other")).toBeNull();
      await pick("file-bookmark-item-logs");
      expect(api.sessionListFiles).toHaveBeenLastCalledWith("s1", "/srv/app/logs");
    });

    it("bookmarks the remote folder in the remote connection's scope", async () => {
      bookmarksApi.addFileBookmark.mockResolvedValue(mark("new", "connection:c1", "/srv/app"));
      useFileBookmarksStore.setState({ bookmarks: [], loaded: true });
      await render({ remoteTabId: "tab-ssh" });
      await openBookmarks("remote");
      await pick("file-bookmarks-add");
      expect(bookmarksApi.addFileBookmark).toHaveBeenCalledWith(
        "connection:c1",
        "/srv/app",
        undefined
      );
    });

    it("hides the remote pane's bookmarks until a remote is chosen", async () => {
      await render({ remoteTabId: null });
      expect(q("transfer-pane-remote-bookmarks")).toBeNull();
      expect(q("transfer-pane-local-bookmarks")).not.toBeNull();
    });
  });
});
