/**
 * File-browser bookmarks menu + manage dialog (PROD-007, #3558): add the
 * current folder, jump to a bookmark, rename and remove — all scoped to the
 * current connection and routed through the backend-owned store.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import type { FileBookmark } from "@/types/fileBookmark";

const api = vi.hoisted(() => ({
  listFileBookmarks: vi.fn(),
  addFileBookmark: vi.fn(),
  renameFileBookmark: vi.fn(),
  removeFileBookmark: vi.fn(),
}));
vi.mock("@/services/fileBookmarksApi", () => api);
vi.mock("@/utils/frontendLog", () => ({ frontendLog: vi.fn() }));

const toastSuccess = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());
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

import { TooltipProvider } from "@/components/ui";
import { useFileBookmarksStore } from "@/store/fileBookmarksStore";
import { FileBookmarksMenu } from "./FileBookmarksMenu";

let container: HTMLDivElement;
let root: Root;

function bookmark(id: string, scope: string, path: string, name = id): FileBookmark {
  return { id, scope, path, name, createdAt: "2026-09-26T00:00:00Z" };
}

function q(testId: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testId}"]`);
}

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await nextFrame();
  });
}

function render(scope: string | null, currentPath = "/srv/app", onNavigate = vi.fn()) {
  act(() => {
    root.render(
      <TooltipProvider>
        <FileBookmarksMenu scope={scope} currentPath={currentPath} onNavigate={onNavigate} />
      </TooltipProvider>
    );
  });
  return onNavigate;
}

async function openMenu() {
  const trigger = q("file-browser-bookmarks") as HTMLButtonElement;
  await act(async () => {
    trigger.focus();
    trigger.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true })
    );
  });
  for (let i = 0; i < 20 && !q("file-bookmarks-menu"); i++) await flush();
}

async function select(testId: string) {
  const el = q(testId) as HTMLElement;
  expect(el).not.toBeNull();
  await act(async () => {
    el.click();
  });
  await flush();
}

function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  api.listFileBookmarks.mockResolvedValue([]);
  useFileBookmarksStore.setState({
    bookmarks: [
      bookmark("a", "connection:c1", "/var/log", "logs"),
      bookmark("b", "connection:c2", "/etc"),
    ],
    loaded: true,
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

describe("FileBookmarksMenu", () => {
  it("lists only the current connection's bookmarks and jumps to one", async () => {
    const onNavigate = render("connection:c1");
    await openMenu();
    expect(q("file-bookmark-item-a")?.textContent).toContain("logs");
    expect(q("file-bookmark-item-b")).toBeNull();
    await select("file-bookmark-item-a");
    expect(onNavigate).toHaveBeenCalledWith("/var/log");
  });

  it("bookmarks the current folder in the current scope", async () => {
    api.addFileBookmark.mockResolvedValue(bookmark("n", "connection:c1", "/srv/app", "app"));
    render("connection:c1", "/srv/app");
    await openMenu();
    await select("file-bookmarks-add");
    expect(api.addFileBookmark).toHaveBeenCalledWith("connection:c1", "/srv/app", undefined);
    expect(toastSuccess).toHaveBeenCalled();
    expect(useFileBookmarksStore.getState().bookmarks.some((b) => b.id === "n")).toBe(true);
  });

  it("offers removing the bookmark when the current folder is bookmarked", async () => {
    api.removeFileBookmark.mockResolvedValue(undefined);
    render("connection:c1", "/var/log");
    await openMenu();
    expect(q("file-bookmarks-add")).toBeNull();
    expect((q("file-browser-bookmarks") as HTMLButtonElement).getAttribute("aria-pressed")).toBe(
      "true"
    );
    await select("file-bookmarks-remove-current");
    expect(api.removeFileBookmark).toHaveBeenCalledWith("a");
  });

  it("reports a failed add instead of failing silently", async () => {
    api.addFileBookmark.mockRejectedValue(new Error("limit reached"));
    render("connection:c1", "/srv/app");
    await openMenu();
    await select("file-bookmarks-add");
    expect(toastError).toHaveBeenCalled();
  });

  it("explains why bookmarks are unavailable without a scope", async () => {
    render(null);
    await openMenu();
    expect(q("file-bookmarks-unavailable")).not.toBeNull();
    expect(q("file-bookmarks-add")).toBeNull();
  });

  it("loads bookmarks from the backend on first use", async () => {
    useFileBookmarksStore.setState({ bookmarks: [], loaded: false });
    api.listFileBookmarks.mockResolvedValue([bookmark("x", "local", "/tmp")]);
    render("local");
    await flush();
    expect(api.listFileBookmarks).toHaveBeenCalled();
    await openMenu();
    expect(q("file-bookmark-item-x")).not.toBeNull();
  });

  describe("manage dialog", () => {
    async function openDialog(scope = "connection:c1") {
      const onNavigate = render(scope);
      await openMenu();
      await select("file-bookmarks-manage");
      expect(q("file-bookmarks-dialog")).not.toBeNull();
      return onNavigate;
    }

    it("renames a bookmark inline with Enter", async () => {
      api.renameFileBookmark.mockResolvedValue(
        bookmark("a", "connection:c1", "/var/log", "System logs")
      );
      await openDialog();
      await select("file-bookmark-rename-a");
      const input = q("file-bookmark-rename-input") as HTMLInputElement;
      expect(document.activeElement).toBe(input);
      typeInto(input, "System logs");
      await act(async () => {
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      });
      await flush();
      expect(api.renameFileBookmark).toHaveBeenCalledWith("a", "System logs");
      expect(q("file-bookmark-row-a")?.textContent).toContain("System logs");
    });

    it("cancels a rename with Escape without closing the dialog", async () => {
      await openDialog();
      await select("file-bookmark-rename-a");
      const input = q("file-bookmark-rename-input") as HTMLInputElement;
      await act(async () => {
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      });
      await flush();
      expect(api.renameFileBookmark).not.toHaveBeenCalled();
      expect(q("file-bookmark-rename-input")).toBeNull();
      expect(q("file-bookmarks-dialog")).not.toBeNull();
    });

    it("removes a bookmark", async () => {
      api.removeFileBookmark.mockResolvedValue(undefined);
      await openDialog();
      await select("file-bookmark-remove-a");
      expect(api.removeFileBookmark).toHaveBeenCalledWith("a");
      expect(q("file-bookmark-row-a")).toBeNull();
    });

    it("opens a bookmark and closes the dialog", async () => {
      const onNavigate = await openDialog();
      await select("file-bookmark-open-a");
      expect(onNavigate).toHaveBeenCalledWith("/var/log");
      expect(q("file-bookmarks-dialog")).toBeNull();
    });
  });
});
